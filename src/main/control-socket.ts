import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { dirname } from 'node:path'

import type { ConfigSnapshot } from '@core/config-store'
import type { NotificationStore } from '@core/notifications'
import type { PtyManager } from '@core/pty-manager'
import {
  CONTROL_EVENT_BUFFER,
  CONTROL_MAX_FRAME_BYTES,
  CONTROL_PROTOCOL_VERSION,
  EV,
  M,
  RENDERER_METHODS,
  resolveHandle,
  type ControlEndpoint,
  type ControlErrorCode,
  type ControlEventFrame,
  type ControlRequest
} from '@shared/protocol'
import type { Notification, SessionMeta } from '@shared/types'

/**
 * 제어 소켓 서버 (P20).
 *
 * 앱 바깥에서 들어오는 명령을 받는다. 세션에 관한 것은 여기서 바로 답하고,
 * 워크스페이스·pane·알림처럼 렌더러가 들고 있는 것은 `bridge`로 넘긴다(P20-7).
 */

export interface ControlBridge {
  /** 렌더러에 요청을 넘기고 답을 기다린다. 창이 없으면 거부한다 */
  call(method: string, params: Record<string, unknown>): Promise<unknown>
}

export interface ControlHost {
  manager: PtyManager
  bridge: ControlBridge
  /** 알림함. 목록과 읽음 처리는 main이 답한다. P21 */
  inbox: NotificationStore
  /** 창을 앞으로 가져온다 — `cvmux open`과 `app.focus`가 쓴다 */
  showWindow(): void
  /** 설정 파일을 다시 읽는다. P22-6 */
  reloadConfig(): ConfigSnapshot
  version: string
}

class ControlError extends Error {
  constructor(
    readonly code: ControlErrorCode,
    message: string
  ) {
    super(message)
  }
}

/** 파이프 이름은 설치마다 다르다 — 한 머신에 여러 사용자가 있어도 겹치지 않는다. P20-2 */
export function pipePathFor(userDataDir: string): string {
  const digest = createHash('sha1').update(userDataDir.toLowerCase()).digest('hex').slice(0, 12)
  return `\\\\.\\pipe\\cvmux-${digest}`
}

interface Client {
  socket: Socket
  authenticated: boolean
  buffer: string
  /** events.stream 구독 중이면 필터가 담긴다 */
  subscription: { names: Set<string> | null; pending: number } | null
}

export class ControlSocketServer {
  private server: Server | null = null
  private readonly clients = new Set<Client>()
  private readonly password = randomBytes(24).toString('hex')
  private readonly events: ControlEventFrame[] = []
  private seq = 0
  private nextId = 1

  constructor(
    private readonly host: ControlHost,
    private readonly pipePath: string,
    private readonly endpointFile: string
  ) {}

  /** 세션 환경에 심을 값 — 세션 안의 프로세스는 이것만으로 앱을 찾는다. P20-3 */
  get env(): Record<string, string> {
    return { CVMUX_SOCKET_PATH: this.pipePath, CVMUX_SOCKET_PASSWORD: this.password }
  }

  start(): void {
    const server = createServer((socket) => this.accept(socket))
    server.on('error', (error) => {
      console.error('[cvmux] 제어 소켓을 열지 못했습니다:', error)
    })
    server.listen(this.pipePath, () => {
      this.writeEndpoint()
      console.log(`[cvmux] 제어 소켓: ${this.pipePath}`)
    })
    this.server = server
    this.wireEvents()
  }

  stop(): void {
    for (const client of this.clients) client.socket.destroy()
    this.clients.clear()
    this.server?.close()
    this.server = null
    try {
      rmSync(this.endpointFile, { force: true })
    } catch {
      // 지우지 못해도 다음 실행이 덮어쓴다
    }
  }

  private writeEndpoint(): void {
    const endpoint: ControlEndpoint = {
      version: CONTROL_PROTOCOL_VERSION,
      path: this.pipePath,
      password: this.password,
      pid: process.pid,
      startedAt: Date.now()
    }
    try {
      mkdirSync(dirname(this.endpointFile), { recursive: true })
      writeFileSync(this.endpointFile, JSON.stringify(endpoint, null, 2), 'utf8')
    } catch (error) {
      console.error('[cvmux] 제어 소켓 정보를 남기지 못했습니다:', error)
    }
  }

  // ── 이벤트 ───────────────────────────────────────────────────

  private wireEvents(): void {
    const m = this.host.manager
    m.on('created', (meta) => this.emit(EV.SESSION_CREATED, sessionPayload(meta)))
    m.on('closed', (id) => this.emit(EV.SESSION_CLOSED, { session_id: id }))
    m.on('exit', (info) =>
      this.emit(EV.SESSION_EXITED, {
        session_id: info.id,
        exit_code: info.exitCode,
        exit_signal: info.exitSignal
      })
    )
    m.on('notify', (id, text) => this.emit(EV.SESSION_NOTIFY, { session_id: id, text }))

    // 상태 변화는 잦다 — 실제로 status가 바뀐 순간만 흘린다
    const lastStatus = new Map<string, string>()
    m.on('meta', (meta) => {
      if (lastStatus.get(meta.id) === meta.status) return
      lastStatus.set(meta.id, meta.status)
      this.emit(EV.SESSION_STATUS, sessionPayload(meta))
    })
  }

  /** 이벤트를 버퍼에 쌓고 구독자에게 흘린다. 렌더러도 이 길로 이벤트를 넣는다 */
  emit(name: string, payload: unknown): void {
    const frame: ControlEventFrame = {
      type: 'event',
      seq: ++this.seq,
      name,
      at: Date.now(),
      payload
    }
    this.events.push(frame)
    if (this.events.length > CONTROL_EVENT_BUFFER) this.events.shift()

    const line = `${JSON.stringify(frame)}\n`
    for (const client of this.clients) {
      const sub = client.subscription
      if (!sub) continue
      if (sub.names !== null && !sub.names.has(name)) continue
      client.socket.write(line)
    }
  }

  // ── 연결 처리 ────────────────────────────────────────────────

  private accept(socket: Socket): void {
    const client: Client = { socket, authenticated: false, buffer: '', subscription: null }
    this.clients.add(client)

    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => this.feed(client, chunk))
    socket.on('error', () => this.clients.delete(client))
    socket.on('close', () => this.clients.delete(client))
  }

  private feed(client: Client, chunk: string): void {
    client.buffer += chunk
    if (client.buffer.length > CONTROL_MAX_FRAME_BYTES) {
      // 줄바꿈 없이 한 프레임 한도를 넘겼다 — 프로토콜을 지키지 않는 상대다. P20-6
      client.socket.destroy()
      this.clients.delete(client)
      return
    }

    let cut = client.buffer.indexOf('\n')
    while (cut !== -1) {
      const line = client.buffer.slice(0, cut).trim()
      client.buffer = client.buffer.slice(cut + 1)
      if (line) void this.handleLine(client, line)
      cut = client.buffer.indexOf('\n')
    }
  }

  private async handleLine(client: Client, line: string): Promise<void> {
    let request: ControlRequest
    try {
      request = JSON.parse(line) as ControlRequest
    } catch {
      this.fail(client, 0, 'invalid_params', 'JSON을 해석할 수 없습니다')
      return
    }

    const id = typeof request.id === 'number' ? request.id : 0
    const auth = (request as { auth?: unknown }).auth

    if (!client.authenticated) {
      if (typeof auth !== 'string' || auth !== this.password) {
        this.fail(client, id, 'unauthorized', '소켓 비밀번호가 필요합니다')
        return
      }
      client.authenticated = true
    }

    if (typeof request.method !== 'string') {
      this.fail(client, id, 'invalid_params', 'method가 없습니다')
      return
    }

    try {
      const result = await this.dispatch(client, request.method, request.params ?? {}, id)
      // events.stream은 응답 대신 스트림으로 이어진다 — dispatch가 직접 답했다
      if (result === STREAMING) return
      client.socket.write(`${JSON.stringify({ id, ok: true, result })}\n`)
    } catch (error) {
      const code = error instanceof ControlError ? error.code : 'internal_error'
      const message = error instanceof Error ? error.message : String(error)
      this.fail(client, id, code, message)
    }
  }

  private fail(client: Client, id: number, code: ControlErrorCode, message: string): void {
    client.socket.write(`${JSON.stringify({ id, ok: false, error: { code, message } })}\n`)
  }

  // ── 메서드 ───────────────────────────────────────────────────

  private async dispatch(
    client: Client,
    method: string,
    params: Record<string, unknown>,
    id: number
  ): Promise<unknown> {
    // 렌더러가 들고 있는 상태는 렌더러에게 묻는다. P20-7
    if (RENDERER_METHODS.has(method)) return this.host.bridge.call(method, params)

    switch (method) {
      case M.PING:
        return { pong: true, pid: process.pid, version: this.host.version }

      case M.CAPABILITIES:
        return {
          version: this.host.version,
          protocol: CONTROL_PROTOCOL_VERSION,
          platform: process.platform,
          methods: Object.values(M),
          events: Object.values(EV)
        }

      case M.IDENTIFY:
        return {
          pid: process.pid,
          version: this.host.version,
          pipe: this.pipePath,
          sessions: this.host.manager.list().length
        }

      case M.SESSION_LIST:
        return { sessions: this.host.manager.list().map(sessionPayload) }

      case M.SESSION_READ: {
        const session = this.session(params.session)
        const snapshot = this.host.manager.snapshot(session.id)
        if (!snapshot) throw new ControlError('not_found', '세션 화면을 읽을 수 없습니다')
        const lines = Number(params.lines ?? 0)
        const text = stripAnsi(snapshot.replay)
        if (!Number.isFinite(lines) || lines <= 0) return { session_id: session.id, text }
        /*
         * 끝의 빈 줄은 세지 않는다.
         *
         * 화면은 대개 줄바꿈으로 끝나고, `Clear-Host`를 지나온 버퍼에는 공백만
         * 남은 줄이 여럿 붙는다. 그것을 한 줄로 세면 `--lines 3`이 빈 줄 셋을
         * 돌려준다 — 세어 달라고 한 것은 내용이다.
         */
        const kept = text.replace(/(?:[ \t\r]*\n)+[ \t\r]*$/, '').split('\n')
        return { session_id: session.id, text: kept.slice(-lines).join('\n') }
      }

      case M.SESSION_SEND: {
        const session = this.session(params.session)
        const text = String(params.text ?? '')
        const withNewline = params.enter === true ? `${text}\r` : text
        this.host.manager.write(session.id, withNewline)
        return { session_id: session.id, bytes: Buffer.byteLength(withNewline) }
      }

      case M.SESSION_SEND_KEY: {
        const session = this.session(params.session)
        const key = String(params.key ?? '')
        const sequence = keySequence(key)
        if (sequence === null) throw new ControlError('invalid_params', `모르는 키: ${key}`)
        this.host.manager.write(session.id, sequence)
        return { session_id: session.id, key }
      }

      case M.SESSION_CLOSE: {
        const session = this.session(params.session)
        return { closed: this.host.manager.close(session.id) }
      }

      case M.SESSION_RESTART: {
        const session = this.session(params.session)
        return { restarted: this.host.manager.restart(session.id) }
      }

      case M.SESSION_SET_TITLE: {
        const session = this.session(params.session)
        const title = params.title === null ? null : String(params.title ?? '')
        return { ok: this.host.manager.setTitle(session.id, title) }
      }

      case M.SESSION_NOTIFY: {
        const session = this.session(params.session)
        const title = params.title === undefined ? null : String(params.title)
        const body = String(params.text ?? params.body ?? '')
        const text = title ? `${title}: ${body}` : body
        this.host.manager.notify(session.id, text)
        return { session_id: session.id, text }
      }

      // ── 알림함 (P21) ─────────────────────────────────────────
      case M.NOTIFICATION_LIST: {
        const items = this.host.inbox.list()
        const unreadOnly = params.unread === true
        return {
          unread_count: this.host.inbox.unreadCount(),
          notifications: (unreadOnly ? items.filter((n) => !n.read) : items).map(notePayload)
        }
      }

      case M.NOTIFICATION_MARK_READ: {
        const ref = params.notification ?? params.session
        if (ref === undefined) {
          this.host.inbox.markAllRead()
          for (const session of this.host.manager.list()) this.host.manager.markRead(session.id)
          return { marked: true, scope: 'all' }
        }
        const note = this.host.inbox.find(String(ref))
        if (note) return { marked: this.host.inbox.markRead(note.id), id: note.id }
        // 알림 id가 아니면 세션을 가리킨 것으로 본다 — 그 세션의 알림을 모두 읽는다
        const session = this.session(ref)
        this.host.inbox.markSessionRead(session.id)
        this.host.manager.markRead(session.id)
        return { marked: true, session_id: session.id }
      }

      case M.NOTIFICATION_DISMISS: {
        const ref = params.notification
        if (ref === undefined) throw new ControlError('invalid_params', '알림 id가 필요합니다')
        return { dismissed: this.host.inbox.dismiss(String(ref)) }
      }

      case M.NOTIFICATION_CLEAR:
        if (params.all === true) this.host.inbox.clear()
        else this.host.inbox.dismissRead()
        return { cleared: true, remaining: this.host.inbox.list().length }

      /*
       * 가장 최근 읽지 않은 알림으로 (P21-4).
       *
       * 어느 알림인지는 main이 알고, 그 세션이 어느 워크스페이스에 있는지는
       * 렌더러가 안다. 그래서 여기서 대상을 정한 뒤 렌더러에게 넘긴다.
       */
      case M.NOTIFICATION_JUMP_UNREAD: {
        const latest = this.host.inbox.latestUnread()
        if (!latest) throw new ControlError('not_found', '읽지 않은 알림이 없습니다')
        const result = await this.host.bridge.call(M.NOTIFICATION_OPEN, {
          session: latest.sessionId
        })
        this.host.inbox.markRead(latest.id)
        this.host.showWindow()
        return { ...(result as Record<string, unknown>), notification_id: latest.id }
      }

      case M.APP_FOCUS:
        this.host.showWindow()
        return { focused: true }

      // 설정 다시 읽기 (P22-6). 파일 감시가 놓쳤을 때의 손잡이다
      case M.CONFIG_RELOAD: {
        const snapshot = this.host.reloadConfig()
        return {
          source: snapshot.source,
          problems: snapshot.problems.map((p) => ({ path: p.path, message: p.message }))
        }
      }

      case M.EVENTS_STREAM:
        this.startStream(client, params, id)
        return STREAMING

      default:
        throw new ControlError('unknown_method', `모르는 메서드: ${method}`)
    }
  }

  /**
   * 이벤트 구독 (P20-9).
   *
   * `after`를 주지 않으면 **지금부터**다 — `tail -f`와 같다. 그냥 붙었을 뿐인
   * 구독자에게 버퍼에 쌓인 4096개를 쏟아붓지 않는다. 놓친 구간을 따라잡으려는
   * 쪽은 마지막으로 처리한 seq를 `--after`로 말한다.
   */
  private startStream(client: Client, params: Record<string, unknown>, id: number): void {
    const after = params.after === undefined ? this.seq : Number(params.after)
    const rawNames = params.names
    const names = Array.isArray(rawNames) && rawNames.length > 0
      ? new Set(rawNames.map((n) => String(n)))
      : null

    const oldest = this.events[0]?.seq ?? this.seq
    const gap = after > 0 && after + 1 < oldest

    client.subscription = { names, pending: 0 }
    client.socket.write(
      `${JSON.stringify({
        id,
        ok: true,
        result: {
          type: 'ack',
          resume: {
            afterSeq: after,
            oldestSeq: oldest,
            latestSeq: this.seq,
            nextSeq: this.seq + 1,
            gap
          }
        }
      })}\n`
    )

    for (const frame of this.events) {
      if (frame.seq <= after) continue
      if (names !== null && !names.has(frame.name)) continue
      client.socket.write(`${JSON.stringify(frame)}\n`)
    }
  }

  /**
   * 세션 지정 (P20-4).
   *
   * 인자가 없으면 부르는 쪽의 세션이다 — 세션 안의 에이전트는 자기가 어디
   * 있는지 말하지 않아도 된다.
   */
  private session(raw: unknown): SessionMeta {
    const sessions = this.host.manager.list()
    const ref = raw === undefined || raw === null ? undefined : String(raw)
    if (ref === undefined) {
      throw new ControlError('invalid_params', '세션을 지정해야 합니다 (--session)')
    }
    const found = resolveHandle(sessions, ref, 'session')
    if (!found) throw new ControlError('not_found', `세션을 찾을 수 없습니다: ${ref}`)
    return found
  }

  /** 렌더러가 이벤트를 넣을 때 쓰는 id 발급기 */
  takeId(): number {
    return this.nextId++
  }
}

const STREAMING = Symbol('streaming')

function notePayload(note: Notification): Record<string, unknown> {
  return {
    id: note.id,
    session_id: note.sessionId,
    session_title: note.sessionTitle,
    text: note.text,
    read: note.read,
    created_at: note.createdAt
  }
}

function sessionPayload(meta: SessionMeta): Record<string, unknown> {
  return {
    id: meta.id,
    title: meta.title,
    cwd: meta.cwd,
    status: meta.status,
    confidence: meta.confidence,
    unread: meta.unread,
    exit_code: meta.exitCode,
    exit_signal: meta.exitSignal,
    alt_screen: meta.altScreen,
    ports: meta.ports,
    branch: meta.git?.branch ?? null,
    repo: meta.git?.repo ?? null,
    created_at: meta.createdAt
  }
}

/**
 * 화면을 텍스트로 읽을 때 제어 시퀀스를 걷어낸다 (P20-5).
 *
 * `read-screen`을 쓰는 쪽은 에이전트나 스크립트다. 색상 코드가 섞인 문자열은
 * 그쪽에서 다시 지워야 하므로 여기서 지운다.
 */
function stripAnsi(text: string): string {
  return (
    text
      // OSC — 제목·작업 디렉토리·알림. BEL이나 ST로 끝난다
      .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
      // CSI — 색상과 커서 이동
      .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
      // 그 밖의 두 글자 이스케이프
      .replace(/\x1b[@-Z\\-_]/g, '')
      // 남은 제어문자. 탭·줄바꿈·캐리지리턴은 화면의 일부라 살린다
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
  )
}

/**
 * 키 이름을 터미널이 아는 바이트로 (P20-5).
 *
 * 이름은 Playwright/W3C 관례를 따른다 — cmux가 `browser press`에서 쓰는 것과
 * 같은 표기라 스크립트를 그대로 옮겨 쓸 수 있다.
 */
export function keySequence(key: string): string | null {
  const named: Record<string, string> = {
    Enter: '\r',
    Return: '\r',
    Tab: '\t',
    Escape: '\x1b',
    Esc: '\x1b',
    Backspace: '\x7f',
    Delete: '\x1b[3~',
    Insert: '\x1b[2~',
    Space: ' ',
    Up: '\x1b[A',
    ArrowUp: '\x1b[A',
    Down: '\x1b[B',
    ArrowDown: '\x1b[B',
    Right: '\x1b[C',
    ArrowRight: '\x1b[C',
    Left: '\x1b[D',
    ArrowLeft: '\x1b[D',
    Home: '\x1b[H',
    End: '\x1b[F',
    PageUp: '\x1b[5~',
    PageDown: '\x1b[6~'
  }
  if (key in named) return named[key]

  // Ctrl+C — 셸에 인터럽트를 보내는 가장 흔한 요청이다
  const ctrl = /^(?:Ctrl\+|C-|\^)([A-Za-z])$/.exec(key)
  if (ctrl) {
    return String.fromCharCode(ctrl[1].toUpperCase().charCodeAt(0) - 64)
  }

  const fn = /^F([1-9]|1[0-2])$/.exec(key)
  if (fn) {
    const n = Number.parseInt(fn[1], 10)
    if (n <= 4) return `\x1bO${'PQRS'[n - 1]}`
    const codes = [15, 17, 18, 19, 20, 21, 23, 24]
    return `\x1b[${codes[n - 5]}~`
  }

  // 한 글자는 그대로 보낸다
  return [...key].length === 1 ? key : null
}

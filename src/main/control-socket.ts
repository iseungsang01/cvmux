import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { dirname } from 'node:path'

import type { BrowserManager } from './browser'
import type { UpdateManager } from './updater'
import {
  clickScript,
  fillScript,
  getScript,
  pressScript,
  snapshotScript,
  unwrapError,
  waitScript
} from './browser-agent'
import type { ConfigSnapshot } from '@core/config-store'
import type { NotificationStore } from '@core/notifications'
import { workspaceOfSession, type WorkspaceMetaStore } from '@core/workspace-meta'
import type { PtyManager } from '@core/pty-manager'
import {
  CONTROL_EVENT_BUFFER,
  CONTROL_MAX_FRAME_BYTES,
  CONTROL_PROTOCOL_VERSION,
  EV,
  M,
  M_INTERNAL,
  RENDERER_METHODS,
  resolveHandle,
  type ControlAckFrame,
  type ControlEndpoint,
  type ControlErrorCode,
  type ControlEventFrame,
  type ControlRequest
} from '@shared/protocol'
import type { Notification, SessionMeta, TodoItem, Workspace } from '@shared/types'

/**
 * 제어 소켓 서버 (P20).
 *
 * 앱 바깥에서 들어오는 명령을 받는다. 세션에 관한 것은 여기서 바로 답하고,
 * 워크스페이스·pane·알림처럼 렌더러가 들고 있는 것은 `bridge`로 넘긴다(P20-7).
 */

export interface ControlBridge {
  /**
   * 렌더러에 요청을 넘기고 답을 기다린다. 창이 없으면 거부한다.
   *
   * `windowId`를 주면 **그 창의** 렌더러에게 묻는다(P27-6). 주지 않으면 지금
   * 보고 있는 창이다 — 창이 하나뿐이던 시절의 동작 그대로다.
   */
  call(method: string, params: Record<string, unknown>, windowId?: string | null): Promise<unknown>
}

/**
 * 렌더러가 붙여 보낸 오류 코드를 나르는 오류 (P20-8).
 *
 * 다리를 놓는 쪽(ipc.ts)이 아니라 코드를 해석하는 쪽에 둔다 — 이 파일은
 * Electron에 기대지 않으므로 테스트가 그대로 불러 쓸 수 있다.
 */
export class BridgeError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message)
  }
}

export interface ControlHost {
  manager: PtyManager
  bridge: ControlBridge
  /** 알림함. 목록과 읽음 처리는 main이 답한다. P21 */
  inbox: NotificationStore
  /** 내장 브라우저. 화면 자체는 main이 들고 있다. P23 */
  browsers: BrowserManager
  /** 사이드바 메타데이터. 에이전트가 여기에 적는다. P25 */
  meta: WorkspaceMetaStore
  /** 지금 배치 — 세션이 어느 워크스페이스에 있는지 되짚는 데 쓴다. P25-6 */
  layout(): Workspace[]
  /** 창을 앞으로 가져온다 — `cvmux open`과 `app.focus`가 쓴다 */
  showWindow(): void
  /** 설정 파일을 다시 읽는다. P22-6 */
  reloadConfig(): ConfigSnapshot
  /** 자동 업데이트. P26 */
  updater: UpdateManager
  /** 창들. P27 */
  windows: WindowControl
  version: string
}

/** 창 하나의 겉모습 — `cvmux window list`가 보여 주는 것 */
export interface WindowInfo {
  id: string
  /** 마지막으로 포커스된 창인가 */
  current: boolean
  focused: boolean
  minimized: boolean
  visible: boolean
  workspaces: number
  title: string
}

/**
 * 창 조작 (P27-3).
 *
 * `WindowRegistry`를 그대로 받지 않고 좁은 인터페이스로 받는다 — 이 파일은
 * Electron에 기대지 않아야 테스트가 그대로 불러 쓸 수 있기 때문이다(P20-8과
 * 같은 이유).
 */
export interface WindowControl {
  list(): WindowInfo[]
  /** 새 창을 띄우고 그 id를 돌려준다 */
  create(): string
  focus(id: string): boolean
  close(id: string): boolean
  /** 지금 기준이 되는 창. 창이 하나도 없으면 null */
  current(): string | null
  has(id: string): boolean
  /** 워크스페이스가 지금 어느 창에 있는가 */
  ofWorkspace(workspaceId: string): string | null
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
      // 렌더러가 붙인 코드도 그대로 살린다. P20-8
      const code =
        error instanceof ControlError
          ? error.code
          : error instanceof BridgeError
            ? (error.code as ControlErrorCode)
            : 'internal_error'
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
    /*
     * 렌더러가 들고 있는 상태는 렌더러에게 묻는다 (P20-7).
     *
     * 어느 창의 렌더러인지는 `--window`가 정한다(P27-6). 없으면 지금 보고 있는
     * 창이다 — 스크립트 대부분은 창을 하나만 쓰므로 그때는 아무것도 달라지지 않는다.
     */
    if (RENDERER_METHODS.has(method)) {
      return this.host.bridge.call(method, params, this.targetWindow(params))
    }

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

      // ── 내장 브라우저 (P23-3) ────────────────────────────────
      case M.BROWSER_LIST:
        return { browsers: this.host.browsers.list() }

      case M.BROWSER_GOTO: {
        const id = this.browser(params)
        const url = String(params.url ?? params.to ?? '')
        if (!url) throw new ControlError('invalid_params', '주소가 필요합니다')
        this.host.browsers.navigate(id, url)
        return { id, url }
      }

      case M.BROWSER_BACK:
        return { moved: this.host.browsers.back(this.browser(params)) }
      case M.BROWSER_FORWARD:
        return { moved: this.host.browsers.forward(this.browser(params)) }
      case M.BROWSER_RELOAD:
        return { reloaded: this.host.browsers.reload(this.browser(params)) }

      case M.BROWSER_CLOSE: {
        const id = this.browser(params)
        // 화면을 닫으면 그 pane도 없어져야 한다 — 렌더러가 트리를 정리한다
        await this.host.bridge.call('browser.closed', { browser: id }).catch(() => undefined)
        return { closed: this.host.browsers.close(id) }
      }

      case M.BROWSER_SNAPSHOT:
        return this.inPage(this.browser(params), snapshotScript(Number(params.limit ?? 400)))

      case M.BROWSER_EVAL: {
        const code = String(params.code ?? params.script ?? '')
        if (!code) throw new ControlError('invalid_params', '실행할 코드가 필요합니다')
        return { result: await this.host.browsers.evaluate(this.browser(params), code) }
      }

      case M.BROWSER_CLICK:
        return this.inPage(
          this.browser(params),
          clickScript(optional(params.ref), optional(params.selector))
        )

      case M.BROWSER_FILL:
        return this.inPage(
          this.browser(params),
          fillScript(String(params.value ?? ''), optional(params.ref), optional(params.selector))
        )

      case M.BROWSER_PRESS: {
        const key = String(params.key ?? '')
        if (!key) throw new ControlError('invalid_params', '키가 필요합니다')
        return this.inPage(
          this.browser(params),
          pressScript(key, optional(params.ref), optional(params.selector))
        )
      }

      case M.BROWSER_GET:
        return {
          value: await this.inPage(
            this.browser(params),
            getScript(String(params.what ?? 'url'), optional(params.ref), optional(params.selector))
          )
        }

      case M.BROWSER_WAIT: {
        const kind = optional(params.selector)
          ? 'selector'
          : optional(params.text)
            ? 'text'
            : 'load'
        const value = String(params.selector ?? params.text ?? '')
        return this.inPage(
          this.browser(params),
          waitScript(kind, value, Number(params.timeout ?? 10_000))
        )
      }

      case M.BROWSER_SCREENSHOT:
        return { png_base64: await this.host.browsers.screenshot(this.browser(params)) }

      // ── 사이드바 메타데이터 (P25) ────────────────────────────
      case M.STATUS_SET: {
        const id = await this.workspace(params)
        const name = String(params.name ?? 'status')
        const text = String(params.text ?? params.value ?? '')
        if (!text) throw new ControlError('invalid_params', '표시할 내용이 필요합니다')
        return this.host.meta.setStatus(id, name, text, optional(params.color))
      }

      case M.STATUS_CLEAR: {
        const id = await this.workspace(params)
        return { removed: this.host.meta.clearStatus(id, optional(params.name)) }
      }

      case M.STATUS_LIST:
        return { status: this.host.meta.get(await this.workspace(params)).status }

      case M.PROGRESS_SET: {
        const id = await this.workspace(params)
        const raw = params.value ?? params.progress
        // 값이 없으면 끝을 모르는 채 돌고 있다는 뜻이다 — 흐르는 막대가 뜬다
        const value = raw === undefined || raw === null ? null : Number(raw)
        if (value !== null && !Number.isFinite(value)) {
          throw new ControlError('invalid_params', '진행률은 0과 1 사이의 수여야 합니다')
        }
        this.host.meta.setProgress(id, value, optional(params.text))
        return this.host.meta.get(id).progress
      }

      case M.PROGRESS_CLEAR:
        this.host.meta.clearProgress(await this.workspace(params))
        return { cleared: true }

      case M.LOG_APPEND: {
        const id = await this.workspace(params)
        const text = String(params.text ?? params.message ?? '')
        if (!text) throw new ControlError('invalid_params', '남길 내용이 필요합니다')
        const level = String(params.level ?? 'info')
        const known = ['info', 'warn', 'error', 'success']
        if (!known.includes(level)) {
          throw new ControlError('invalid_params', `level은 ${known.join('/')} 중 하나여야 합니다`)
        }
        return this.host.meta.log(id, text, level as 'info' | 'warn' | 'error' | 'success')
      }

      case M.LOG_CLEAR:
        this.host.meta.clearLog(await this.workspace(params))
        return { cleared: true }

      case M.LOG_LIST: {
        const entries = this.host.meta.get(await this.workspace(params)).log
        const limit = Number(params.limit ?? 0)
        return { log: limit > 0 ? entries.slice(-limit) : entries }
      }

      case M.SIDEBAR_STATE: {
        const id = await this.workspace(params)
        return { workspace_id: id, ...this.host.meta.get(id) }
      }

      // ── 체크리스트 (P25-4) ───────────────────────────────────
      case M.TODO_ADD: {
        const id = await this.workspace(params)
        const text = String(params.text ?? '')
        if (!text.trim()) throw new ControlError('invalid_params', '항목 내용이 필요합니다')
        const state = todoState(params.state)
        const origin = params.origin === 'user' ? 'user' : 'agent'
        try {
          return this.host.meta.addTodo(id, text, state, origin)
        } catch (error) {
          throw new ControlError('invalid_state', error instanceof Error ? error.message : String(error))
        }
      }

      case M.TODO_LIST:
        return { todo: this.host.meta.get(await this.workspace(params)).todo }

      case M.TODO_SET_STATE: {
        const id = await this.workspace(params)
        const ref = String(params.item ?? params.ref ?? '')
        const item = this.host.meta.setTodoState(id, ref, todoState(params.state))
        if (!item) throw new ControlError('not_found', `항목을 찾을 수 없습니다: ${ref}`)
        return item
      }

      case M.TODO_EDIT: {
        const id = await this.workspace(params)
        const ref = String(params.item ?? params.ref ?? '')
        const item = this.host.meta.editTodo(id, ref, String(params.text ?? ''))
        if (!item) throw new ControlError('not_found', `항목을 찾을 수 없습니다: ${ref}`)
        return item
      }

      case M.TODO_REMOVE: {
        const id = await this.workspace(params)
        const ref = String(params.item ?? params.ref ?? '')
        if (!this.host.meta.removeTodo(id, ref)) {
          throw new ControlError('not_found', `항목을 찾을 수 없습니다: ${ref}`)
        }
        return { removed: true }
      }

      case M.TODO_CLEAR:
        this.host.meta.clearTodo(await this.workspace(params))
        return { cleared: true }

      /*
       * 목록을 통째로 갈아 끼운다 (P25-5).
       *
       * 감시 루프가 매 틱마다 전체를 다시 보내도 체크박스의 정체가 유지되게
       * id를 존중한다. 하나라도 잘못되면 아무것도 바꾸지 않는다.
       */
      case M.TODO_REPLACE: {
        const id = await this.workspace(params)
        const raw = params.items
        if (!Array.isArray(raw)) throw new ControlError('invalid_params', 'items는 배열이어야 합니다')
        try {
          return { todo: this.host.meta.replaceTodo(id, raw as Array<Record<string, never>>) }
        } catch (error) {
          throw new ControlError('invalid_params', error instanceof Error ? error.message : String(error))
        }
      }

      // ── 자동 업데이트 (P26) ──────────────────────────────────
      case M.UPDATE_STATE:
        return this.host.updater.current

      case M.UPDATE_CHECK:
        // 사용자가 직접 부른 것이므로 설정에서 꺼 두었어도 본다. P26-5
        return this.host.updater.check(true)

      case M.UPDATE_INSTALL: {
        const state = this.host.updater.current
        if (state.status !== 'ready') {
          throw new ControlError(
            'invalid_state',
            `설치할 것이 없습니다 (지금 상태: ${state.status})`
          )
        }
        /*
         * 스크립트가 부르면 묻지 않는다 (P26-3).
         *
         * 화면에서 누를 때는 확인을 받지만, 소켓으로 부르는 쪽은 이미 결정을
         * 내린 것이다 — 대화상자를 띄우면 자동화가 거기서 멈춘다.
         */
        return { installing: this.host.updater.install(), version: state.version }
      }

      case M.APP_FOCUS:
        this.host.showWindow()
        return { focused: true }

      // ── 다중 창 (P27) ───────────────────────────────────────
      case M.WINDOW_LIST:
        return { windows: this.host.windows.list() }

      case M.WINDOW_CURRENT: {
        const id = this.host.windows.current()
        if (id === null) throw new ControlError('not_found', '열린 창이 없습니다')
        return this.host.windows.list().find((w) => w.id === id) ?? { id }
      }

      case M.WINDOW_NEW:
        return { window_id: this.host.windows.create() }

      case M.WINDOW_FOCUS: {
        const id = this.requireWindow(params.window)
        this.host.windows.focus(id)
        return { window_id: id, focused: true }
      }

      case M.WINDOW_CLOSE: {
        const id = this.requireWindow(params.window)
        /*
         * 마지막 창은 소켓으로 닫지 못한다 (P27-8).
         *
         * 닫아 버리면 화면이 하나도 남지 않는다 — 그때부터는 트레이 말고는
         * 되살릴 길이 없고, 스크립트는 자기가 앱을 숨겼다는 것도 모른다.
         * 앱을 정말 끄려는 것이라면 그것은 다른 명령이어야 한다.
         */
        if (this.host.windows.list().length <= 1) {
          throw new ControlError('invalid_state', '마지막 창은 닫을 수 없습니다')
        }
        return { window_id: id, closed: this.host.windows.close(id) }
      }

      /*
       * 워크스페이스를 다른 창으로 옮긴다 (P27-7).
       *
       * 보내는 쪽에서 떼어 내고 받는 쪽에 붙인다. 세션은 앱 전체가 들고 있으므로
       * 옮겨도 죽지 않는다 — 화면만 다른 창으로 건너간다.
       */
      case M.WINDOW_MOVE_WORKSPACE: {
        const target = this.requireWindow(params.window ?? params.to)
        const handle = String(params.workspace ?? '')
        if (handle === '') throw new ControlError('invalid_params', '옮길 워크스페이스를 지정하세요')

        /*
         * 참조는 **여기서** 푼다 (P27-7).
         *
         * 순번은 창마다 1부터 다시 세므로, 푼 뒤의 id를 넘겨야 한다. 보내는 쪽
         * 렌더러에게 `workspace:2`를 그대로 넘기면 그 창의 두 번째를 찾다가
         * 없다고 답한다 — 옮기려던 것과 다른 워크스페이스를 떼어 낼 수도 있다.
         */
        const workspaceId = resolveHandle(this.host.layout(), handle, 'workspace')?.id ?? handle
        const source = this.host.windows.ofWorkspace(workspaceId)
        if (source === null) {
          throw new ControlError('not_found', `그런 워크스페이스가 없습니다: ${handle}`)
        }
        if (source === target) return { window_id: target, moved: false }

        const detached = (await this.host.bridge.call(
          M_INTERNAL.WORKSPACE_DETACH,
          { workspace: workspaceId },
          source
        )) as { workspace?: unknown }
        if (!detached?.workspace) {
          throw new ControlError('not_found', `그런 워크스페이스가 없습니다: ${handle}`)
        }

        try {
          await this.host.bridge.call(
            M_INTERNAL.WORKSPACE_ATTACH,
            { workspace: detached.workspace },
            target
          )
        } catch (error) {
          // 붙이지 못했으면 원래 창에 되돌린다 — 워크스페이스를 잃어버리지 않는다
          await this.host.bridge
            .call(M_INTERNAL.WORKSPACE_ATTACH, { workspace: detached.workspace }, source)
            .catch(() => undefined)
          throw error
        }
        return { window_id: target, moved: true }
      }

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
   * `--window`가 가리키는 창 (P27-6).
   *
   * 값이 없으면 null — 다리가 알아서 지금 보고 있는 창을 고른다.
   */
  private targetWindow(params: Record<string, unknown>): string | null {
    if (params.window === undefined || params.window === null || params.window === '') return null
    return this.requireWindow(params.window)
  }

  /** 창 참조를 실제 id로 푼다. 순번(`1`)과 짧게 줄인 id도 받는다. P20-4 */
  private requireWindow(raw: unknown): string {
    const handle = String(raw ?? '')
    if (handle === '') {
      const current = this.host.windows.current()
      if (current === null) throw new ControlError('not_found', '열린 창이 없습니다')
      return current
    }
    const found = resolveHandle(this.host.windows.list(), handle, 'window')
    if (!found) throw new ControlError('not_found', `그런 창이 없습니다: ${handle}`)
    return found.id
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
    const ack: ControlAckFrame = {
      type: 'ack',
      resume: {
        afterSeq: after,
        oldestSeq: oldest,
        latestSeq: this.seq,
        nextSeq: this.seq + 1,
        gap: after > 0 && after + 1 < oldest
      }
    }

    client.subscription = { names, pending: 0 }
    client.socket.write(`${JSON.stringify({ id, ok: true, result: ack })}\n`)

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

  /**
   * 페이지에서 코드를 돌리고 오류를 되살린다 (P23-7).
   *
   * 스크립트가 던진 메시지는 `executeJavaScript`를 지나며 사라진다. 감싸서
   * 값으로 받아 온 것을 여기서 다시 오류로 세운다 — 에이전트에게 "그 요소가
   * 더 이상 없으니 스냅샷을 다시 뜨라"고 말해 줄 수 있어야 한다.
   */
  private async inPage(id: string, script: string): Promise<unknown> {
    const result = await this.host.browsers.evaluate(id, script)
    const message = unwrapError(result)
    if (message !== null) throw new ControlError('invalid_state', message)
    return result
  }

  /**
   * 워크스페이스 지정 (P25-6).
   *
   * 인자가 없으면 **부르는 쪽의 세션이 있는 워크스페이스**다. 세션 안의
   * 에이전트는 자기 워크스페이스 id를 모르고 `CVMUX_SESSION_ID`만 아는데,
   * 그것만으로 자기 사이드바 줄에 쓸 수 있어야 한다.
   */
  private async workspace(params: Record<string, unknown>): Promise<string> {
    const layout = this.host.layout()

    const explicit = optional(params.workspace)
    if (explicit !== undefined) {
      const found = resolveHandle(layout, explicit, 'workspace')
      if (!found) throw new ControlError('not_found', `워크스페이스를 찾을 수 없습니다: ${explicit}`)
      return found.id
    }

    const sessionId = optional(params.session)
    if (sessionId !== undefined) {
      const session = this.session(sessionId)
      const found = workspaceOfSession(layout, session.id)
      if (found) return found.id

      /*
       * 캐시가 아직 비었을 수 있다 (P25-6).
       *
       * main이 들고 있는 배치는 렌더러가 저장할 때마다 갱신되므로, 앱이 막 뜬
       * 직후에는 아직 비어 있다. 그때 실패로 끝내면 세션이 시작하자마자 부른
       * 에이전트만 유독 실패한다 — 그래서 렌더러에게 직접 한 번 더 묻는다.
       */
      const asked = (await this.host.bridge.call(M.NOTIFICATION_OPEN, {
        session: session.id
      })) as { workspace_id?: unknown }
      if (typeof asked.workspace_id === 'string') return asked.workspace_id
      throw new ControlError('not_found', '그 세션이 있는 워크스페이스를 찾지 못했습니다')
    }

    if (layout.length === 0) {
      throw new ControlError('invalid_state', '열린 워크스페이스가 없습니다')
    }
    throw new ControlError(
      'invalid_params',
      '워크스페이스를 지정해야 합니다 (--workspace 또는 --session)'
    )
  }

  /**
   * 브라우저 화면 지정 (P23-3).
   *
   * 인자가 없으면 딱 하나 열려 있을 때만 그것을 쓴다. 여럿일 때 아무거나
   * 고르면 스크립트가 조용히 엉뚱한 화면을 조작한다 — P20-4와 같은 이유다.
   */
  private browser(params: Record<string, unknown>): string {
    const browsers = this.host.browsers.list()
    const ref = params.browser ?? params.surface ?? params.id
    if (ref === undefined || ref === null || ref === '') {
      if (browsers.length === 1) return browsers[0].id
      if (browsers.length === 0) {
        throw new ControlError('not_found', '열린 브라우저 화면이 없습니다')
      }
      throw new ControlError(
        'invalid_params',
        `브라우저 화면이 ${browsers.length}개입니다. --browser로 지정하세요`
      )
    }
    const found = resolveHandle(browsers, String(ref), 'browser')
    if (!found) throw new ControlError('not_found', `브라우저 화면을 찾을 수 없습니다: ${String(ref)}`)
    return found.id
  }
}

/** 체크리스트 상태 이름. 모르는 값은 대기로 본다 */
function todoState(value: unknown): TodoItem['state'] {
  const text = String(value ?? 'pending')
  if (text === 'in-progress' || text === 'completed') return text
  return 'pending'
}

function optional(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  return String(value)
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

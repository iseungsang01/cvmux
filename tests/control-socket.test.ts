/*
 * 제어 소켓 서버(POLICY.md P20)의 통합 테스트.
 *
 * 진짜 named pipe를 열고 진짜 소켓으로 붙는다. 프레이밍·인증·오류 코드는
 * 단위 테스트로는 잡히지 않는 것들이라 — 줄바꿈 하나가 어긋나면 응답이
 * 영영 오지 않고, 그건 타입 검사에 걸리지 않는다.
 *
 * Electron이 필요 없다. 소켓 서버는 PtyManager를 타입으로만 알고 있으므로
 * 여기서는 필요한 만큼만 흉내 낸 객체를 넣는다.
 *
 * 실행: npm test
 */
import { EventEmitter } from 'node:events'
import { connect, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { NotificationStore } from '../src/core/notifications'
import { WorkspaceMetaStore } from '../src/core/workspace-meta'
import { DEFAULT_CONFIG } from '../src/shared/config'
import type { BrowserManager } from '../src/main/browser'
import type { PtyManager } from '../src/core/pty-manager'
import type { SessionMeta, Workspace } from '../src/shared/types'
import { ControlSocketServer, pipePathFor } from '../src/main/control-socket'

const results: string[] = []
let failed = 0

function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failed++
  results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `  ← ${detail}` : ''}`)
}

function meta(id: string, overrides: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id,
    title: `session ${id}`,
    userTitle: null,
    cwd: 'C:\\work',
    shell: 'pwsh.exe',
    status: 'idle',
    confidence: 'certain',
    preview: '',
    unread: false,
    exitCode: null,
    exitSignal: null,
    warning: null,
    altScreen: false,
    git: null,
    ports: [],
    shells: [],
    createdAt: 1,
    ...overrides
  }
}

/** 소켓 서버가 실제로 부르는 것만 갖춘 가짜 PtyManager */
class FakeManager extends EventEmitter {
  readonly written: Array<{ id: string; data: string }> = []
  readonly notified: Array<{ id: string; text: string }> = []
  private readonly sessions = [meta('sess-alpha'), meta('sess-beta', { status: 'busy' })]

  list(): SessionMeta[] {
    return this.sessions
  }

  snapshot(id: string): { meta: SessionMeta; replay: string } | null {
    const found = this.sessions.find((s) => s.id === id)
    if (!found) return null
    // 색상과 OSC가 섞인 화면 — read-screen이 이걸 걷어내야 한다
    return {
      meta: found,
      // Clear-Host를 지나온 버퍼처럼 끝에 공백뿐인 줄이 붙어 있다
      replay: '\x1b]0;title\x07\x1b[32mhello\x1b[0m\nsecond\nthird\n   \n \n'
    }
  }

  write(id: string, data: string): boolean {
    this.written.push({ id, data })
    return true
  }

  notify(id: string, text: string): boolean {
    this.notified.push({ id, text })
    return true
  }

  close(): boolean {
    return true
  }
  restart(): boolean {
    return true
  }
  setTitle(): boolean {
    return true
  }
}

/** 한 줄씩 주고받는 최소 클라이언트. CLI가 쓰는 것과 같은 프레이밍이다 */
class TestClient {
  private buffer = ''
  private readonly waiting = new Map<number, (frame: unknown) => void>()
  private readonly events: unknown[] = []
  private socket!: Socket

  static open(path: string): Promise<TestClient> {
    return new Promise((resolve, reject) => {
      const client = new TestClient()
      const socket = connect(path)
      socket.setEncoding('utf8')
      socket.on('data', (chunk: string) => client.feed(chunk))
      socket.once('connect', () => {
        client.socket = socket
        resolve(client)
      })
      socket.once('error', reject)
    })
  }

  private feed(chunk: string): void {
    this.buffer += chunk
    let cut = this.buffer.indexOf('\n')
    while (cut !== -1) {
      const line = this.buffer.slice(0, cut)
      this.buffer = this.buffer.slice(cut + 1)
      if (line.trim()) {
        const frame = JSON.parse(line) as { id?: number; type?: string }
        if (frame.type === 'event') this.events.push(frame)
        else if (typeof frame.id === 'number') {
          const resolve = this.waiting.get(frame.id)
          this.waiting.delete(frame.id)
          resolve?.(frame)
        }
      }
      cut = this.buffer.indexOf('\n')
    }
  }

  send(id: number, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return new Promise((resolve) => {
      this.waiting.set(id, (frame) => resolve(frame as Record<string, unknown>))
      this.socket.write(`${JSON.stringify({ id, ...body })}\n`)
    })
  }

  eventNames(): string[] {
    return this.events.map((e) => (e as { name: string }).name)
  }

  /** 이벤트가 도착할 틈을 준다 — 소켓은 비동기다 */
  settle(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 60))
  }

  close(): void {
    this.socket.destroy()
  }
}

async function main(): Promise<void> {
  const manager = new FakeManager()
  // 테스트용 파이프 — 실제 앱과 겹치지 않게 다른 이름을 쓴다
  const pipe = pipePathFor(join(tmpdir(), `cvmux-test-${process.pid}`))
  const endpointFile = join(tmpdir(), `cvmux-test-endpoint-${process.pid}.json`)

  let focused = 0
  const inbox = new NotificationStore(() => {})
  const metaStore = new WorkspaceMetaStore(() => {})
  /*
   * 세션이 어느 워크스페이스에 있는지 (P25-6).
   *
   * 실제로는 렌더러가 저장할 때 넘겨 준 배치다. 여기서는 세션 두 개가 한
   * 워크스페이스에 들어 있는 가장 단순한 모양이면 충분하다.
   */
  const layout: Workspace[] = [
    {
      id: 'ws-test',
      title: null,
      root: { kind: 'leaf', id: 'pane-test', surfaces: ['sess-alpha', 'sess-beta'], active: 0 },
      focusedPaneId: 'pane-test'
    }
  ]
  const server = new ControlSocketServer(
    {
      manager: manager as unknown as PtyManager,
      bridge: {
        call: (method) =>
          method === 'workspace.list'
            ? Promise.resolve({ workspaces: [] })
            : method === 'notification.open'
              ? Promise.resolve({ workspace_id: 'ws-1', pane_id: 'pane-1' })
              : Promise.reject(new Error('창이 없습니다'))
      },
      inbox,
      // 브라우저는 이 테스트의 대상이 아니다 — 목록이 비어 있는 것으로 충분하다
      browsers: { list: () => [] } as unknown as BrowserManager,
      meta: metaStore,
      layout: () => layout,
      showWindow: () => {
        focused++
      },
      reloadConfig: () => ({ config: DEFAULT_CONFIG, source: null, problems: [] }),
      version: '0.1.0-test'
    },
    pipe,
    endpointFile
  )
  server.start()
  await new Promise((resolve) => setTimeout(resolve, 120))

  const password = server.env.CVMUX_SOCKET_PASSWORD
  check('세션 환경에 소켓 주소가 실린다', server.env.CVMUX_SOCKET_PATH === pipe)
  check('비밀번호가 생성된다', typeof password === 'string' && password.length >= 32)

  // ── P20-6: 비밀번호 없이는 아무것도 못 한다
  {
    const client = await TestClient.open(pipe)
    const response = await client.send(1, { method: 'ping' })
    check('비밀번호 없는 요청은 거부', response.ok === false)
    check(
      '거부 코드는 unauthorized',
      (response.error as { code: string } | undefined)?.code === 'unauthorized'
    )

    const wrong = await client.send(2, { method: 'ping', auth: 'nope' })
    check('틀린 비밀번호도 거부', wrong.ok === false)
    client.close()
  }

  const client = await TestClient.open(pipe)

  // ── 기본 메서드
  {
    const pong = await client.send(1, { method: 'ping', auth: password })
    check('인증 후 ping', pong.ok === true)
    check('버전이 실린다', (pong.result as { version: string }).version === '0.1.0-test')

    // 한 번 인증하면 그 연결에서는 다시 묻지 않는다
    const again = await client.send(2, { method: 'ping' })
    check('연결당 한 번만 인증', again.ok === true)
  }

  {
    const caps = await client.send(3, { method: 'capabilities' })
    const methods = (caps.result as { methods: string[] }).methods
    check('capabilities가 메서드를 알려준다', methods.includes('session.send-key'))
  }

  {
    const bad = await client.send(4, { method: 'no.such.method' })
    check('모르는 메서드는 unknown_method', (bad.error as { code: string }).code === 'unknown_method')
  }

  // ── P20-4: 세션 지정
  {
    const list = await client.send(5, { method: 'session.list' })
    const sessions = (list.result as { sessions: Array<{ id: string }> }).sessions
    check('세션 목록', sessions.length === 2 && sessions[0].id === 'sess-alpha')

    const byIndex = await client.send(6, { method: 'session.read', params: { session: '2' } })
    check(
      '순번으로 세션 지정',
      (byIndex.result as { session_id: string }).session_id === 'sess-beta'
    )

    const missing = await client.send(7, { method: 'session.read', params: { session: 'nope' } })
    check('없는 세션은 not_found', (missing.error as { code: string }).code === 'not_found')

    const noArg = await client.send(8, { method: 'session.read' })
    check(
      '세션을 안 주면 invalid_params',
      (noArg.error as { code: string }).code === 'invalid_params'
    )
  }

  // ── P20-5: 화면 읽기는 제어 시퀀스를 걷어낸다
  {
    const screen = await client.send(9, {
      method: 'session.read',
      params: { session: 'sess-alpha' }
    })
    const text = (screen.result as { text: string }).text
    check('색상 코드가 지워진다', !text.includes('\x1b'), JSON.stringify(text))
    check('OSC 제목이 지워진다', !text.includes('title'), JSON.stringify(text))
    check('본문은 남는다', text.includes('hello') && text.includes('third'))

    const tail = await client.send(10, {
      method: 'session.read',
      params: { session: 'sess-alpha', lines: 2 }
    })
    const tailText = (tail.result as { text: string }).text
    check('--lines는 뒤에서 센다', !tailText.includes('hello') && tailText.includes('third'))
    check(
      '끝의 빈 줄을 한 줄로 세지 않는다',
      tailText.split('\n').length === 2 && tailText.includes('second'),
      JSON.stringify(tailText)
    )
  }

  // ── 입력 보내기
  {
    await client.send(11, {
      method: 'session.send',
      params: { session: 'sess-alpha', text: 'npm test', enter: true }
    })
    check(
      'send --enter는 CR을 붙인다',
      manager.written.at(-1)?.data === 'npm test\r',
      JSON.stringify(manager.written.at(-1))
    )

    await client.send(12, {
      method: 'session.send-key',
      params: { session: 'sess-alpha', key: 'Ctrl+C' }
    })
    check('send-key Ctrl+C', manager.written.at(-1)?.data === '\x03')

    const badKey = await client.send(13, {
      method: 'session.send-key',
      params: { session: 'sess-alpha', key: 'Frobnicate' }
    })
    check('모르는 키는 invalid_params', (badKey.error as { code: string }).code === 'invalid_params')
  }

  // ── 알림 주입
  {
    await client.send(14, {
      method: 'session.notify',
      params: { session: 'sess-alpha', title: '빌드', text: '끝났습니다' }
    })
    check(
      '제목과 본문이 합쳐진다',
      manager.notified.at(-1)?.text === '빌드: 끝났습니다',
      JSON.stringify(manager.notified.at(-1))
    )
  }

  // ── P20-7: 렌더러가 답할 것은 다리를 건넌다
  {
    const ok = await client.send(15, { method: 'workspace.list' })
    check('렌더러 메서드가 다리를 건넌다', ok.ok === true)

    const rejected = await client.send(16, { method: 'workspace.create' })
    check('창이 없으면 실패로 답한다', rejected.ok === false)
    check(
      '실패 사유가 그대로 전달된다',
      String((rejected.error as { message: string }).message).includes('창이 없습니다')
    )
  }

  // ── app.focus
  {
    await client.send(17, { method: 'app.focus' })
    check('app.focus가 창을 부른다', focused === 1)
  }

  // ── P21: 알림함
  {
    const empty = await client.send(18, { method: 'notification.list' })
    check('빈 알림함', (empty.result as { unread_count: number }).unread_count === 0)

    const jumpNothing = await client.send(19, { method: 'notification.jump-to-unread' })
    check(
      '읽을 것이 없으면 not_found',
      (jumpNothing.error as { code: string }).code === 'not_found'
    )

    inbox.add('sess-alpha', 'npm run dev', '빌드 실패')
    inbox.add('sess-beta', 'claude', '확인이 필요합니다')

    const list = await client.send(20, { method: 'notification.list' })
    const payload = list.result as {
      unread_count: number
      notifications: Array<{ text: string; session_id: string; read: boolean }>
    }
    check('두 개가 쌓였다', payload.unread_count === 2)
    check('최신이 앞이다', payload.notifications[0].text === '확인이 필요합니다')

    /*
     * 같은 세션이 연달아 부르면 마지막 것만 남는다 (P21-1).
     *
     * 다섯 줄이 쌓이는 것보다 마지막 한 줄이 지금 상태를 더 정확히 말한다.
     */
    inbox.add('sess-beta', 'claude', '아직도 기다립니다')
    const merged = await client.send(21, { method: 'notification.list' })
    check(
      '연속 알림은 합쳐진다',
      (merged.result as { unread_count: number }).unread_count === 2,
      String((merged.result as { unread_count: number }).unread_count)
    )
    check(
      '합쳐진 알림은 마지막 내용',
      (merged.result as { notifications: Array<{ text: string }> }).notifications[0].text ===
        '아직도 기다립니다'
    )

    // 가장 최근 미읽음으로 이동하면 그 알림은 읽음이 된다
    const jump = await client.send(22, { method: 'notification.jump-to-unread' })
    check('jump-to-unread가 대상을 찾는다', jump.ok === true)
    check(
      '창도 함께 깨운다',
      focused === 2,
      String(focused)
    )
    const after = await client.send(23, { method: 'notification.list' })
    check(
      '이동한 알림은 읽음이 된다',
      (after.result as { unread_count: number }).unread_count === 1
    )

    // 읽은 것만 치운다 — 아직 보지 않은 것은 남는다
    await client.send(24, { method: 'notification.clear' })
    const remaining = await client.send(25, { method: 'notification.list' })
    const left = (remaining.result as { notifications: Array<{ read: boolean }> }).notifications
    check('읽은 것만 치운다', left.length === 1 && !left[0].read, String(left.length))

    await client.send(26, { method: 'notification.clear', params: { all: true } })
    const cleared = await client.send(27, { method: 'notification.list' })
    check(
      '--all은 전부 비운다',
      (cleared.result as { notifications: unknown[] }).notifications.length === 0
    )
  }

  // ── P20-9: 이벤트 스트림
  {
    const stream = await TestClient.open(pipe)
    const ack = await stream.send(1, { method: 'events.stream', auth: password, params: {} })
    check('첫 프레임은 ack', (ack.result as { type: string }).type === 'ack')

    manager.emit('created', meta('sess-gamma'))
    manager.emit('closed', 'sess-gamma')
    await stream.settle()

    check(
      '세션 생성·종료가 흘러온다',
      stream.eventNames().includes('session.created') &&
        stream.eventNames().includes('session.closed'),
      stream.eventNames().join(',')
    )
    stream.close()
  }

  // 이름 필터. 기본 구독은 지금부터이므로 앞선 테스트의 이벤트는 오지 않는다
  {
    const filtered = await TestClient.open(pipe)
    await filtered.send(1, {
      method: 'events.stream',
      auth: password,
      params: { names: ['session.closed'] }
    })
    manager.emit('created', meta('sess-delta'))
    manager.emit('closed', 'sess-delta')
    await filtered.settle()

    check(
      '--name으로 거른다',
      filtered.eventNames().length === 1 && filtered.eventNames()[0] === 'session.closed',
      filtered.eventNames().join(',')
    )
    filtered.close()
  }

  /*
   * 기본 구독은 지금부터, --after는 되감기 (P20-9).
   *
   * 이걸 뒤집으면 `cvmux events`를 켜자마자 지난 4096개가 쏟아진다 — 지금
   * 무슨 일이 일어나는지 보려고 켠 사람에게는 소음이다.
   */
  {
    const fresh = await TestClient.open(pipe)
    await fresh.send(1, { method: 'events.stream', auth: password, params: {} })
    await fresh.settle()
    check('그냥 붙으면 과거는 안 온다', fresh.eventNames().length === 0, fresh.eventNames().join(','))
    fresh.close()

    const rewound = await TestClient.open(pipe)
    const ack = await rewound.send(1, {
      method: 'events.stream',
      auth: password,
      params: { after: 0 }
    })
    await rewound.settle()
    check('--after 0은 버퍼를 되감는다', rewound.eventNames().length > 0)
    check(
      'ack가 재생 범위를 알려준다',
      (ack.result as { resume: { latestSeq: number } }).resume.latestSeq > 0
    )
    rewound.close()
  }

  // ── 잘못된 프레임
  {
    const junk = await TestClient.open(pipe)
    const response = await junk.send(1, { method: 'ping', auth: password })
    check('정상 프레임은 통과', response.ok === true)
    junk.close()
  }

  client.close()
  server.stop()

  console.log(results.join('\n'))
  console.log(`\n${results.length - failed}/${results.length} passed`)
  process.exit(failed === 0 ? 0 : 1)
}

void main()

import { EventEmitter } from 'node:events'
import { spawn } from 'node:child_process'
import { connect, type Socket } from 'node:net'

import {
  FrameDecoder,
  PROTOCOL_VERSION,
  RPC,
  encodeFrame,
  isEvent,
  pipePath,
  type HelloResult,
  type Response,
  type ServerMessage
} from '@core/protocol'

/**
 * 데몬에 붙는 쪽 (POLICY.md P20).
 *
 * 앱은 세션을 소유하지 않는다. 여기서 하는 일은 요청을 파이프 너머로 넘기고
 * 돌아오는 이벤트를 렌더러에 전달하는 것뿐이다.
 */

/** 데몬이 뜨기를 기다리는 간격과 횟수. 넉넉하되 무한하지는 않게 */
const CONNECT_RETRY_MS = 120
const CONNECT_TIMEOUT_MS = 8000

export interface DaemonClientOptions {
  /** 데몬 진입점(daemon.js)의 절대 경로 */
  entry: string
  /** 데몬이 상태를 둘 디렉토리 — 앱의 userData와 같은 곳이어야 한다 */
  stateDir: string
}

export class DaemonClient extends EventEmitter {
  private socket: Socket | null = null
  private nextId = 1
  private readonly pending = new Map<
    number,
    { resolve(value: unknown): void; reject(error: Error): void }
  >()

  constructor(private readonly options: DaemonClientOptions) {
    super()
  }

  get connected(): boolean {
    return this.socket !== null && !this.socket.destroyed
  }

  /**
   * 데몬에 연결한다. 없으면 띄우고 기다린다.
   *
   * 프로토콜이 다른 데몬을 만나면 물러나게 한 뒤 우리 짝을 새로 세운다.
   * 앱만 새로 설치하고 데몬은 예전 것이 남아 있는 상황이 실제로 생긴다(P20-5).
   */
  async start(): Promise<void> {
    await this.ensureConnection()

    const hello = (await this.call(RPC.HELLO)) as HelloResult
    if (hello.protocol === PROTOCOL_VERSION) {
      console.log(`[cvmux] 데몬에 연결했습니다 (pid ${hello.pid})`)
      return
    }

    console.log(
      `[cvmux] 데몬의 프로토콜이 다릅니다 (데몬 ${hello.protocol} / 앱 ${PROTOCOL_VERSION}). 교체합니다`
    )
    try {
      await this.call(RPC.SHUTDOWN)
    } catch {
      // 종료 요청에 답하지 못하고 죽어도 상관없다 — 어차피 물러나야 할 데몬이다
    }
    this.dropSocket()
    // 파이프가 풀릴 시간을 준다. 곧바로 다시 걸면 죽어가는 데몬을 다시 잡는다
    await delay(400)
    await this.ensureConnection()
  }

  /**
   * 이미 돌고 있는 데몬에만 붙는다 (P20-15).
   *
   * 없으면 없는 것이다 — 재우러 온 길에 새로 세우면, 설치 프로그램이 방금
   * 비운 자리를 우리가 다시 붙잡는 꼴이 된다.
   */
  async connectExisting(): Promise<boolean> {
    if (this.connected) return true
    try {
      this.attach(await openPipe(this.options.stateDir))
      return true
    } catch {
      return false
    }
  }

  /**
   * 연결이 끊길 때까지 기다린다.
   *
   * 데몬은 세션 프로세스 트리를 다 정리한 뒤에야 소켓을 끊는다. 그래서 이
   * 신호는 "치우는 중"이 아니라 "다 치웠다"는 뜻이다(P20-15).
   */
  waitForClose(timeoutMs: number): Promise<void> {
    if (!this.connected) return Promise.resolve()
    return new Promise((resolve) => {
      const finish = (): void => {
        clearTimeout(timer)
        this.off('disconnect', finish)
        resolve()
      }
      const timer = setTimeout(finish, timeoutMs)
      this.once('disconnect', finish)
    })
  }

  private async ensureConnection(): Promise<void> {
    if (this.connected) return

    const deadline = Date.now() + CONNECT_TIMEOUT_MS
    let spawned = false

    for (;;) {
      try {
        this.attach(await openPipe(this.options.stateDir))
        return
      } catch (error) {
        // 파이프가 없다 = 데몬이 없다. 한 번만 띄우고 뜨기를 기다린다
        if (!spawned) {
          this.spawnDaemon()
          spawned = true
        }
        if (Date.now() >= deadline) {
          throw new Error(
            `데몬에 연결하지 못했습니다: ${error instanceof Error ? error.message : String(error)}`
          )
        }
        await delay(CONNECT_RETRY_MS)
      }
    }
  }

  /**
   * 데몬을 띄운다 (P20-2).
   *
   * `detached`와 `unref`가 핵심이다. 이것이 없으면 데몬은 앱의 자식으로 남아
   * 앱이 죽을 때 함께 끌려간다 — 앱을 종료해도 세션이 살아 있어야 한다는
   * 전제가 무너진다. stdio를 끊는 것도 같은 이유다. 부모의 파이프를 붙들고
   * 있으면 부모가 사라질 때 쓰기가 실패한다.
   *
   * Electron 실행 파일을 `ELECTRON_RUN_AS_NODE`로 다시 부른다. 별도의 Node
   * 런타임을 설치본에 함께 넣지 않아도 되는 길이다.
   */
  private spawnDaemon(): void {
    const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
    // 앱이 어떤 자리를 쓰는지는 앱만 안다 — 데몬이 짐작하게 두지 않는다
    const args = [this.options.entry, `--state-dir=${this.options.stateDir}`]

    const child = spawn(process.execPath, args, {
      env,
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    })
    child.unref()
    console.log(`[cvmux] 데몬을 띄웠습니다 (pid ${child.pid ?? '?'})`)
  }

  private attach(socket: Socket): void {
    this.socket = socket
    socket.setNoDelay(true)

    const decoder = new FrameDecoder()

    socket.on('data', (chunk) => {
      for (const message of decoder.push(chunk)) {
        this.handle(message as ServerMessage)
      }
      if (decoder.overflowed) socket.destroy()
    })

    socket.on('close', () => this.onDisconnect())
    socket.on('error', () => this.onDisconnect())
  }

  private handle(message: ServerMessage): void {
    if (isEvent(message)) {
      this.emit(message.event, ...message.args)
      return
    }

    const response = message as Response
    const waiter = this.pending.get(response.id)
    if (!waiter) return
    this.pending.delete(response.id)
    if (response.ok) waiter.resolve(response.result)
    else waiter.reject(new Error(response.error ?? '데몬이 요청을 거절했습니다'))
  }

  private onDisconnect(): void {
    if (this.socket === null) return
    this.dropSocket()
    // 기다리던 요청은 전부 실패로 끝낸다 — 영원히 매달려 있는 것보다 낫다
    for (const waiter of this.pending.values()) {
      waiter.reject(new Error('데몬과의 연결이 끊겼습니다'))
    }
    this.pending.clear()
    this.emit('disconnect')
  }

  private dropSocket(): void {
    const socket = this.socket
    this.socket = null
    if (socket && !socket.destroyed) socket.destroy()
  }

  call(method: string, ...params: unknown[]): Promise<unknown> {
    const socket = this.socket
    if (!socket || socket.destroyed) {
      return Promise.reject(new Error('데몬에 연결되어 있지 않습니다'))
    }

    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      socket.write(encodeFrame({ id, method, params }))
    })
  }
}

function openPipe(stateDir: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect(pipePath(stateDir))
    const onError = (error: Error): void => {
      socket.destroy()
      reject(error)
    }
    socket.once('error', onError)
    socket.once('connect', () => {
      socket.off('error', onError)
      resolve(socket)
    })
  })
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

import { Worker } from 'node:worker_threads'

/**
 * ConPTY 출력 중계를 Worker 하나로 모은다 (P8-7).
 *
 * node-pty는 세션마다 Worker 스레드를 하나씩 띄워 ConPTY의 출력 파이프를 비운다.
 * `ClosePseudoConsole`이 출력 파이프가 비기를 기다리며 main 스레드를 막으므로,
 * 파이프를 비우는 쪽은 다른 스레드여야 한다는 이유다(node-pty #375). 이유는
 * 옳지만 스레드마다 Node 환경이 통째로 한 벌씩 서서, 세션 하나에 12MB 남짓이
 * 붙는다 — 켜 둔 세션 6개가 main에서만 75MB를 먹었다.
 *
 * 다른 스레드이기만 하면 되므로 하나를 모두가 나눠 쓴다. 같은 6개가 14MB가 된다.
 *
 * node-pty의 내부 모듈을 갈아 끼우는 방식이다. 모양이 바뀌어 끼우지 못하면
 * 경고만 남기고 원래대로(세션마다 Worker) 돈다 — 메모리를 더 쓸 뿐 틀리지는 않는다.
 */

/**
 * 파이프 하나가 실패해도 Worker가 죽으면 안 된다 — 모든 세션의 출력이 함께
 * 끊긴다. 그래서 소켓마다 오류를 받아 그 파이프만 걷어낸다.
 *
 * 원본 Worker는 받은 것을 utf8 문자열로 풀었다가 다시 썼다. 받는 쪽 소켓이
 * 이미 utf8로 풀므로 여기서는 바이트를 그대로 흘린다.
 */
const WORKER_SOURCE = `
const { parentPort } = require('node:worker_threads')
const net = require('node:net')
const pipes = new Map()

function remove(name) {
  const pipe = pipes.get(name)
  if (!pipe) return
  pipes.delete(name)
  pipe.conout.destroy()
  pipe.server.close()
}

parentPort.on('message', ({ type, name }) => {
  if (type === 'remove') return remove(name)
  const conout = new net.Socket()
  const server = net.createServer((client) => {
    client.on('error', () => {})
    conout.pipe(client)
  })
  pipes.set(name, { conout, server })
  conout.on('error', () => remove(name))
  server.on('error', () => remove(name))
  conout.connect(name, () => {
    server.listen(name + '-worker', () => parentPort.postMessage({ type: 'ready', name }))
  })
})
`

/** 셸이 끝난 뒤 남은 출력을 기다리는 시간. node-pty의 FLUSH_DATA_INTERVAL과 같다 */
const FLUSH_DATA_MS = 1000

let worker: Worker | null = null
const waiting = new Map<string, () => void>()
let open = 0

function sharedWorker(): Worker {
  if (worker) return worker
  const created = new Worker(WORKER_SOURCE, { eval: true })
  // 세션이 없을 때 이 스레드가 프로세스를 붙잡고 있으면 안 된다
  created.unref()
  created.on('message', (message: { type: string; name: string }) => {
    if (message.type !== 'ready') return
    const fire = waiting.get(message.name)
    waiting.delete(message.name)
    fire?.()
  })
  created.on('error', (error) => {
    console.warn('[cvmux] ConPTY 출력 중계 스레드가 죽었습니다. 다음 세션부터 새로 띄웁니다:', error)
    worker = null
  })
  worker = created
  return created
}

/** node-pty의 `ConoutConnection`과 같은 모양. windowsPtyAgent가 이것만 부른다 */
class SharedConoutConnection {
  private listeners: Array<() => void> = []
  private disposed = false
  private drainTimer: NodeJS.Timeout | null = null

  constructor(
    private readonly conoutPipeName: string,
    private readonly useConptyDll: boolean
  ) {
    open += 1
    waiting.set(conoutPipeName, () => {
      for (const listener of this.listeners) listener()
    })
    sharedWorker().postMessage({ type: 'add', name: conoutPipeName })
  }

  get onReady(): (listener: () => void) => { dispose(): void } {
    return (listener) => {
      this.listeners.push(listener)
      return { dispose: () => (this.listeners = this.listeners.filter((l) => l !== listener)) }
    }
  }

  connectSocket(socket: { connect(path: string): unknown }): void {
    socket.connect(`${this.conoutPipeName}-worker`)
  }

  dispose(): void {
    // 원본과 같은 조건이다 — conpty.dll을 쓰면 dispose가 여러 번 와도 매번 타이머를 다시 건다
    if (!this.useConptyDll && this.disposed) return
    if (!this.disposed) open -= 1
    this.disposed = true
    if (this.drainTimer) clearTimeout(this.drainTimer)
    this.drainTimer = setTimeout(() => {
      waiting.delete(this.conoutPipeName)
      worker?.postMessage({ type: 'remove', name: this.conoutPipeName })
    }, FLUSH_DATA_MS)
  }
}

/** 지금 중계 중인 세션 수. 테스트가 끼워졌는지 확인하는 데 쓴다 */
export function sharedConoutCount(): number {
  return open
}

/** @returns 끼웠으면 true. 모양이 달라 끼우지 못했으면 false (세션마다 Worker로 돈다) */
export function installSharedConout(): boolean {
  if (process.platform !== 'win32') return false
  try {
    const connection = require('node-pty/lib/windowsConoutConnection') as { ConoutConnection?: unknown }
    if (typeof connection.ConoutConnection !== 'function') {
      throw new Error('ConoutConnection이 없습니다')
    }
    connection.ConoutConnection = SharedConoutConnection
    return true
  } catch (error) {
    console.warn('[cvmux] ConPTY 출력 중계를 하나로 모으지 못해 세션마다 스레드를 띄웁니다:', error)
    return false
  }
}

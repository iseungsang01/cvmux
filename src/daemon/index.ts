import { appendFileSync, mkdirSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { POLICY } from '@shared/policy'
import type { CreateSessionOptions, Workspace } from '@shared/types'
import {
  FrameDecoder,
  PROTOCOL_VERSION,
  RPC,
  RPC_EVENT,
  encodeFrame,
  pipePath,
  type HelloResult,
  type Request
} from '@core/protocol'
import { PtyManager } from '@core/pty-manager'
import { SessionStore, workspacesFromPersisted, workspacesToPersisted } from '@core/store'

/**
 * 세션을 들고 있는 프로세스 (POLICY.md P20).
 *
 * cvmux 창은 여기 붙었다 떨어지는 뷰어일 뿐이다. 앱을 완전히 종료해도 이
 * 프로세스는 남아 셸과 그 자식들을 계속 돌린다 — 창을 닫는 일과 작업을
 * 끝내는 일은 서로 다른 결정이기 때문이다(P18의 연장).
 *
 * Electron이 아니라 `ELECTRON_RUN_AS_NODE=1`로 도는 순수 Node 프로세스다.
 * 그래서 여기서는 Electron API를 쓸 수 없고, 써서도 안 된다. 토스트나
 * 대화상자처럼 사람에게 보이는 것은 전부 앱의 몫이다(P20-7).
 */

const startedAt = Date.now()

/**
 * 상태를 둘 디렉토리.
 *
 * 앱이 띄울 때는 자기 userData 경로를 넘겨준다(`--user-data-dir` 같은 스위치로
 * 옮겨 쓸 수 있으므로 짐작하면 안 된다). 로그인 시 혼자 뜨는 경우에는 넘겨줄
 * 앱이 없으니 Electron이 쓰는 기본 자리를 그대로 따른다.
 */
function resolveStateDir(): string {
  const flag = process.argv.find((arg) => arg.startsWith('--state-dir='))
  if (flag) return flag.slice('--state-dir='.length)
  const appData = process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming')
  return join(appData, 'cvmux')
}

const stateDir = resolveStateDir()

/**
 * 데몬에는 콘솔이 없다 — 부모가 stdio를 끊고 떠나기 때문이다(P20-2).
 * 무슨 일이 있었는지 알 수 있는 곳은 이 파일뿐이다.
 */
function log(message: string): void {
  const line = `[${new Date().toISOString()}] ${message}\n`
  try {
    mkdirSync(stateDir, { recursive: true })
    appendFileSync(join(stateDir, 'daemon.log'), line, 'utf8')
  } catch {
    // 로그를 못 남기는 것이 세션을 죽일 이유는 되지 않는다
  }
}

process.on('uncaughtException', (error) => {
  log(`uncaught exception: ${error instanceof Error ? error.stack : String(error)}`)
})
process.on('unhandledRejection', (reason) => {
  log(`unhandled rejection: ${String(reason)}`)
})

const store = new SessionStore(join(stateDir, 'sessions.json'))
const manager = new PtyManager({ defaultCwd: homedir() })

/** 렌더러가 소유하는 pane 배치. 데몬은 보관만 한다. P17 / P20-4 */
let currentLayout: Workspace[] = []

const clients = new Set<Socket>()
let persistTimer: NodeJS.Timeout | null = null
let persistDebounce: NodeJS.Timeout | null = null
let shuttingDown = false

function persistNow(): void {
  store.save({
    version: 2,
    savedAt: Date.now(),
    sessions: manager.serialize(),
    // 세션을 순번으로 가리키므로 serialize()와 같은 순서를 넘겨야 한다
    workspaces: workspacesToPersisted(currentLayout, manager.sessionOrder())
  })
}

function schedulePersist(): void {
  if (persistDebounce !== null) return
  persistDebounce = setTimeout(() => {
    persistDebounce = null
    persistNow()
  }, 1000)
}

// ── 이벤트를 붙어 있는 앱들에게 흘려보낸다 ──────────────────────

function broadcast(event: string, args: unknown[]): void {
  // 아무도 보고 있지 않으면 보내지 않는다. 출력은 세션의 재생 버퍼에 쌓이고,
  // 앱이 다시 붙을 때 스냅샷으로 한 번에 따라잡는다(P9-1 / P18-7)
  if (clients.size === 0) return
  const frame = encodeFrame({ event, args })
  for (const socket of clients) {
    if (socket.destroyed) continue
    socket.write(frame)
  }
}

manager.on('data', (id, chunk) => broadcast(RPC_EVENT.DATA, [id, chunk]))
manager.on('meta', (meta) => broadcast(RPC_EVENT.META, [meta]))
manager.on('exit', (info) => broadcast(RPC_EVENT.EXIT, [info]))
/*
 * 알림에는 세션 제목을 함께 실어 보낸다.
 *
 * 토스트를 띄우는 쪽은 앱이고(P20-7), 앱은 세션을 소유하지 않는다. 제목을
 * 알아내려고 다시 물어보게 하면 그 왕복 동안 세션이 닫힐 수도 있다.
 */
manager.on('notify', (id, text) =>
  broadcast(RPC_EVENT.NOTIFY, [id, text, manager.metaOf(id)?.title ?? ''])
)

manager.on('created', (meta) => {
  schedulePersist()
  broadcast(RPC_EVENT.CREATED, [meta])
})

manager.on('closed', (id) => {
  schedulePersist()
  broadcast(RPC_EVENT.CLOSED, [id])
})

// ── 요청 처리 ────────────────────────────────────────────────

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined)

async function dispatch(method: string, params: unknown[]): Promise<unknown> {
  switch (method) {
    case RPC.HELLO: {
      const hello: HelloResult = { protocol: PROTOCOL_VERSION, pid: process.pid, startedAt }
      return hello
    }

    case RPC.LIST:
      return manager.list()

    case RPC.SNAPSHOT: {
      const id = str(params[0])
      return id ? manager.snapshot(id) : null
    }

    case RPC.CREATE: {
      const opts = (params[0] ?? {}) as CreateSessionOptions
      return manager.create({
        cwd: str(opts.cwd),
        shell: str(opts.shell),
        title: str(opts.title),
        cols: num(opts.cols),
        rows: num(opts.rows)
      })
    }

    case RPC.CLOSE: {
      const id = str(params[0])
      return id ? await manager.close(id) : false
    }

    case RPC.RESTART: {
      const id = str(params[0])
      return id ? manager.restart(id) : false
    }

    case RPC.WRITE: {
      const id = str(params[0])
      const data = str(params[1])
      return id !== undefined && data !== undefined ? manager.write(id, data) : false
    }

    case RPC.RESIZE: {
      const id = str(params[0])
      const cols = num(params[1])
      const rows = num(params[2])
      return id !== undefined && cols !== undefined && rows !== undefined
        ? manager.resize(id, cols, rows)
        : false
    }

    case RPC.SET_TITLE: {
      const id = str(params[0])
      const title = params[1]
      return id !== undefined && (typeof title === 'string' || title === null)
        ? manager.setTitle(id, title)
        : false
    }

    case RPC.MARK_READ: {
      const id = str(params[0])
      return id ? manager.markRead(id) : false
    }

    case RPC.BUSY_COUNT:
      return manager.busyCount()

    case RPC.LOAD_LAYOUT:
      return currentLayout

    case RPC.SAVE_LAYOUT: {
      if (!Array.isArray(params[0])) return false
      currentLayout = params[0] as Workspace[]
      schedulePersist()
      return true
    }

    case RPC.SHUTDOWN:
      // 응답이 나간 뒤에 정리를 시작한다 — 앱이 결과를 못 받고 끊기지 않도록
      setTimeout(() => void shutdown('앱이 종료를 요청했습니다'), 0)
      return true

    default:
      throw new Error(`알 수 없는 요청: ${method}`)
  }
}

function handleConnection(socket: Socket): void {
  clients.add(socket)
  // 출력이 몰릴 때 지연이 쌓이지 않게 한다
  socket.setNoDelay(true)
  log(`앱이 연결되었습니다 (연결 ${clients.size}개)`)

  const decoder = new FrameDecoder()

  socket.on('data', (chunk) => {
    const messages = decoder.push(chunk)
    if (decoder.overflowed) {
      log('프레임 상한을 넘었습니다 — 연결을 끊습니다')
      socket.destroy()
      return
    }

    for (const message of messages) {
      const request = message as Request
      if (typeof request?.id !== 'number' || typeof request.method !== 'string') continue

      void dispatch(request.method, Array.isArray(request.params) ? request.params : [])
        .then((result) => {
          if (!socket.destroyed) socket.write(encodeFrame({ id: request.id, ok: true, result }))
        })
        .catch((error: unknown) => {
          const text = error instanceof Error ? error.message : String(error)
          if (!socket.destroyed) {
            socket.write(encodeFrame({ id: request.id, ok: false, error: text }))
          }
        })
    }
  })

  const drop = (): void => {
    if (!clients.delete(socket)) return
    // 앱이 사라져도 세션은 계속 돈다. 이 프로세스가 존재하는 이유가 그것이다. P20-1
    log(`앱 연결이 끊겼습니다 (남은 연결 ${clients.size}개). 세션은 계속 돕니다`)
  }

  socket.on('close', drop)
  socket.on('error', drop)
}

async function shutdown(reason: string): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  log(`종료합니다: ${reason}`)

  if (persistTimer !== null) clearInterval(persistTimer)
  if (persistDebounce !== null) clearTimeout(persistDebounce)
  // 세션을 정리하기 전에 마지막으로 남긴다 — disposeAll이 목록을 비운다. P16-1
  persistNow()

  for (const socket of clients) socket.destroy()
  clients.clear()
  server.close()

  await manager.disposeAll()
  process.exit(0)
}

// ── 기동 ─────────────────────────────────────────────────────

const server: Server = createServer(handleConnection)

server.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EADDRINUSE') {
    // 파이프가 곧 락이다. 이미 누가 듣고 있으면 그쪽이 진짜 데몬이다. P20-3
    log('이미 데몬이 돌고 있습니다. 물러납니다')
    process.exit(0)
  }
  log(`파이프 오류: ${error.message}`)
  process.exit(1)
})

server.listen(pipePath(stateDir), () => {
  log(`데몬이 떴습니다 (pid ${process.pid}, 상태 경로 ${stateDir})`)

  /*
   * 저장된 세션을 되살린다 (P16 / P20-9).
   *
   * 앱보다 먼저 뜨는 경우가 있다 — 로그인 직후 자동 시작이 그렇다. 그때는
   * 사용자가 창을 열기도 전에 세션이 제자리를 잡고 있게 된다. 되살아나는
   * 것은 자리(작업 디렉토리와 화면)이지 프로세스가 아니라는 점은 그대로다.
   */
  const saved = store.load()
  if (saved !== null && saved.sessions.length > 0) {
    const ids = manager.restore(saved.sessions)
    currentLayout = workspacesFromPersisted(saved.workspaces, ids)
    const count = ids.filter((id) => id !== null).length
    log(`세션 ${count}개, 워크스페이스 ${currentLayout.length}개를 복원했습니다`)
  }

  persistTimer = setInterval(persistNow, POLICY.PERSIST_INTERVAL_MS)
})

// 로그아웃이나 종료 신호에도 프로세스 트리를 정리하고 나간다. P10-2
process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))

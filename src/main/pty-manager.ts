import { EventEmitter } from 'node:events'
import { execFile } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import * as pty from 'node-pty'

import { POLICY } from '@shared/policy'
import type {
  CreateSessionOptions,
  CreateSessionResult,
  SessionExitInfo,
  SessionMeta,
  SessionSnapshot
} from '@shared/types'
import { SessionState } from './session-state'

/**
 * PowerShell 세션 부트스트랩 (P3-3).
 *
 * 한글 Windows의 기본 코드페이지는 949라 UTF-8 출력이 깨진다. 사용자 프로필을
 * 건드리지 않고 세션 한정으로 인코딩만 바꾼다. 인용 지옥을 피하려고
 * -EncodedCommand(UTF-16LE Base64)로 넘긴다.
 */
const PS_BOOTSTRAP = [
  '$OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
  '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
  '[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)',
  'Clear-Host'
].join('; ')

function encodePowerShellCommand(command: string): string {
  return Buffer.from(command, 'utf16le').toString('base64')
}

/** pwsh(7) → Windows PowerShell → cmd 순으로 찾는다 */
function resolveShell(preferred?: string): string | null {
  if (preferred && existsSync(preferred)) return preferred

  const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files'
  const systemRoot = process.env.SystemRoot ?? 'C:\\Windows'
  const candidates = [
    process.env.CVMUX_SHELL,
    join(programFiles, 'PowerShell', '7', 'pwsh.exe'),
    join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    process.env.ComSpec,
    join(systemRoot, 'System32', 'cmd.exe')
  ]

  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate
  }
  return null
}

function shellArgs(shell: string): string[] {
  const name = basename(shell).toLowerCase()
  if (name === 'pwsh.exe' || name === 'powershell.exe') {
    return ['-NoLogo', '-NoExit', '-EncodedCommand', encodePowerShellCommand(PS_BOOTSTRAP)]
  }
  return []
}

/** 존재하지 않는 cwd는 홈으로 폴백하고 경고를 남긴다. P11-1 / P11-2 */
function resolveCwd(requested: string | undefined): { cwd: string; warning: string | null } {
  const home = homedir()
  if (!requested) return { cwd: home, warning: null }
  try {
    if (existsSync(requested) && statSync(requested).isDirectory()) {
      return { cwd: requested, warning: null }
    }
  } catch {
    // 접근 불가 — 폴백한다
  }
  return { cwd: home, warning: `작업 디렉토리를 찾을 수 없어 홈으로 시작합니다: ${requested}` }
}

/**
 * 프로세스 트리를 통째로 종료한다 (P1-6 / P10-2).
 *
 * ConPTY를 닫으면 셸은 죽지만 셸이 띄운 node/python 같은 손자 프로세스는
 * 고아로 남는다. taskkill /T가 트리 전체를 정리한다.
 */
function killTree(pid: number): Promise<void> {
  return new Promise((resolve) => {
    execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve())
  })
}

/** 셸이 OSC 0/2로 보고한 제목이 쓸만한가. 실행 파일 경로는 제목으로 쓰지 않는다. P5-8 */
function usableTitle(title: string | null): string | null {
  if (!title) return null
  const trimmed = title.trim()
  if (!trimmed) return null
  if (/\.exe$/i.test(trimmed)) return null
  return trimmed
}

class Session {
  readonly id = randomUUID()
  readonly createdAt = Date.now()
  readonly state: SessionState

  proc: pty.IPty | null = null
  shell: string
  cwd: string
  userTitle: string | null
  warning: string | null = null
  exitCode: number | null = null
  exitSignal: number | null = null
  cols: number
  rows: number

  private startedAt = 0
  /** 렌더러 재연결 시 화면을 되살릴 최근 출력. P9-1 */
  private replay = ''
  /** IPC 배칭 버퍼. P3-4 */
  private pending = ''
  private flushTimer: NodeJS.Timeout | null = null
  private disposed = false

  constructor(
    options: CreateSessionOptions,
    private readonly emit: {
      data(id: string, chunk: string): void
      meta(id: string): void
      exit(info: SessionExitInfo): void
      notify(id: string, text: string): void
    }
  ) {
    const resolved = resolveCwd(options.cwd)
    this.cwd = resolved.cwd
    this.warning = resolved.warning
    this.shell = options.shell ?? ''
    this.userTitle = options.title ?? null
    this.cols = clampCols(options.cols)
    this.rows = clampRows(options.rows)

    this.state = new SessionState({
      onChange: () => this.emit.meta(this.id),
      onNotify: (text) => this.emit.notify(this.id, text),
      onCwd: (cwd) => {
        if (cwd && cwd !== this.cwd) {
          this.cwd = cwd
          this.emit.meta(this.id)
        }
      }
    })
  }

  get alive(): boolean {
    return this.proc !== null
  }

  /** PTY를 띄운다. 실패해도 예외를 던지지 않고 세션을 오류 상태로 남긴다. P1-5 */
  start(preferredShell?: string): void {
    const shell = resolveShell(preferredShell || this.shell || undefined)
    if (!shell) {
      this.failToStart('사용 가능한 셸을 찾지 못했습니다. PowerShell 또는 cmd.exe가 필요합니다.')
      return
    }
    this.shell = shell

    try {
      const proc = pty.spawn(shell, shellArgs(shell), {
        name: 'xterm-256color',
        cols: this.cols,
        rows: this.rows,
        cwd: this.cwd,
        useConpty: true,
        env: buildEnv(this.id)
      })

      this.proc = proc
      this.startedAt = Date.now()

      proc.onData((chunk) => this.onData(chunk))
      proc.onExit(({ exitCode, signal }) => this.onExit(exitCode, signal ?? null))
    } catch (error) {
      this.failToStart(
        `셸을 시작하지 못했습니다: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }

  private failToStart(message: string): void {
    this.proc = null
    this.warning = message
    this.exitCode = null
    this.state.noteExit()
    // 터미널 영역에도 보이게 한다 — 사이드바 경고만으로는 놓치기 쉽다. P1-5 / P12-3
    const text = `\r\n\x1b[31m${message}\x1b[0m\r\n`
    this.appendReplay(text)
    this.emit.data(this.id, text)
    this.emit.meta(this.id)
  }

  private onData(chunk: string): void {
    if (this.disposed) return
    this.state.ingest(chunk)
    this.appendReplay(chunk)

    this.pending += chunk
    if (this.pending.length >= POLICY.IPC_MAX_BATCH_BYTES) {
      this.flushOut()
    } else if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flushOut(), POLICY.IPC_FLUSH_MS)
    }
  }

  private flushOut(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    if (!this.pending) return
    const chunk = this.pending
    this.pending = ''
    this.emit.data(this.id, chunk)
  }

  private onExit(exitCode: number, signal: number | null): void {
    const instant = Date.now() - this.startedAt < POLICY.INSTANT_EXIT_MS
    this.flushOut()
    this.proc = null
    // signal이 있으면 신호 종료, 없으면 정상 종료. P1-2 / P1-3
    if (signal) {
      this.exitCode = null
      this.exitSignal = signal
    } else {
      this.exitCode = exitCode
      this.exitSignal = null
    }
    // 즉사한 셸을 자동 재시작하면 무한 루프가 된다 — 사용자에게 맡긴다. P2-7
    if (instant && exitCode !== 0) {
      this.warning = '셸이 시작하자마자 종료했습니다. 셸 설정이나 프로필을 확인해 주세요.'
    }
    this.state.noteExit()
    this.emit.exit({ id: this.id, exitCode: this.exitCode, exitSignal: this.exitSignal })
    this.emit.meta(this.id)
  }

  /** 종료된 세션을 같은 id/cwd로 되살린다. P1-4 */
  restart(): boolean {
    if (this.alive) return false
    this.exitCode = null
    this.exitSignal = null
    this.warning = null
    this.replay = ''
    this.pending = ''
    this.state.reset()
    this.start(this.shell)
    this.emit.meta(this.id)
    return true
  }

  write(data: string): void {
    // 죽은 PTY에 쓰는 것은 오류가 아니라 무시 대상이다. P2-5
    if (!this.proc) return
    try {
      this.proc.write(data)
      this.state.noteInput()
    } catch {
      // EPIPE / Access denied — 종료 이벤트가 곧 따라온다
    }
  }

  resize(cols: number, rows: number): void {
    const c = clampCols(cols)
    const r = clampRows(rows)
    if (c === this.cols && r === this.rows) return
    this.cols = c
    this.rows = r
    this.state.noteResize()
    if (!this.proc) return
    try {
      this.proc.resize(c, r)
    } catch {
      // ConPTY가 이미 닫혔다 — 무시. P2-5
    }
  }

  private appendReplay(chunk: string): void {
    this.replay += chunk
    if (this.replay.length > POLICY.REPLAY_BUFFER_BYTES) {
      const cut = this.replay.length - POLICY.REPLAY_BUFFER_BYTES
      // 잘린 이스케이프 시퀀스가 재생 시 화면을 깨뜨리지 않도록 개행 경계에서 자른다
      const nl = this.replay.indexOf('\n', cut)
      this.replay = this.replay.slice(nl === -1 ? cut : nl + 1)
    }
  }

  snapshot(): SessionSnapshot {
    return { meta: this.toMeta(), replay: this.replay }
  }

  toMeta(): SessionMeta {
    return {
      id: this.id,
      title: this.userTitle ?? usableTitle(this.state.shellTitle) ?? basename(this.cwd) ?? 'session',
      userTitle: this.userTitle,
      cwd: this.cwd,
      shell: this.shell,
      status: this.state.status,
      confidence: this.state.confidence,
      preview: this.state.preview,
      unread: this.state.unread,
      exitCode: this.exitCode,
      exitSignal: this.exitSignal,
      warning: this.warning,
      altScreen: this.state.altScreen,
      createdAt: this.createdAt
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    this.state.dispose()

    const proc = this.proc
    this.proc = null
    if (!proc) return
    // 트리를 먼저 정리하고 PTY를 닫는다. 순서가 반대면 손자가 고아로 남는다. P1-6
    try {
      await killTree(proc.pid)
    } catch {
      // 이미 죽었을 수 있다
    }
    try {
      proc.kill()
    } catch {
      // 이미 죽었다 — 정상
    }
  }
}

function clampCols(value: number | undefined): number {
  const n = Math.floor(value ?? 80)
  return Number.isFinite(n) && n >= POLICY.MIN_COLS ? n : POLICY.MIN_COLS // P2-1
}

function clampRows(value: number | undefined): number {
  const n = Math.floor(value ?? 24)
  return Number.isFinite(n) && n >= POLICY.MIN_ROWS ? n : POLICY.MIN_ROWS // P2-1
}

function buildEnv(sessionId: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') env[key] = value
  }
  env.TERM = 'xterm-256color'
  env.COLORTERM = 'truecolor'
  // 에이전트 훅이 자신이 cvmux 안에서 도는지 알 수 있게 한다
  env.CVMUX = '1'
  env.CVMUX_SESSION_ID = sessionId
  return env
}

export interface PtyManagerEvents {
  data: [id: string, chunk: string]
  meta: [meta: SessionMeta]
  exit: [info: SessionExitInfo]
  closed: [id: string]
  created: [meta: SessionMeta]
  notify: [id: string, text: string]
}

export class PtyManager extends EventEmitter<PtyManagerEvents> {
  private readonly sessions = new Map<string, Session>()

  create(options: CreateSessionOptions = {}): CreateSessionResult {
    // 상한 초과는 예외가 아니라 사유가 담긴 실패다. P1-8 / P8-3 / P12
    if (this.sessions.size >= POLICY.MAX_SESSIONS) {
      return {
        ok: false,
        error: `세션은 최대 ${POLICY.MAX_SESSIONS}개까지 열 수 있습니다. 사용하지 않는 세션을 닫아 주세요.`
      }
    }

    const session = new Session(options, {
      data: (id, chunk) => this.emit('data', id, chunk),
      meta: (id) => {
        const s = this.sessions.get(id)
        if (s) this.emit('meta', s.toMeta())
      },
      exit: (info) => this.emit('exit', info),
      notify: (id, text) => this.emit('notify', id, text)
    })

    this.sessions.set(session.id, session)
    session.start()

    const meta = session.toMeta()
    this.emit('created', meta)
    return { ok: true, session: meta }
  }

  list(): SessionMeta[] {
    return [...this.sessions.values()]
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((s) => s.toMeta())
  }

  snapshot(id: string): SessionSnapshot | null {
    return this.sessions.get(id)?.snapshot() ?? null
  }

  /** 알 수 없는 세션 id는 조용히 false — 예외로 렌더러를 죽이지 않는다. P1-9 */
  write(id: string, data: string): boolean {
    const session = this.sessions.get(id)
    if (!session) return false
    session.write(data)
    return true
  }

  resize(id: string, cols: number, rows: number): boolean {
    const session = this.sessions.get(id)
    if (!session) return false
    session.resize(cols, rows)
    return true
  }

  restart(id: string): boolean {
    const session = this.sessions.get(id)
    if (!session) return false
    return session.restart()
  }

  setTitle(id: string, title: string | null): boolean {
    const session = this.sessions.get(id)
    if (!session) return false
    session.userTitle = title?.trim() ? title.trim() : null
    this.emit('meta', session.toMeta())
    return true
  }

  markRead(id: string): boolean {
    const session = this.sessions.get(id)
    if (!session) return false
    session.state.markRead()
    return true
  }

  /** 활성 세션의 cwd를 새 세션이 물려받는다. P11-1 */
  cwdOf(id: string | null | undefined): string | undefined {
    if (!id) return undefined
    return this.sessions.get(id)?.cwd
  }

  /** busy 세션이 몇 개인지 — 종료 확인 대화상자에 쓴다. P10-1 */
  busyCount(): number {
    let n = 0
    for (const session of this.sessions.values()) {
      if (session.alive && session.state.status === 'busy') n++
    }
    return n
  }

  async close(id: string): Promise<boolean> {
    const session = this.sessions.get(id)
    if (!session) return false
    this.sessions.delete(id)
    await session.dispose()
    this.emit('closed', id)
    return true
  }

  /** 앱 종료 — 모든 프로세스 트리를 정리한다. 고아 프로세스 금지. P10-2 */
  async disposeAll(): Promise<void> {
    const all = [...this.sessions.values()]
    this.sessions.clear()
    await Promise.all(all.map((s) => s.dispose()))
  }
}

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
  GitInfo,
  SessionExitInfo,
  SessionMeta,
  SessionSnapshot
} from '@shared/types'
import { ProbeScheduler, gitInfoEqual, portsEqual, shellsEqual } from './probe-scheduler'
import { SessionState } from './session-state'
import type { CvmuxConfig } from '@shared/config'
import { resumeCommand } from './agent-sessions'
import { trimScrollback, type PersistedSession } from './store'

/**
 * PowerShell 세션 부트스트랩 (P3-3).
 *
 * 한글 Windows의 기본 코드페이지는 949라 UTF-8 출력이 깨진다. 사용자 프로필을
 * 건드리지 않고 세션 한정으로 인코딩만 바꾼다. 인용 지옥을 피하려고
 * -EncodedCommand(UTF-16LE Base64)로 넘긴다.
 */
function psBootstrap(keepScreen: boolean, resume: string | null): string {
  const parts = [
    '$OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
    '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
    '[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)'
  ]
  if (process.env.CVMUX_NO_SHELL_INTEGRATION !== '1') parts.push(SHELL_INTEGRATION)
  // 복원된 세션에서는 화면을 지우지 않는다 — 지우면 복원한 스크롤백이 날아간다. P16-6
  if (!keepScreen) parts.push('Clear-Host')

  /*
   * 에이전트 이어서 띄우기 (P22-8).
   *
   * 부트스트랩 끝에 붙인다. 셸 통합이 이미 걸린 뒤이고 대화형 REPL이 시작되기
   * 전이라, 사용자가 직접 친 것과 같은 자리에서 돈다. 에이전트를 끝내면
   * `-NoExit` 덕분에 그냥 셸로 남는다 — 세션이 사라지지 않는다.
   */
  if (resume) {
    parts.push(`Write-Host "── 이어서 띄웁니다: ${resume} ──" -ForegroundColor DarkGray`)
    parts.push(resume)
  }
  return parts.join('\n')
}

/**
 * 셸 통합 심기 (P3-9).
 *
 * PowerShell은 기본적으로 작업 디렉토리(OSC 7)도 프롬프트 경계(OSC 133)도
 * 알려주지 않는다. 그래서 사용자가 `cd`로 옮겨 다녀도 cvmux는 세션이 시작한
 * 자리에 머물러 있다고 믿는다 — 사이드바의 경로와 git 정보가 전부 홈으로
 * 굳어버리는 원인이다.
 *
 * 프로필이 정의한 prompt를 **감싸는** 방식이라 oh-my-posh 같은 테마를 깨뜨리지
 * 않는다. 프로필 파일도 건드리지 않는다 — 이 세션 안에서만 유효하다(P3-3과 같은 원칙).
 *
 * 원본 prompt를 가장 먼저 호출하는 순서가 중요하다. 우리 코드가 앞서면 `$?`와
 * `$LASTEXITCODE`가 우리 것으로 덮여, 직전 명령의 실패를 색으로 알려주는
 * 테마들이 전부 성공한 것처럼 보이게 된다.
 *
 * 이스케이프 시퀀스를 prompt의 **반환 문자열**에 담는 것도 의도적이다. PSReadLine은
 * 프롬프트를 그린 뒤 커서 위치로 폭을 재므로, 폭이 0인 OSC는 계산을 어긋내지
 * 않는다 — VS Code와 Windows Terminal이 쓰는 방식이다.
 *
 * `PSConsoleHostReadLine` 훅을 prompt 안에서 거는 이유도 순서 때문이다. PSReadLine은
 * 대화형 REPL이 시작될 때 로드되는데, 이 스크립트는 `-EncodedCommand`로 그보다
 * **먼저** 실행된다. 바깥에서 한 번만 확인하면 함수가 아직 없어 훅을 놓치고,
 * 명령 시작(133;C)을 영영 알 수 없게 된다. 프롬프트가 처음 그려질 때는 이미
 * 로드된 뒤이므로 그때 건다.
 */
const SHELL_INTEGRATION = `
if (-not $global:__cvmuxShellIntegration) {
  $global:__cvmuxShellIntegration = $true
  $global:__cvmuxPrompt = $function:prompt
  function global:prompt {
    $body = (& $global:__cvmuxPrompt) -join ''
    if (-not $global:__cvmuxReadLineHooked -and (Test-Path Function:\\PSConsoleHostReadLine)) {
      $global:__cvmuxReadLineHooked = $true
      $global:__cvmuxReadLine = $function:PSConsoleHostReadLine
      function global:PSConsoleHostReadLine {
        $line = & $global:__cvmuxReadLine
        [Console]::Write("$([char]27)]133;C$([char]7)")
        $line
      }
    }
    $e = [char]27
    $b = [char]7
    $cwd = ''
    $loc = $ExecutionContext.SessionState.Path.CurrentLocation
    if ($loc.Provider.Name -eq 'FileSystem') {
      $p = $loc.ProviderPath -replace '\\\\', '/' -replace '#', '%23' -replace '\\?', '%3F'
      $cwd = "$e]7;file:///$p$b"
    }
    "$e]133;D$b$e]133;A$b$cwd$body$e]133;B$b"
  }
}
`.trim()

/**
 * 셸과 ConPTY가 시작하면서 보내는 화면 지우기(ED)를 걷어낸다 (P16-6).
 *
 * 복원된 세션에서만 쓴다. 이걸 하지 않으면 애써 되살린 스크롤백을 새 셸의 첫
 * 출력이 통째로 지워버린다.
 *
 * 커서 이동(CUP)은 건드리지 않는다. 한때 같이 지웠더니 PSReadLine이 커서를
 * 되돌리지 못해 새 프롬프트가 복원된 프롬프트 옆에 나란히 그려졌다. 커서는
 * 맨 위로 가도 괜찮다 — 지우지만 않으면 복원분은 스크롤백에 그대로 남는다.
 */
function stripScreenClear(chunk: string): string {
  return chunk.replace(/\x1b\[[0-3]?J/g, '')
}

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

function shellArgs(shell: string, keepScreen: boolean, resume: string | null): string[] {
  const name = basename(shell).toLowerCase()
  if (name === 'pwsh.exe' || name === 'powershell.exe') {
    return [
      '-NoLogo',
      '-NoExit',
      '-EncodedCommand',
      encodePowerShellCommand(psBootstrap(keepScreen, resume))
    ]
  }
  return []
}

/** 존재하지 않는 cwd는 폴백하고 경고를 남긴다. P11-1 / P11-2 / P16-4 */
function resolveCwd(
  requested: string | undefined,
  fallback: string
): { cwd: string; warning: string | null } {
  if (!requested) return { cwd: fallback, warning: null }
  try {
    if (existsSync(requested) && statSync(requested).isDirectory()) {
      return { cwd: requested, warning: null }
    }
  } catch {
    // 접근 불가 — 폴백한다
  }
  return {
    cwd: fallback,
    warning: `작업 디렉토리를 찾을 수 없어 ${fallback} 에서 시작합니다: ${requested}`
  }
}

export interface PtyManagerOptions {
  /** 아무 것도 지정되지 않았을 때 세션이 시작할 디렉토리. 기본은 사용자 홈 */
  defaultCwd?: string
}

/** 복원된 스크롤백과 새 셸의 출력 사이에 긋는 선. P16-6 */
const RESTORE_DIVIDER = `\r\n\x1b[90m${'─'.repeat(12)} 이전 세션 (복원됨) ${'─'.repeat(12)}\x1b[0m\r\n`

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
  /** 주변 정보 — 프로브가 채운다. P13 / P14 */
  git: GitInfo | null = null
  ports: number[] = []
  /** 이 세션 아래에서 따로 도는 셸들. P14-13 */
  shells: string[] = []

  private startedAt = 0
  /** 저장된 스크롤백에서 되살아난 세션인가. P16-6 */
  private restored = false
  /** 이 시각까지는 화면 지우기 시퀀스를 걷어낸다 (복원 화면 보호). P16-6 */
  private stripClearUntil = 0
  /** 렌더러 재연결 시 화면을 되살릴 최근 출력. P9-1 */
  private replay = ''
  /** IPC 배칭 버퍼. P3-4 */
  private pending = ''
  private flushTimer: NodeJS.Timeout | null = null
  private disposed = false

  constructor(
    options: CreateSessionOptions,
    defaultCwd: string,
    restoredScrollback: string | null,
    /**
     * 모든 세션에 얹는 환경변수 (P20-3).
     *
     * 제어 소켓 주소가 여기 실린다. 객체를 그대로 들고 있다가 `start()` 때
     * 읽으므로, 소켓이 세션보다 늦게 열려도 재시작한 세션은 주소를 받는다.
     */
    private readonly sessionEnv: Record<string, string>,
    /**
     * 복원할 때 셸 시작과 함께 띄울 명령 (P22-8).
     *
     * 에이전트를 이어서 띄우는 데만 쓴다. **한 번만** 쓴다 — 재시작(P1-4)은
     * 사용자가 셸을 원한 것이지 대화를 되살려 달라는 뜻이 아니다.
     */
    private resume: string | null,
    private readonly emit: {
      data(id: string, chunk: string): void
      meta(id: string): void
      exit(info: SessionExitInfo): void
      notify(id: string, text: string): void
      /** 셸이 디렉토리를 옮겼다 — git 정보를 다시 봐야 한다. P13-7 */
      cwdChanged(previousCwd: string): void
    }
  ) {
    const resolved = resolveCwd(options.cwd, defaultCwd)
    this.cwd = resolved.cwd
    this.warning = resolved.warning
    this.shell = options.shell ?? ''
    this.userTitle = options.title ?? null
    this.cols = clampCols(options.cols)
    this.rows = clampRows(options.rows)

    if (restoredScrollback) {
      // 복원된 것은 텍스트일 뿐 프로세스가 아니다. 새 셸의 출력과 섞이지 않게
      // 구분선을 긋는다 — 이전 화면인 척 하면 안 된다. P16-6
      this.replay = restoredScrollback + RESTORE_DIVIDER
      this.restored = true
    }

    this.state = new SessionState({
      onChange: () => this.emit.meta(this.id),
      onNotify: (text) => this.emit.notify(this.id, text),
      onCwd: (cwd) => {
        if (!cwd || cwd === this.cwd) return
        const previous = this.cwd
        this.cwd = cwd
        // 새 디렉토리는 다른 저장소일 수 있다. 낡은 git 정보를 그대로 두지 않는다. P13-7
        this.git = null
        this.emit.cwdChanged(previous)
        this.emit.meta(this.id)
      }
    })
  }

  get alive(): boolean {
    return this.proc !== null
  }

  /** 포트 조사에서 프로세스 트리의 루트로 쓴다. P14-8 */
  get pid(): number | null {
    return this.proc?.pid ?? null
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
      const proc = pty.spawn(shell, shellArgs(shell, this.restored, this.resume), {
        name: 'xterm-256color',
        cols: this.cols,
        rows: this.rows,
        cwd: this.cwd,
        useConpty: true,
        env: buildEnv(this.id, this.sessionEnv)
      })

      this.proc = proc
      this.startedAt = Date.now()
      // 이어서 띄우기는 복원할 때 한 번뿐이다. P22-8
      this.resume = null
      // 셸이 뜨는 동안 오는 클리어만 막는다. 그 뒤의 Clear-Host는 사용자 의도다. P16-6
      if (this.restored) this.stripClearUntil = this.startedAt + 1500

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

  private onData(rawChunk: string): void {
    if (this.disposed) return

    let chunk = rawChunk
    if (this.stripClearUntil > 0) {
      if (Date.now() < this.stripClearUntil) {
        chunk = stripScreenClear(chunk)
      } else {
        this.stripClearUntil = 0
      }
    }

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

  /** 디스크에 남길 스크롤백. P16-5 */
  get replayText(): string {
    return this.replay
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
      git: this.git,
      ports: this.ports,
      shells: this.shells,
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

function buildEnv(sessionId: string, extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') env[key] = value
  }
  // 터미널의 능력은 세션이 결정한다 — 런처가 물려준 값이 아니라. P3-8
  env.TERM = 'xterm-256color'
  env.COLORTERM = 'truecolor'

  /*
   * 런처의 색상 정책이 세션으로 새어들지 않게 한다 (P3-7).
   *
   * 다른 에이전트 CLI 안에서 cvmux를 띄우면 그 CLI가 자식 셸에 심어둔
   * NO_COLOR=1을 Electron이 상속하고, 그게 다시 PTY로 흘러 세션 안의 모든
   * 도구가 흑백이 된다. cvmux 세션은 트루컬러를 완전히 지원하는 새 터미널이므로
   * 그 제약을 물려받을 이유가 없다. 정말 색을 끄고 싶으면 CVMUX_NO_COLOR로 말한다.
   */
  if (process.env.CVMUX_NO_COLOR === '1') {
    env.NO_COLOR = '1'
  } else {
    delete env.NO_COLOR
  }

  /*
   * 런처가 Electron 앱이면 세션이 그 부팅 방식을 물려받는다 (P3-9).
   *
   * NO_COLOR과 같은 부류다. 에이전트 CLI 안에서 cvmux를 띄우면
   * `ELECTRON_RUN_AS_NODE=1`이 그대로 흘러들고, 그러면 세션 안에서 실행한
   * Electron 앱이 창 대신 Node 스크립트로 뜬다 — 실제로 이 프로젝트를
   * 개발하다 겪었다. cvmux 세션은 앱을 앱으로 띄우는 보통 터미널이다.
   */
  delete env.ELECTRON_RUN_AS_NODE
  // 에이전트 훅이 자신이 cvmux 안에서 도는지 알 수 있게 한다
  env.CVMUX = '1'
  env.CVMUX_SESSION_ID = sessionId

  /*
   * 제어 소켓 주소 (P20-3).
   *
   * 세션 안에서 `cvmux`를 부르면 인자 없이도 앱을 찾고 자기 세션을 가리킨다.
   * 마지막에 얹으므로 사용자 환경의 같은 이름을 덮는다 — 지금 도는 앱이
   * 언제나 옳다.
   */
  for (const [key, value] of Object.entries(extra)) {
    if (key === CLI_DIR_KEY) continue
    env[key] = value
  }

  /*
   * CLI를 세션 PATH에 얹는다 (P20-1).
   *
   * 시스템 PATH는 건드리지 않는다 — 설치 프로그램이 사용자 환경을 고쳐 놓고
   * 지우지 않는 일을 만들고 싶지 않다. cvmux 세션 안에서만 `cvmux`가 보이면
   * 되고, 실제로 이 CLI를 부르는 것은 세션 안에서 도는 에이전트다.
   */
  const cliDir = extra[CLI_DIR_KEY]
  if (cliDir) {
    const pathKey = Object.keys(env).find((k) => k.toLowerCase() === 'path') ?? 'Path'
    const current = env[pathKey] ?? ''
    if (!current.toLowerCase().split(';').includes(cliDir.toLowerCase())) {
      env[pathKey] = current ? `${cliDir};${current}` : cliDir
    }
  }
  return env
}

/** `setSessionEnv`로 들어오지만 환경변수가 아니라 PATH 조작 지시다. P20-1 */
export const CLI_DIR_KEY = 'CVMUX_CLI_DIR'

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
  private readonly defaultCwd: string
  /** 모든 세션이 공유하는 추가 환경변수. 소켓이 열리면 여기에 주소가 들어온다. P20-3 */
  private readonly sessionEnv: Record<string, string> = {}
  /** 설정이 정한 셸. 비어 있으면 pwsh → powershell → cmd 순으로 찾는다. P22-2 */
  private defaultShell: string | undefined
  /** 복원할 때 에이전트를 이어서 띄울 것인가. P22-8 */
  private autoResume = true

  constructor(options: PtyManagerOptions = {}) {
    super()
    this.defaultCwd = options.defaultCwd ?? homedir()
  }

  /**
   * 세션 환경에 값을 더한다 (P20-3).
   *
   * 덮어쓰지 않고 채워 넣는다 — 객체 하나를 모든 세션이 나눠 보고 있으므로
   * 통째로 갈아치우면 이미 만들어진 세션이 낡은 것을 붙잡는다.
   */
  setSessionEnv(env: Record<string, string>): void {
    Object.assign(this.sessionEnv, env)
  }

  /**
   * 설정에서 오는 값을 반영한다 (P22-2).
   *
   * 셸은 **다음에 만드는 세션부터** 바뀐다. 이미 도는 셸을 갈아 끼울 수는
   * 없고, 그러려 드는 것은 사용자가 원한 일도 아니다.
   */
  setDefaults(config: CvmuxConfig): void {
    this.defaultShell = config.terminal.shell ?? undefined
    this.autoResume = config.terminal.autoResumeAgentSessions
  }

  /** git·포트 정보를 주기적으로 채운다. P13 / P14 */
  private readonly probes = new ProbeScheduler(
    () =>
      [...this.sessions.values()].map((s) => ({
        id: s.id,
        pid: s.pid,
        cwd: s.cwd,
        alive: s.alive,
        busy: s.state.status === 'busy'
      })),
    (id, patch) => {
      const session = this.sessions.get(id)
      if (!session) return

      let changed = false
      if (patch.git !== undefined && !gitInfoEqual(session.git, patch.git)) {
        session.git = patch.git
        changed = true
      }
      if (patch.ports !== undefined && !portsEqual(session.ports, patch.ports)) {
        session.ports = patch.ports
        changed = true
      }
      if (patch.shells !== undefined && !shellsEqual(session.shells, patch.shells)) {
        session.shells = patch.shells
        changed = true
      }
      // 값이 그대로면 IPC를 보내지 않는다. 폴링이 렌더러를 매초 흔들면 안 된다
      if (changed) this.emit('meta', session.toMeta())
    }
  )

  create(options: CreateSessionOptions = {}): CreateSessionResult {
    return this.spawn(options, null)
  }

  private spawn(
    options: CreateSessionOptions,
    restoredScrollback: string | null,
    resume: string | null = null
  ): CreateSessionResult {
    // 상한 초과는 예외가 아니라 사유가 담긴 실패다. P1-8 / P8-3 / P12
    if (this.sessions.size >= POLICY.MAX_SESSIONS) {
      return {
        ok: false,
        error: `세션은 최대 ${POLICY.MAX_SESSIONS}개까지 열 수 있습니다. 사용하지 않는 세션을 닫아 주세요.`
      }
    }

    const session = new Session(
      options,
      this.defaultCwd,
      restoredScrollback,
      this.sessionEnv,
      resume,
      {
        data: (id, chunk) => this.emit('data', id, chunk),
        meta: (id) => {
          const s = this.sessions.get(id)
          if (s) this.emit('meta', s.toMeta())
        },
        exit: (info) => this.emit('exit', info),
        notify: (id, text) => this.emit('notify', id, text),
        cwdChanged: (previousCwd) => this.probes.invalidateCwd(previousCwd)
      }
    )

    this.sessions.set(session.id, session)
    session.start(this.defaultShell)
    // 세션이 없는 동안 프로브는 자고 있다. P14-6
    this.probes.wake()

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

  metaOf(id: string): SessionMeta | null {
    return this.sessions.get(id)?.toMeta() ?? null
  }

  /** 디스크에 남길 형태로 뽑는다. P16-1 */
  serialize(): PersistedSession[] {
    return [...this.sessions.values()]
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((session) => ({
        cwd: session.cwd,
        // 셸이 설정한 제목은 새 셸이 다시 알려준다. 사용자가 지은 이름만 지킨다
        title: session.userTitle,
        scrollback: trimScrollback(session.replayText)
      }))
  }

  /**
   * 저장된 세션을 되살린다. 프로세스가 아니라 자리(작업 디렉토리)와 화면을 복원한다.
   *
   * @returns 입력과 같은 길이의 배열. 각 자리에 새 세션 id, 복원하지 못했으면 null.
   *          저장된 pane 배치가 세션을 **순번**으로 가리키므로 자리를 맞춰 돌려준다.
   */
  restore(sessions: PersistedSession[]): Array<string | null> {
    return sessions.map((item) => {
      // 상한을 넘으면 조용히 멈춘다. P16-7
      if (this.sessions.size >= POLICY.MAX_SESSIONS) return null

      /*
       * 에이전트를 이어서 띄운다 (P22-8).
       *
       * 명령은 우리가 아는 에이전트 표에서만 만든다. 저장 파일에 적힌 문자열을
       * 그대로 실행하지 않는다 — 파일을 손으로 고친 사람이 자기도 모르게
       * 명령을 심는 자리가 되면 안 된다.
       */
      const resume =
        this.autoResume && item.agent
          ? resumeCommand({
              sessionId: '',
              agent: item.agent.name,
              agentSessionId: item.agent.sessionId,
              cwd: item.cwd,
              updatedAt: 0
            })
          : null

      // 사라진 디렉토리는 resolveCwd가 폴백하고 경고를 남긴다. P16-4
      const result = this.spawn(
        { cwd: item.cwd, title: item.title ?? undefined },
        item.scrollback || null,
        resume
      )
      return result.ok && result.session ? result.session.id : null
    })
  }

  /** 저장할 때 pane 배치가 참조할 세션 순서 */
  sessionOrder(): string[] {
    return [...this.sessions.values()]
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((s) => s.id)
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
    const ok = session.restart()
    if (ok) this.probes.wake()
    return ok
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

  /** 소켓으로 들어온 알림을 세션에 꽂는다. P20-5 */
  notify(id: string, text: string): boolean {
    const session = this.sessions.get(id)
    if (!session) return false
    session.state.notifyExternal(text)
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
    this.probes.stop()
    const all = [...this.sessions.values()]
    this.sessions.clear()
    await Promise.all(all.map((s) => s.dispose()))
  }
}

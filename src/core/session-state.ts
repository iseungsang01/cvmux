import { POLICY } from '@shared/policy'
import type { SessionStatus, StatusConfidence } from '@shared/types'
import { AnsiParser } from './ansi-parser'

/**
 * 세션 상태 판정 엔진 (POLICY.md P4).
 *
 * 신호 우선순위:
 *   1. OSC 9 / 777 / 99 / BEL          → attention   (확실)
 *   2. 프로세스 종료                     → exited     (확실)
 *   3. OSC 133 셸 통합 마커              → busy/idle  (확실)
 *   4. 프롬프트 정규식 + 유휴 타이머       → idle/waiting (추측)
 *   5. 출력 흐름 유무                    → busy       (추측)
 *
 * 확실한 신호와 추측을 confidence로 구분해 UI가 다르게 표현할 수 있게 한다(P0-3).
 */

/**
 * 프롬프트로 "끝나는" 줄 패턴. 판정은 항상 커서가 놓인 마지막 줄에만 적용하고,
 * 줄 끝이 프롬프트여야 한다 — 출력 중간의 `>`에 반응하지 않기 위함(P4-12).
 */
const PROMPT_EXACT: RegExp[] = [
  /^PS\s+\S[^\r\n]*>\s?$/, // Windows PowerShell / pwsh 기본 프롬프트
  /^[A-Za-z]:\\[^\r\n>]*>\s?$/, // cmd.exe
  /[$#]\s$/, // bash / zsh / sh
  /[❯➜»▶]\s?$/, // starship, oh-my-posh, powerlevel10k
  /^>>>\s$/, // python REPL
  /^>\s$/ // node REPL 등
]

/** 프롬프트 뒤에 사용자가 타이핑을 이어가고 있는 형태 (P4-11) */
const PROMPT_TYPING: RegExp[] = [
  /^PS\s+\S[^\r\n]*>\s?\S/,
  /^[A-Za-z]:\\[^\r\n>]*>\s?\S/,
  /[$#]\s\S/,
  /[❯➜»▶]\s\S/
]

function promptKind(line: string): 'exact' | 'typing' | 'no' {
  if (line.length === 0) return 'no'
  if (PROMPT_EXACT.some((re) => re.test(line))) return 'exact'
  if (PROMPT_TYPING.some((re) => re.test(line))) return 'typing'
  return 'no'
}

export interface SessionStateHooks {
  /** 상태/미리보기 등 메타가 바뀌어 렌더러에 알려야 할 때 */
  onChange(): void
  /** 명시적 알림을 받았을 때 (OS 알림 등에 쓸 수 있음) */
  onNotify(text: string): void
  /** 셸이 OSC 7로 작업 디렉토리를 보고했을 때 */
  onCwd(cwd: string): void
}

export class SessionState {
  status: SessionStatus = 'busy'
  confidence: StatusConfidence = 'inferred'
  /** 명시적 알림을 받았고 사용자가 아직 보지 않음. P4-1 / P4-4 */
  unread = false
  /** 대체 화면 버퍼(vim/less/htop) 안. 프롬프트 휴리스틱이 무의미하다. P4-9 */
  altScreen = false
  /** 셸이 OSC 0/2로 설정한 제목. P5-8 */
  shellTitle: string | null = null
  /** 마지막 알림 텍스트 — 미리보기에 우선 표시된다 */
  notification: string | null = null

  private readonly parser: AnsiParser
  private idleTimer: NodeJS.Timeout | null = null
  private dirtyTimer: NodeJS.Timeout | null = null
  private lastBellAt = 0
  private suppressUntil = 0
  /** 마지막으로 사용자가 키를 누른 시각 — 뒤따르는 출력이 에코인지 가른다. P4-15 */
  private lastInputAt = 0
  /** 셸이 OSC 133을 보내고 있는가 — 그렇다면 정규식 휴리스틱을 쓰지 않는다 */
  private shellIntegration = false
  private commandRunning = false
  private disposed = false

  constructor(private readonly hooks: SessionStateHooks) {
    this.parser = new AnsiParser({
      onOsc: (body) => this.handleOsc(body),
      onBell: () => this.handleBell(),
      onCsi: (params, final) => this.handleCsi(params, final),
      onLine: () => this.markDirty()
    })
  }

  /** 사이드바에 보여줄 한 줄. 알림이 있으면 알림이 우선. P4-13 */
  get preview(): string {
    const raw = this.notification ?? this.parser.previewLine
    const clean = raw.replace(/\s+/g, ' ').trim()
    return clean.length > POLICY.PREVIEW_MAX_CHARS
      ? `${clean.slice(0, POLICY.PREVIEW_MAX_CHARS - 1)}…`
      : clean
  }

  /** PTY 출력 수신. P4-6 */
  ingest(chunk: string): void {
    if (this.disposed) return

    const now = Date.now()
    // busy를 먼저 세우고 파싱한다. 순서가 반대면 청크 안의 OSC 9/133이
    // attention/idle을 설정한 직후 busy가 덮어써서 알림이 통째로 사라진다.
    // 출력이 흘렀으니 busy, 단 그 출력에 명시적 신호가 있으면 그쪽이 이긴다. P4-1 / P4-6
    if (this.status !== 'exited' && now >= this.suppressUntil && !this.isEcho(now)) {
      // 리사이즈 직후의 reflow 출력은 상태 전이를 일으키지 않는다. P2-4
      this.set('busy', 'inferred')
    }

    this.parser.write(chunk)
    this.markDirty()
    this.armIdle()
  }

  /**
   * 내가 방금 친 글자가 되비친 것인가 (P4-15).
   *
   * 셸도 에이전트 CLI도 키를 누를 때마다 입력 줄을 통째로 다시 그린다. 그
   * 출력까지 "일이 돌아간다"로 세면 타이핑하는 내내 신호등이 깜빡인다 —
   * 한 글자마다 초록으로 올라갔다가 400ms 침묵마다 빨강으로 내려오기 때문이다.
   * 내가 친 글자가 화면에 나타난 것은 아무 일도 아니다.
   *
   * 에코를 걷어내도 명시적 신호는 그대로 지나간다. 엔터를 눌러 명령을
   * 시작하면 셸 통합이 같은 청크에 실어 보내는 133;C가 즉시 초록을 켠다 —
   * 이 판정은 5순위(출력 흐름)에만 적용된다.
   */
  private isEcho(now: number): boolean {
    return now - this.lastInputAt < POLICY.ECHO_WINDOW_MS
  }

  /** 사용자 입력. 타이핑 중 waiting으로 튀지 않도록 유휴 타이머를 리셋한다. P4-11 */
  noteInput(): void {
    if (this.disposed || this.status === 'exited') return
    this.lastInputAt = Date.now()
    this.armIdle()
  }

  /** 리사이즈 발생 — 뒤따르는 reflow 출력을 잠시 무시한다. P2-4 */
  noteResize(): void {
    this.suppressUntil = Date.now() + POLICY.RESIZE_SUPPRESS_MS
  }

  /** 프로세스 종료 — 가장 확실한 신호 중 하나. P1-1 ~ P1-3 */
  noteExit(): void {
    this.clearIdle()
    this.set('exited', 'certain')
  }

  /** 세션 재시작 — 파서와 상태를 초기화한다. P1-4 */
  reset(): void {
    this.parser.reset()
    this.unread = false
    this.altScreen = false
    this.notification = null
    this.shellIntegration = false
    this.commandRunning = false
    this.suppressUntil = 0
    this.lastInputAt = 0
    this.set('busy', 'inferred')
  }

  /** 사용자가 세션을 봤다. 미읽음 해제 후 상태 재평가. P4-5 */
  markRead(): void {
    if (!this.unread && this.notification === null) return
    this.unread = false
    this.notification = null
    if (this.status === 'attention') this.evaluateIdle()
    this.flush()
  }

  dispose(): void {
    this.disposed = true
    this.clearIdle()
    if (this.dirtyTimer) {
      clearTimeout(this.dirtyTimer)
      this.dirtyTimer = null
    }
  }

  // ── 신호 처리 ────────────────────────────────────────────────

  private handleOsc(body: string): void {
    const semi = body.indexOf(';')
    const code = semi === -1 ? body : body.slice(0, semi)
    const rest = semi === -1 ? '' : body.slice(semi + 1)

    switch (code) {
      // 터미널 제목 설정. 사용자 지정 제목이 있으면 pty-manager가 무시한다. P5-8
      case '0':
      case '1':
      case '2':
        this.shellTitle = rest.trim() || null
        this.markDirty()
        break

      // iTerm2 스타일 알림. 단 ConEmu는 같은 번호를 진행률에 쓴다. P4-1
      case '9':
        if (/^4(;|$)/.test(rest)) break // ConEmu progress — 알림이 아니다
        this.notify(rest)
        break

      // 777;notify;<title>;<body>. P4-2
      case '777': {
        const parts = rest.split(';')
        if (parts[0] !== 'notify') break
        const title = (parts[1] ?? '').trim()
        const text = parts.slice(2).join(';').trim()
        this.notify(text ? `${title}: ${text}` : title)
        break
      }

      // kitty 알림 프로토콜 99;<metadata>;<payload>. P4-2
      case '99': {
        const idx = rest.indexOf(';')
        const payload = (idx === -1 ? rest : rest.slice(idx + 1)).trim()
        if (payload) this.notify(payload)
        break
      }

      // OSC 7 — 셸이 보고하는 작업 디렉토리 (file:///C:/path)
      case '7': {
        const cwd = parseFileUrl(rest)
        if (cwd) this.hooks.onCwd(cwd)
        break
      }

      // OSC 133 셸 통합 — 프롬프트/명령 경계를 셸이 직접 알려준다 (3순위, 확실)
      case '133':
        this.handleShellIntegration(rest)
        break

      default:
        break
    }
  }

  private handleShellIntegration(rest: string): void {
    const kind = rest[0]
    this.shellIntegration = true
    if (kind === 'C') {
      // 명령 실행 시작
      this.commandRunning = true
      this.set('busy', 'certain')
    } else if (kind === 'D') {
      // 명령 종료 — 프롬프트로 돌아온다
      this.commandRunning = false
      if (!this.unread) this.set('idle', 'certain')
    } else if (kind === 'A' || kind === 'B') {
      this.commandRunning = false
    }
  }

  /** 단독 BEL. 진행률 표시줄이 남발하는 경우를 대비해 합친다. P4-3 */
  private handleBell(): void {
    const now = Date.now()
    if (now - this.lastBellAt < POLICY.BELL_COALESCE_MS) return
    this.lastBellAt = now
    this.notify('')
  }

  private handleCsi(params: string, final: string): void {
    // 대체 화면 버퍼 진입/이탈. P4-9
    if (final === 'h' || final === 'l') {
      if (params === '?1049' || params === '?1047' || params === '?47') {
        const next = final === 'h'
        if (next !== this.altScreen) {
          this.altScreen = next
          this.markDirty()
        }
      }
    }
  }

  private notify(text: string): void {
    if (this.status === 'exited') return
    this.notification = text.trim() || null
    this.unread = true
    this.set('attention', 'certain')
    this.hooks.onNotify(this.notification ?? '')
  }

  // ── 유휴 판정 ────────────────────────────────────────────────

  private armIdle(): void {
    this.clearIdle()
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null
      this.evaluateIdle()
    }, POLICY.IDLE_THRESHOLD_MS)
  }

  private clearIdle(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
  }

  private evaluateIdle(): void {
    if (this.disposed || this.status === 'exited') return

    // 미읽음 알림이 있으면 사용자가 볼 때까지 attention을 유지한다. P4-1
    if (this.unread) {
      this.set('attention', 'certain')
      return
    }

    /*
     * 전체화면 TUI 안에서는 프롬프트 개념이 없다 — 정규식 휴리스틱을 쓸 수 없다.
     *
     * 그렇다고 busy로 고정하면 P4-14와 똑같은 함정에 빠진다. claude·codex 같은
     * 에이전트 CLI는 시작하자마자 `?1049h`로 대체 화면에 들어가 몇 시간이고
     * 머무르므로, 화면 안에 있다는 것만으로 초록을 유지하면 점이 영영 꺼지지
     * 않는다. 게다가 이 분기가 셸 통합 분기보다 먼저 걸려서 P4-14의 판정 자체가
     * 무의미해진다.
     *
     * 여기까지 왔다는 것은 이미 400ms 동안 아무것도 그려지지 않았다는 뜻이다.
     * 전체화면 TUI가 화면을 멈췄으면 그리는 일이 끝난 것이고, 남은 것은
     * 사용자 차례다. vim도 htop도 같다 — 편집 중이면 키마다 출력이 흐르고,
     * 주기적으로 갱신하는 화면은 계속 busy로 남는다. P4-9 / P4-14
     */
    if (this.altScreen) {
      this.set('waiting', 'inferred')
      return
    }

    /*
     * 셸이 OSC 133을 보내면 그것이 정규식보다 정확하다.
     *
     * 다만 "명령이 떠 있다"와 "무언가 진행 중이다"는 다르다. 에이전트 CLI를
     * 띄워두면 명령은 몇 시간이고 살아 있으므로, commandRunning만 보고 busy를
     * 유지하면 초록 점이 영영 꺼지지 않는다 — 정작 일이 돌아갈 때와 구분되지
     * 않아 신호가 통째로 죽는다. 출력이 멎었으면 조용한 것이다(P4-14).
     */
    if (this.shellIntegration) {
      if (!this.commandRunning) {
        this.set('idle', 'certain')
        return
      }
      this.set('waiting', 'certain')
      return
    }

    /*
     * 커서가 놓인 줄이 비어 있으면 마지막으로 확정된 줄을 본다.
     *
     * 셸이 프롬프트를 그린 뒤 화면을 정리하느라 개행을 흘리면 "현재 줄"은
     * 비어버리지만, 화면에는 프롬프트가 그대로 있다. 그때 마지막 줄이 곧
     * 프롬프트다. 판정 대상이 버퍼의 마지막 줄이라는 점은 그대로다. P4-12
     */
    const kind = promptKind(this.parser.previewLine)
    // exact = 프롬프트에서 대기, typing = 사용자가 명령을 치는 중 → 둘 다 idle. P4-7 / P4-11
    this.set(kind === 'no' ? 'waiting' : 'idle', 'inferred')
  }

  // ── 변경 통지 ────────────────────────────────────────────────

  private set(status: SessionStatus, confidence: StatusConfidence): void {
    if (this.status === status && this.confidence === confidence) return
    this.status = status
    this.confidence = confidence
    this.flush() // 상태 변화는 즉시 알린다
  }

  /** 미리보기처럼 자주 바뀌는 값은 100ms로 묶어 IPC를 아낀다 */
  private markDirty(): void {
    if (this.disposed || this.dirtyTimer) return
    this.dirtyTimer = setTimeout(() => {
      this.dirtyTimer = null
      this.hooks.onChange()
    }, 100)
  }

  private flush(): void {
    if (this.disposed) return
    if (this.dirtyTimer) {
      clearTimeout(this.dirtyTimer)
      this.dirtyTimer = null
    }
    this.hooks.onChange()
  }
}

/** `file:///C:/Users/me` → `C:\Users\me` */
function parseFileUrl(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed.startsWith('file://')) return null
  try {
    const url = new URL(trimmed)
    let p = decodeURIComponent(url.pathname)
    if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1)
    return p.replace(/\//g, '\\')
  } catch {
    return null
  }
}

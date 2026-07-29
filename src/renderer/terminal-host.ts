import { FitAddon } from '@xterm/addon-fit'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { WebglAddon } from '@xterm/addon-webgl'
import { Terminal } from '@xterm/xterm'

import { POLICY } from '@shared/policy'
import type { ClipboardContent, SessionStatus } from '@shared/types'

/** Ctrl+V / Ctrl+Shift+V — 이 플랫폼에서 붙여넣기를 뜻하는 조합. P7-4 */
function isPasteChord(event: KeyboardEvent): boolean {
  return event.ctrlKey && !event.altKey && !event.metaKey && event.code === 'KeyV'
}

/**
 * 한 터미널이 WebGL 컨텍스트를 다시 잡아 보는 횟수의 상한 (P5-10).
 *
 * 브라우저가 컨텍스트를 회수하는 상황은 대개 컨텍스트가 모자란 상황이다.
 * 그런 자리에서 무한정 다시 잡으려 들면 잡자마자 또 잃는 일이 되풀이되므로,
 * 몇 번 겪은 터미널은 DOM 렌더러에 눌러앉힌다 — 느릴지언정 멀쩡히 그린다.
 */
const MAX_CONTEXT_LOSSES = 2

/**
 * xterm 인스턴스의 수명을 React 바깥에서 관리한다 (P5-1).
 *
 * 세션을 전환할 때 인스턴스를 버리면 스크롤백과 커서 위치가 함께 사라진다.
 * 그래서 인스턴스는 세션이 닫힐 때까지 살려두고, 화면에서는 CSS로만 감춘다.
 */

const THEME = {
  background: '#0d1016',
  foreground: '#d3d9e3',
  cursor: '#7aa2f7',
  cursorAccent: '#0d1016',
  selectionBackground: '#2b3a5c',
  black: '#171b23',
  red: '#f7768e',
  green: '#9ece6a',
  yellow: '#e0af68',
  blue: '#7aa2f7',
  magenta: '#bb9af7',
  cyan: '#7dcfff',
  white: '#a9b1d6',
  brightBlack: '#4a5570',
  brightRed: '#ff8ea1',
  brightGreen: '#b9f27c',
  brightYellow: '#ffc777',
  brightBlue: '#8fb4ff',
  brightMagenta: '#cba6f7',
  brightCyan: '#9ae0ff',
  brightWhite: '#e6ebf4'
}

export interface TerminalHostCallbacks {
  onInput(id: string, data: string): void
  onResize(id: string, cols: number, rows: number): void
  /** 종료된 세션에서 Enter를 눌렀다. P1-4 / P6-6 */
  onRestartRequest(id: string): void
  /** 앱 단축키인가 — true면 터미널에 전달하지 않는다. P6-3 */
  isAppShortcut(event: KeyboardEvent): boolean
}

interface Entry {
  id: string
  term: Terminal
  fit: FitAddon
  webgl: WebglAddon | null
  container: HTMLElement | null
  opened: boolean
  observer: ResizeObserver | null
  fitTimer: number | null
  cols: number
  rows: number
  status: SessionStatus
  /** 재생 데이터를 붙이기 전에 도착한 실시간 출력. 순서를 지키려고 큐에 담는다. P9-1 / P0-2 */
  queue: string[] | null
  cleanup: Array<() => void>
  /** 지금 화면에 보이는가 — WebGL 컨텍스트를 쥘 자격의 기준이다. P5-10 */
  visible: boolean
  /** WebGL 컨텍스트를 잃은 횟수. 상한에 닿으면 다시 잡지 않는다. P5-10 */
  contextLosses: number
}

export class TerminalHost {
  private readonly entries = new Map<string, Entry>()
  private dpr = window.devicePixelRatio

  constructor(private readonly callbacks: TerminalHostCallbacks) {
    this.watchDevicePixelRatio()
  }

  has(id: string): boolean {
    return this.entries.has(id)
  }

  /** 컨테이너에 붙인다. 이미 열린 인스턴스는 DOM만 옮겨 붙여 내용을 보존한다. P5-1 */
  attach(id: string, container: HTMLElement): void {
    const entry = this.ensure(id)
    if (entry.container === container) return

    if (!entry.opened) {
      entry.term.open(container)
      entry.opened = true
      // WebGL은 보이는 터미널만 쥔다 — 붙이는 일은 setVisible이 맡는다. P5-10
      if (entry.visible) this.enableWebgl(entry)
      this.bindPaste(entry, container)
    } else if (entry.term.element && entry.term.element.parentElement !== container) {
      container.appendChild(entry.term.element)
    }

    entry.container = container
    entry.observer?.disconnect()
    const observer = new ResizeObserver(() => this.scheduleFit(entry))
    observer.observe(container)
    entry.observer = observer
    this.scheduleFit(entry)
  }

  /**
   * main의 재생 버퍼로 화면을 되살린다 (P9-1).
   * 재생 중 도착한 실시간 출력은 큐에 모았다가 뒤에 이어 붙여 순서를 지킨다.
   */
  async hydrate(id: string): Promise<void> {
    const entry = this.ensure(id)
    if (entry.queue === null) return

    let replay = ''
    try {
      const snapshot = await window.cvmux.snapshot(id)
      replay = snapshot?.replay ?? ''
    } catch {
      // 세션이 그새 사라졌다 — 큐만 흘려보낸다
    }

    if (replay) entry.term.write(replay)
    const queued = entry.queue
    entry.queue = null
    for (const chunk of queued) entry.term.write(chunk)
  }

  write(id: string, chunk: string): void {
    const entry = this.entries.get(id)
    if (!entry) return
    if (entry.queue) {
      entry.queue.push(chunk)
      return
    }
    entry.term.write(chunk)
  }

  setStatus(id: string, status: SessionStatus): void {
    const entry = this.entries.get(id)
    if (entry) entry.status = status
  }

  focus(id: string): void {
    const entry = this.entries.get(id)
    if (!entry?.container) return
    // 숨김 → 표시 직후에는 레이아웃이 아직 없다. 다음 프레임에 맞춘다. P2-3
    requestAnimationFrame(() => {
      this.applyFit(entry)
      entry.term.focus()
    })
  }

  /** 사이드바 토글처럼 애니메이션이 끝난 뒤 호출한다. P5-5 */
  refit(id: string): void {
    const entry = this.entries.get(id)
    if (entry) this.scheduleFit(entry)
  }

  /**
   * 이 세션이 화면에 보이는지 알린다 (P5-10).
   *
   * 세션마다 WebGL 컨텍스트를 하나씩 쥐고 있으면, 보이지도 않는 워크스페이스의
   * 터미널들이 GPU 메모리를 그대로 붙들고 있게 된다. 게다가 브라우저가 한 번에
   * 살려두는 컨텍스트 수에는 상한이 있어서, 세션을 여닫다 보면 오래된 것부터
   * 조용히 회수당한다 — 그 터미널은 그때부터 느린 DOM 렌더러로 떨어진다.
   *
   * 그래서 컨텍스트는 보이는 터미널에게만 준다. xterm 인스턴스 자체는 그대로
   * 살아 있으므로(P5-1) 스크롤백도 커서도 잃지 않고, 다시 보일 때 컨텍스트만
   * 새로 잡는다.
   */
  setVisible(id: string, visible: boolean): void {
    const entry = this.entries.get(id)
    if (!entry || entry.visible === visible) return
    entry.visible = visible
    if (visible) this.enableWebgl(entry)
    else this.releaseWebgl(entry)
  }

  dispose(id: string): void {
    const entry = this.entries.get(id)
    if (!entry) return
    this.entries.delete(id)
    if (entry.fitTimer !== null) window.clearTimeout(entry.fitTimer)
    entry.observer?.disconnect()
    for (const fn of entry.cleanup) fn()
    this.releaseWebgl(entry)
    entry.term.dispose()
  }

  disposeAll(): void {
    for (const id of [...this.entries.keys()]) this.dispose(id)
  }

  // ── 내부 ─────────────────────────────────────────────────────

  private ensure(id: string): Entry {
    const existing = this.entries.get(id)
    if (existing) return existing

    const term = new Terminal({
      fontFamily: '"Cascadia Mono", "Cascadia Code", Consolas, "D2Coding", monospace',
      fontSize: 13,
      lineHeight: 1.25,
      letterSpacing: 0,
      scrollback: POLICY.SCROLLBACK_LINES, // P3-6 / P8-1
      cursorBlink: true,
      cursorStyle: 'bar',
      // drawBoldTextInBrightColors는 기본값(true)을 쓴다. 끄면 chalk/ink 기반 CLI가
      // 볼드+색으로 표현하는 강조가 어두운 원색으로 렌더링돼 화면이 칙칙해진다.
      allowProposedApi: true,
      macOptionIsMeta: false,
      theme: THEME
    })

    const fit = new FitAddon()
    term.loadAddon(fit)

    // 한글·이모지 폭 계산을 유니코드 11 기준으로 (기본은 6 기준이라 폭이 틀어진다)
    try {
      const unicode11 = new Unicode11Addon()
      term.loadAddon(unicode11)
      term.unicode.activeVersion = '11'
    } catch {
      // 실패해도 치명적이지 않다
    }

    const entry: Entry = {
      id,
      term,
      fit,
      webgl: null,
      container: null,
      opened: false,
      observer: null,
      fitTimer: null,
      cols: 0,
      rows: 0,
      status: 'busy',
      queue: [],
      cleanup: [],
      visible: false,
      contextLosses: 0
    }

    const dataSub = term.onData((data) => {
      // 종료된 세션에는 입력을 보내지 않는다. Enter 재시작은 키 핸들러가 처리. P6-6
      if (entry.status === 'exited') return
      this.callbacks.onInput(id, data)
    })
    entry.cleanup.push(() => dataSub.dispose())

    term.attachCustomKeyEventHandler((event) => {
      if (event.type !== 'keydown') return true

      // 앱 단축키는 셸로 내려보내지 않는다. Ctrl+C 같은 셸 키는 여기 걸리지 않는다. P6-1 / P6-3
      if (this.callbacks.isAppShortcut(event)) return false

      /*
       * 붙여넣기는 우리가 처리한다 (P7-4).
       *
       * `preventDefault`가 반드시 필요하다. 핸들러가 `false`를 돌려주는 것은
       * xterm에게 "이 키는 네 몫이 아니다"라고 말할 뿐, 브라우저의 기본
       * 붙여넣기까지 막지는 못한다. 빼먹으면 같은 내용이 두 번 들어간다.
       */
      if (isPasteChord(event)) {
        event.preventDefault()
        void this.pasteFromClipboard(entry)
        return false
      }

      if (entry.status === 'exited') {
        if (event.key === 'Enter') this.callbacks.onRestartRequest(id)
        return false // 종료된 세션에서 나머지 키는 무시. P6-6
      }
      return true
    })

    this.entries.set(id, entry)
    return entry
  }

  /** WebGL 렌더러. 실패나 컨텍스트 손실은 조용히 DOM 렌더러로 폴백한다. P5-2 / P5-3 */
  private enableWebgl(entry: Entry): void {
    // 아직 열리지 않았거나, 이미 쥐고 있거나, 너무 여러 번 잃은 터미널은 건너뛴다. P5-10
    if (!entry.opened || entry.webgl || entry.contextLosses >= MAX_CONTEXT_LOSSES) return

    try {
      const webgl = new WebglAddon()
      webgl.onContextLoss(() => {
        entry.contextLosses += 1
        this.releaseWebgl(entry)
        /*
         * 보이는 중에 잃었다면 다시 잡아 본다 (P5-10).
         *
         * 예전에는 여기서 손을 놓아, 한 번 회수당한 터미널이 남은 수명 내내
         * DOM 렌더러로 남았다. 상한이 되풀이를 막아주므로 시도해도 안전하다.
         */
        if (entry.visible) this.enableWebgl(entry)
      })
      entry.term.loadAddon(webgl)
      entry.webgl = webgl
    } catch {
      entry.webgl = null
    }
  }

  /** 컨텍스트를 놓아준다. 렌더러는 xterm 기본값으로 돌아간다. P5-10 */
  private releaseWebgl(entry: Entry): void {
    if (!entry.webgl) return
    entry.webgl.dispose()
    entry.webgl = null
  }

  /**
   * 붙여넣기 (P7-4 / P7-5).
   *
   * xterm은 Windows에서 `Ctrl+V`를 붙여넣기로 보지 않는다 — `Ctrl`+글자를
   * 제어문자로 바꾸는 규칙을 따라 `0x16`을 셸로 흘려보낸다. 그래서 이 조합을
   * 가로채 클립보드를 직접 읽는다. Windows Terminal과 같은 손버릇을 지키기
   * 위함이다(P6-1의 "터미널이 우선"은 셸이 실제로 쓰는 키에 대한 이야기이고,
   * `Ctrl+V`는 이 플랫폼에서 붙여넣기다).
   */
  private async pasteFromClipboard(entry: Entry): Promise<void> {
    // 죽은 세션에는 아무것도 보내지 않는다. P6-6
    if (entry.status === 'exited') return

    let content: ClipboardContent
    try {
      content = await window.cvmux.readClipboard()
    } catch {
      return
    }

    if (!content.text) {
      /*
       * 텍스트가 없는 클립보드 — 이미지만 들어 있는 경우다 (P7-5).
       *
       * 터미널은 이미지를 실어 나를 수 없다. 대신 `Ctrl+V`를 원래 모습(0x16)
       * 그대로 흘려보내, 안에서 도는 프로그램이 스스로 클립보드를 읽게 한다.
       * Claude Code 같은 에이전트 CLI가 스크린샷을 첨부하는 길이 이것이다.
       */
      this.callbacks.onInput(entry.id, '\x16')
      return
    }

    const bytes = new Blob([content.text]).size
    if (bytes >= POLICY.PASTE_CONFIRM_BYTES) {
      const ok = await window.cvmux.confirmPaste(bytes) // P7-3
      if (!ok) return
    }
    // bracketed paste와 개행 정규화는 xterm이 맡는다. P7-1 / P7-2
    entry.term.paste(content.text)
  }

  /** 대용량 붙여넣기만 가로챈다. 그 아래 크기는 xterm이 bracketed paste·CRLF까지 알아서 처리한다. P7 */
  private bindPaste(entry: Entry, container: HTMLElement): void {
    const handler = (event: ClipboardEvent): void => {
      const text = event.clipboardData?.getData('text/plain') ?? ''
      if (!text) return
      const bytes = new Blob([text]).size
      if (bytes < POLICY.PASTE_CONFIRM_BYTES) return // P7-1 / P7-2는 xterm의 몫

      event.preventDefault()
      event.stopPropagation()
      void window.cvmux.confirmPaste(bytes).then((ok) => {
        if (ok) entry.term.paste(text) // P7-3
      })
    }
    // xterm보다 먼저 받아야 하므로 capture 단계에서 잡는다
    container.addEventListener('paste', handler, true)
    entry.cleanup.push(() => container.removeEventListener('paste', handler, true))
  }

  /** ConPTY resize는 비싸다 — 연속 호출을 묶는다. P2-2 */
  private scheduleFit(entry: Entry): void {
    if (entry.fitTimer !== null) window.clearTimeout(entry.fitTimer)
    entry.fitTimer = window.setTimeout(() => {
      entry.fitTimer = null
      this.applyFit(entry)
    }, POLICY.RESIZE_DEBOUNCE_MS)
  }

  private applyFit(entry: Entry): void {
    const el = entry.container
    // 숨겨진 pane은 크기가 0이다. 이 상태로 fit하면 1×1 터미널이 만들어진다. P2-3
    if (!el || el.clientWidth === 0 || el.clientHeight === 0) return

    try {
      entry.fit.fit()
    } catch {
      return
    }

    const { cols, rows } = entry.term
    if (cols === entry.cols && rows === entry.rows) return
    entry.cols = cols
    entry.rows = rows
    this.callbacks.onResize(entry.id, cols, rows)
  }

  /** 모니터를 옮기거나 배율이 바뀌면 셀 크기가 달라진다. P5-4 */
  private watchDevicePixelRatio(): void {
    const listen = (): void => {
      const mq = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`)
      const onChange = (): void => {
        if (window.devicePixelRatio !== this.dpr) {
          this.dpr = window.devicePixelRatio
          for (const entry of this.entries.values()) this.scheduleFit(entry)
        }
        listen()
      }
      mq.addEventListener('change', onChange, { once: true })
    }
    listen()
  }
}

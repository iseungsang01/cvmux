/**
 * cvmux 설정 (POLICY.md P22).
 *
 * cmux는 `~/.config/cmux/cmux.json`을 읽는다. cvmux도 같은 모양의 파일을
 * 쓰되 자리는 Windows 관례를 따른다 — `%APPDATA%\cvmux\cvmux.json`.
 *
 * 규칙 하나: **모르는 키는 무시하고 잘못된 값은 기본값으로 되돌린다.**
 * 설정 파일에 오타가 있다고 터미널을 못 쓰게 되면 안 된다(P12). 무엇이
 * 무시됐는지는 `cvmux config doctor`가 알려 준다.
 */

export interface TerminalConfig {
  fontFamily: string
  fontSize: number
  lineHeight: number
  cursorStyle: 'bar' | 'block' | 'underline'
  cursorBlink: boolean
  scrollback: number
  /** 세션을 띄울 셸. 비우면 pwsh → powershell → cmd 순으로 찾는다 */
  shell: string | null
  /** 앱을 다시 켤 때 에이전트 세션을 이어서 띄울 것인가. P22-8 */
  autoResumeAgentSessions: boolean
}

export interface SidebarConfig {
  width: number
  fontSize: number
}

export interface ThemeConfig {
  background: string
  foreground: string
  cursor: string
  selection: string
  black: string
  red: string
  green: string
  yellow: string
  blue: string
  magenta: string
  cyan: string
  white: string
  brightBlack: string
  brightRed: string
  brightGreen: string
  brightYellow: string
  brightBlue: string
  brightMagenta: string
  brightCyan: string
  brightWhite: string
}

/** 동작 이름 → 키 조합. 빈 문자열이면 그 동작의 단축키를 없앤다. P22-5 */
export type KeybindingConfig = Record<string, string>

export interface CvmuxConfig {
  terminal: TerminalConfig
  sidebar: SidebarConfig
  theme: ThemeConfig
  keybindings: KeybindingConfig
}

/**
 * 기본 단축키 (P22-5).
 *
 * 전부 `Shift`나 `Alt`가 붙어 있다. `Ctrl+C`·`Ctrl+N`·`Ctrl+P`·`Ctrl+F`·
 * `Ctrl+I`는 PSReadLine과 bash가 쓰는 키라 앱이 가로채면 안 된다(P6-1).
 * 사용자가 바꿀 수는 있지만, 기본값이 셸을 방해하지는 않는다.
 */
export const DEFAULT_KEYBINDINGS: KeybindingConfig = {
  'workspace.new': 'Ctrl+Shift+N',
  'workspace.rename': 'Ctrl+Shift+E',
  'pane.close': 'Ctrl+Shift+W',
  /*
   * 가로 탭 (P24-3).
   *
   * `Ctrl+Tab`은 셸이 쓰지 않으므로 그대로 쓸 수 있다 — 브라우저와 편집기에서
   * 이미 몸에 익은 조합이라 여기서만 다른 키를 쓸 이유가 없다.
   */
  'surface.new': 'Ctrl+Shift+T',
  'surface.next': 'Ctrl+Tab',
  'surface.previous': 'Ctrl+Shift+Tab',
  'pane.split.right': 'Alt+Shift+Equal',
  'pane.split.down': 'Alt+Shift+Minus',
  'view.sidebar': 'Ctrl+Shift+B',
  'view.right-sidebar': 'Alt+Shift+B',
  'view.palette': 'Ctrl+Shift+P',
  'notifications.show': 'Ctrl+Shift+I',
  'notifications.jump': 'Ctrl+Shift+U',
  'find.session': 'Alt+F',
  'find.all': 'Ctrl+Shift+F',
  'workspace.select.1': 'Ctrl+Alt+Digit1',
  'workspace.select.2': 'Ctrl+Alt+Digit2',
  'workspace.select.3': 'Ctrl+Alt+Digit3',
  'workspace.select.4': 'Ctrl+Alt+Digit4',
  'workspace.select.5': 'Ctrl+Alt+Digit5',
  'workspace.select.6': 'Ctrl+Alt+Digit6',
  'workspace.select.7': 'Ctrl+Alt+Digit7',
  'workspace.select.8': 'Ctrl+Alt+Digit8'
}

export const DEFAULT_THEME: ThemeConfig = {
  background: '#0d1016',
  foreground: '#d3d9e3',
  cursor: '#7aa2f7',
  selection: '#2b3a5c',
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

export const DEFAULT_CONFIG: CvmuxConfig = {
  terminal: {
    fontFamily: '"Cascadia Mono", "Cascadia Code", Consolas, "D2Coding", monospace',
    fontSize: 13,
    lineHeight: 1.25,
    cursorStyle: 'bar',
    cursorBlink: true,
    scrollback: 10_000,
    shell: null,
    autoResumeAgentSessions: true
  },
  sidebar: { width: 264, fontSize: 13 },
  theme: DEFAULT_THEME,
  keybindings: DEFAULT_KEYBINDINGS
}

/** 설정 파일을 읽다 만난 문제. 무엇을 무시했는지 사람에게 말해 준다. P22-3 */
export interface ConfigProblem {
  path: string
  message: string
}

export interface ParsedConfig {
  config: CvmuxConfig
  problems: ConfigProblem[]
}

/**
 * 사용자 설정을 기본값 위에 얹는다 (P22-2).
 *
 * 값 하나가 잘못됐다고 그 구역 전체를 버리지 않는다 — `fontSize`에 문자열을
 * 넣었다고 폰트 이름까지 기본값으로 돌아가면, 무엇을 고쳐야 하는지 알기 어렵다.
 */
export function parseConfig(raw: unknown): ParsedConfig {
  const problems: ConfigProblem[] = []
  const config: CvmuxConfig = {
    terminal: { ...DEFAULT_CONFIG.terminal },
    sidebar: { ...DEFAULT_CONFIG.sidebar },
    theme: { ...DEFAULT_THEME },
    keybindings: { ...DEFAULT_KEYBINDINGS }
  }

  if (raw === null || raw === undefined) return { config, problems }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    problems.push({ path: '', message: '설정 파일의 최상위는 객체여야 합니다' })
    return { config, problems }
  }

  const root = raw as Record<string, unknown>

  for (const key of Object.keys(root)) {
    if (!['terminal', 'sidebar', 'theme', 'keybindings'].includes(key)) {
      problems.push({ path: key, message: '모르는 항목입니다' })
    }
  }

  // ── terminal
  const terminal = section(root.terminal, 'terminal', problems, Object.keys(DEFAULT_CONFIG.terminal))
  if (terminal) {
    str(terminal, 'fontFamily', 'terminal.fontFamily', problems, (v) => {
      config.terminal.fontFamily = v
    })
    num(terminal, 'fontSize', 'terminal.fontSize', 6, 72, problems, (v) => {
      config.terminal.fontSize = v
    })
    num(terminal, 'lineHeight', 'terminal.lineHeight', 0.8, 3, problems, (v) => {
      config.terminal.lineHeight = v
    })
    num(terminal, 'scrollback', 'terminal.scrollback', 100, 200_000, problems, (v) => {
      config.terminal.scrollback = Math.floor(v)
    })
    oneOf(
      terminal,
      'cursorStyle',
      'terminal.cursorStyle',
      ['bar', 'block', 'underline'],
      problems,
      (v) => {
        config.terminal.cursorStyle = v as TerminalConfig['cursorStyle']
      }
    )
    bool(terminal, 'cursorBlink', 'terminal.cursorBlink', problems, (v) => {
      config.terminal.cursorBlink = v
    })
    bool(
      terminal,
      'autoResumeAgentSessions',
      'terminal.autoResumeAgentSessions',
      problems,
      (v) => {
        config.terminal.autoResumeAgentSessions = v
      }
    )
    str(terminal, 'shell', 'terminal.shell', problems, (v) => {
      config.terminal.shell = v
    })
  }

  // ── sidebar
  const sidebar = section(root.sidebar, 'sidebar', problems, Object.keys(DEFAULT_CONFIG.sidebar))
  if (sidebar) {
    num(sidebar, 'width', 'sidebar.width', 160, 640, problems, (v) => {
      config.sidebar.width = Math.floor(v)
    })
    num(sidebar, 'fontSize', 'sidebar.fontSize', 8, 32, problems, (v) => {
      config.sidebar.fontSize = Math.floor(v)
    })
  }

  // ── theme
  const theme = section(root.theme, 'theme', problems)
  if (theme) {
    for (const key of Object.keys(theme)) {
      if (!(key in DEFAULT_THEME)) {
        problems.push({ path: `theme.${key}`, message: '모르는 색 이름입니다' })
        continue
      }
      const value = theme[key]
      if (typeof value !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(value)) {
        problems.push({ path: `theme.${key}`, message: '#rrggbb 형태의 색이어야 합니다' })
        continue
      }
      config.theme[key as keyof ThemeConfig] = value
    }
  }

  // ── keybindings
  const keys = section(root.keybindings, 'keybindings', problems)
  if (keys) {
    for (const [action, value] of Object.entries(keys)) {
      if (!(action in DEFAULT_KEYBINDINGS)) {
        problems.push({ path: `keybindings.${action}`, message: '모르는 동작입니다' })
        continue
      }
      if (typeof value !== 'string') {
        problems.push({ path: `keybindings.${action}`, message: '키 조합은 문자열이어야 합니다' })
        continue
      }
      // 빈 문자열은 "이 동작의 단축키를 없앤다"는 뜻이다
      config.keybindings[action] = value
    }
  }

  return { config, problems }
}

// ── 값 하나씩 검사 ────────────────────────────────────────────

/**
 * 구역 하나를 꺼내며 모르는 키를 짚어 준다 (P22-3).
 *
 * `fontSizze`처럼 잘못 적은 키는 아무 일도 일으키지 않는다 — 그리고 아무 일도
 * 일어나지 않는 것이 가장 알아채기 어렵다. 값을 고쳤는데 화면이 그대로면
 * 사람은 기능이 고장 났다고 읽는다. 그래서 `config doctor`가 이걸 짚어야 한다.
 */
function section(
  value: unknown,
  path: string,
  problems: ConfigProblem[],
  known?: readonly string[]
): Record<string, unknown> | null {
  if (value === undefined) return null
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    problems.push({ path, message: '객체여야 합니다' })
    return null
  }

  const record = value as Record<string, unknown>
  if (known) {
    for (const key of Object.keys(record)) {
      if (!known.includes(key)) {
        problems.push({ path: `${path}.${key}`, message: '모르는 항목입니다' })
      }
    }
  }
  return record
}

function str(
  obj: Record<string, unknown>,
  key: string,
  path: string,
  problems: ConfigProblem[],
  apply: (value: string) => void
): void {
  const value = obj[key]
  if (value === undefined) return
  if (typeof value !== 'string') {
    problems.push({ path, message: '문자열이어야 합니다' })
    return
  }
  apply(value)
}

function num(
  obj: Record<string, unknown>,
  key: string,
  path: string,
  min: number,
  max: number,
  problems: ConfigProblem[],
  apply: (value: number) => void
): void {
  const value = obj[key]
  if (value === undefined) return
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    problems.push({ path, message: '숫자여야 합니다' })
    return
  }
  if (value < min || value > max) {
    problems.push({ path, message: `${min}에서 ${max} 사이여야 합니다` })
    return
  }
  apply(value)
}

function bool(
  obj: Record<string, unknown>,
  key: string,
  path: string,
  problems: ConfigProblem[],
  apply: (value: boolean) => void
): void {
  const value = obj[key]
  if (value === undefined) return
  if (typeof value !== 'boolean') {
    problems.push({ path, message: 'true 또는 false여야 합니다' })
    return
  }
  apply(value)
}

function oneOf(
  obj: Record<string, unknown>,
  key: string,
  path: string,
  allowed: string[],
  problems: ConfigProblem[],
  apply: (value: string) => void
): void {
  const value = obj[key]
  if (value === undefined) return
  if (typeof value !== 'string' || !allowed.includes(value)) {
    problems.push({ path, message: `${allowed.join(' / ')} 중 하나여야 합니다` })
    return
  }
  apply(value)
}

/**
 * 주석이 섞인 JSON을 읽는다 (P22-1).
 *
 * 설정 파일에 "이 줄이 왜 여기 있는지"를 적을 수 있어야 한다. cmux의
 * `cmux.json`도 JSONC다. 문자열 안의 `//`는 주석이 아니므로 따옴표를 따라간다.
 */
export function parseJsonc(text: string): unknown {
  let out = ''
  let inString = false
  let escaped = false
  let comment: 'line' | 'block' | null = null

  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    const next = text[i + 1]

    if (comment === 'line') {
      if (char === '\n') {
        comment = null
        out += char
      }
      continue
    }
    if (comment === 'block') {
      if (char === '*' && next === '/') {
        comment = null
        i++
      }
      continue
    }

    if (inString) {
      out += char
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }

    if (char === '"') {
      inString = true
      out += char
      continue
    }
    if (char === '/' && next === '/') {
      comment = 'line'
      i++
      continue
    }
    if (char === '/' && next === '*') {
      comment = 'block'
      i++
      continue
    }
    out += char
  }

  // 마지막 쉼표도 받아 준다 — 항목을 지우다 남기는 실수가 잦다
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'))
}

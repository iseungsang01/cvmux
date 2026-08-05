/**
 * CLI 출력 (P20-1).
 *
 * 기본은 사람이 읽는 줄, `--json`이면 원본 그대로. 스크립트가 파싱할 것은
 * `--json` 쪽이라, 사람용 출력은 자유롭게 다듬을 수 있다.
 */

type Row = Record<string, unknown>

export function render(command: string, result: unknown, json: boolean): string {
  if (json) return JSON.stringify(result, null, 2)

  const value = result as Row
  switch (command) {
    case 'list-windows':
      return table(rows(value.windows), ['id', 'current', 'workspaces', 'visible', 'minimized'])

    case 'current-window':
      return pairs(value, ['id', 'workspaces', 'focused', 'visible'])

    case 'list-workspaces':
      return table(rows(value.workspaces), ['ref', 'title', 'status', 'branch', 'cwd'])

    case 'current-workspace':
      return pairs(value, ['ref', 'title', 'focused_session_id', 'branch', 'cwd', 'ports'])

    case 'list-panes':
      return table(rows(value.panes), ['ref', 'title', 'status', 'focused', 'cwd'])

    case 'list-sessions':
      return table(rows(value.sessions), ['id', 'title', 'status', 'branch', 'cwd'])

    case 'list-notifications': {
      const list = rows(value.notifications)
      if (list.length === 0) return '알림이 없습니다.'
      // 읽음 여부가 먼저다 — 목록을 여는 이유가 대개 그것이다
      return table(
        list.map((n) => ({ ...n, unread: n.read === false })),
        ['unread', 'session_title', 'text', 'id']
      )
    }

    case 'read-screen':
      return String(value.text ?? '')

    // ── 사이드바 메타데이터 (P25) ────────────────────────────
    case 'todo': {
      const list = rows(value.todo)
      if (list.length === 0) return '할 일이 없습니다.'
      // 번호를 함께 찍는다 — 그대로 `todo check 2`에 되쓸 수 있어야 한다
      return table(
        list.map((item, i) => ({ '#': i + 1, ...item, mark: todoMark(item.state) })),
        ['#', 'mark', 'text', 'origin']
      )
    }

    case 'list-status': {
      const list = rows(value.status)
      if (list.length === 0) return '적힌 상태가 없습니다.'
      return table(list, ['name', 'text'])
    }

    case 'list-log': {
      const list = rows(value.log)
      if (list.length === 0) return '기록이 없습니다.'
      return list
        .map((entry) => `${clock(entry.at)}  ${pad(format(entry.level), 7)}  ${format(entry.text)}`)
        .join('\n')
    }

    case 'sidebar-state':
      return JSON.stringify(result, null, 2)

    // 상태 이름만으로는 무엇을 해야 하는지 알기 어렵다 — 다음 행동을 함께 적는다
    case 'update': {
      const status = String(value.status ?? '')
      const version = value.version ? ` (${String(value.version)})` : ''
      const notes: Record<string, string> = {
        idle: '아직 확인하지 않았습니다',
        checking: '확인 중입니다',
        current: '최신 버전입니다',
        downloading: `내려받는 중${version} — ${String(value.percent ?? 0)}%`,
        ready: `설치할 준비가 됐습니다${version}. \`cvmux update install\` 또는 트레이 메뉴에서.`,
        error: `확인하지 못했습니다: ${String(value.error ?? '')}`,
        disabled: `자동 확인이 꺼져 있습니다${value.error ? ` (${String(value.error)})` : ''}`
      }
      return notes[status] ?? summarize(value)
    }

    case 'tree':
      return rows(value.workspaces)
        .map((w) => `${w.ref}  ${w.title}\n${drawTree(w.tree, '  ')}`)
        .join('\n')

    case 'ping':
      return `pong (pid ${String(value.pid)}, ${String(value.version)})`

    case 'capabilities':
    case 'identify':
      return JSON.stringify(result, null, 2)

    default:
      return summarize(value)
  }
}

function rows(value: unknown): Row[] {
  return Array.isArray(value) ? (value as Row[]) : []
}

/**
 * 한 줄짜리 결과는 굳이 표로 만들지 않는다.
 *
 * 참/거짓은 `true`/`false`로 적는다. 표에서 쓰는 점은 칸이 비어 있는 것과
 * 거짓을 눈으로 구분할 수 있지만, `key=` 뒤에 아무것도 없으면 값이 없는 것인지
 * 거짓인지 알 수 없다.
 */
function summarize(value: Row): string {
  if (value === null || typeof value !== 'object') return String(value)
  const parts = Object.entries(value)
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([k, v]) => `${k}=${typeof v === 'boolean' ? String(v) : format(v)}`)
  return parts.length > 0 ? parts.join('  ') : 'ok'
}

function pairs(value: Row, keys: string[]): string {
  return keys
    .filter((key) => value[key] !== null && value[key] !== undefined)
    .map((key) => `${key.padEnd(20)}${format(value[key])}`)
    .join('\n')
}

function table(list: Row[], columns: string[]): string {
  if (list.length === 0) return '(없음)'

  const widths = columns.map((column) =>
    Math.max(width(column), ...list.map((row) => width(format(row[column]))))
  )

  const line = (cells: string[]): string =>
    cells.map((cell, i) => pad(cell, widths[i])).join('  ').trimEnd()

  return [line(columns), ...list.map((row) => line(columns.map((c) => format(row[c]))))].join('\n')
}

/**
 * 터미널에서 차지하는 칸 수 (P20-1).
 *
 * 한글과 이모지는 한 글자가 두 칸이다. `padEnd`는 글자 수만 세므로 한글이 섞인
 * 표는 열이 어긋난다 — 이 앱의 출력은 대부분 한글이라 그냥 두면 표가 늘 삐뚤다.
 */
function width(text: string): number {
  let total = 0
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    total += isWide(code) ? 2 : 1
  }
  return total
}

function isWide(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) || // 한글 자모
    (code >= 0x2e80 && code <= 0xa4cf) || // CJK 부수·한자·가나
    (code >= 0xac00 && code <= 0xd7a3) || // 한글 음절
    (code >= 0xf900 && code <= 0xfaff) || // CJK 호환 한자
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) || // 전각 기호
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1f64f) || // 이모지
    (code >= 0x1f900 && code <= 0x1f9ff)
  )
}

function pad(text: string, to: number): string {
  return text + ' '.repeat(Math.max(0, to - width(text)))
}

function todoMark(state: unknown): string {
  if (state === 'completed') return '[x]'
  if (state === 'in-progress') return '[~]'
  return '[ ]'
}

function clock(at: unknown): string {
  if (typeof at !== 'number') return '        '
  const date = new Date(at)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

function format(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (Array.isArray(value)) return value.join(',')
  if (typeof value === 'boolean') return value ? '●' : ''
  return String(value)
}

function drawTree(node: unknown, indent: string): string {
  const n = node as Row
  if (n.kind === 'leaf') {
    return `${indent}${String(n.id)}  ${String(n.title ?? '')}  [${String(n.status ?? '')}]`
  }
  const children = rows(n.children).map((child) => drawTree(child, `${indent}  `))
  return [`${indent}${String(n.direction)}`, ...children].join('\n')
}

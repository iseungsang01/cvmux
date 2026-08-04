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
      if (list.length === 0) return '읽지 않은 알림이 없습니다.'
      return table(list, ['workspace_ref', 'title', 'text'])
    }

    case 'read-screen':
      return String(value.text ?? '')

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

/** 한 줄짜리 결과는 굳이 표로 만들지 않는다 */
function summarize(value: Row): string {
  if (value === null || typeof value !== 'object') return String(value)
  const parts = Object.entries(value)
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([k, v]) => `${k}=${format(v)}`)
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
    Math.max(column.length, ...list.map((row) => format(row[column]).length))
  )

  const line = (cells: string[]): string =>
    cells.map((cell, i) => cell.padEnd(widths[i])).join('  ').trimEnd()

  return [line(columns), ...list.map((row) => line(columns.map((c) => format(row[c]))))].join('\n')
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

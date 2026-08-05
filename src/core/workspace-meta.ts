import { randomUUID } from 'node:crypto'

import { POLICY } from '@shared/policy'
import type { PaneNode, StatusPill, TodoItem, WorkspaceLogEntry, WorkspaceMeta, Workspace } from '@shared/types'

/**
 * 워크스페이스에 붙는 메타데이터 (POLICY.md P25).
 *
 * 여기 담기는 것은 cvmux가 스스로 알아낸 것이 아니라 **에이전트가 적어 둔
 * 것**이다. 상태 pill·진행률·로그·체크리스트 — 전부 소켓으로 들어온다.
 *
 * 이것이 있어야 사이드바가 "무엇이 돌고 있는가"를 넘어 "지금 어디까지 갔는가"에
 * 답할 수 있다. 출력만 보고 짐작하는 것으로는 닿지 못하는 자리다(P4의 휴리스틱은
 * 상태를 맞힐 뿐 진행 상황을 알지 못한다).
 *
 * 저장하지 않는다. 진행 중인 일에 대한 기록이라 앱을 껐다 켜면 그 일은 이미
 * 끝났거나 처음부터 다시다 — 남겨 두면 지난 일이 지금인 척한다.
 */
export class WorkspaceMetaStore {
  private readonly meta = new Map<string, WorkspaceMeta>()

  constructor(private readonly onChange: () => void) {}

  get(workspaceId: string): WorkspaceMeta {
    const found = this.meta.get(workspaceId)
    if (found) return found
    const created: WorkspaceMeta = { status: [], progress: null, log: [], todo: [] }
    this.meta.set(workspaceId, created)
    return created
  }

  /** 지금 무엇이 적혀 있는지 통째로 — 렌더러가 이걸 그대로 그린다 */
  all(): Record<string, WorkspaceMeta> {
    const out: Record<string, WorkspaceMeta> = {}
    for (const [id, meta] of this.meta) out[id] = meta
    return out
  }

  // ── 상태 pill (P25-1) ────────────────────────────────────────

  /**
   * 같은 이름의 pill은 덮어쓴다.
   *
   * 에이전트는 단계가 바뀔 때마다 같은 이름으로 다시 쓴다(`build: 컴파일 중` →
   * `build: 테스트 중`). 덮어쓰지 않으면 사이드바에 낡은 단계가 쌓인다.
   */
  setStatus(workspaceId: string, name: string, text: string, color?: string): StatusPill {
    const meta = this.get(workspaceId)
    const pill: StatusPill = { name, text, color: color ?? null, at: Date.now() }
    const at = meta.status.findIndex((p) => p.name === name)
    if (at === -1) meta.status.push(pill)
    else meta.status[at] = pill

    // 사이드바 한 줄에 들어갈 수 있는 것은 몇 개뿐이다. 오래된 것부터 밀어낸다
    if (meta.status.length > POLICY.MAX_STATUS_PILLS) {
      meta.status = meta.status.slice(-POLICY.MAX_STATUS_PILLS)
    }
    this.onChange()
    return pill
  }

  clearStatus(workspaceId: string, name?: string): number {
    const meta = this.get(workspaceId)
    const before = meta.status.length
    meta.status = name === undefined ? [] : meta.status.filter((p) => p.name !== name)
    const removed = before - meta.status.length
    if (removed > 0) this.onChange()
    return removed
  }

  // ── 진행률 (P25-2) ───────────────────────────────────────────

  /**
   * 0에서 1 사이. 범위를 벗어난 값은 잘라 넣는다.
   *
   * 몇 분의 몇인지 모를 때도 있으므로 `value`는 비울 수 있다 — 그때는 끝을
   * 모르는 채로 돌고 있다는 뜻이고, 화면에는 흐르는 막대가 뜬다.
   */
  setProgress(workspaceId: string, value: number | null, text?: string): void {
    const meta = this.get(workspaceId)
    meta.progress = {
      value: value === null ? null : Math.min(1, Math.max(0, value)),
      text: text ?? null,
      at: Date.now()
    }
    this.onChange()
  }

  clearProgress(workspaceId: string): void {
    const meta = this.get(workspaceId)
    if (meta.progress === null) return
    meta.progress = null
    this.onChange()
  }

  // ── 로그 (P25-3) ─────────────────────────────────────────────

  /**
   * 에이전트가 남기는 한 줄.
   *
   * 터미널 출력과 다르다 — 출력은 도구가 뱉은 것이고 이것은 **에이전트가
   * 사람에게 하는 말**이다. 그래서 스크롤백에 묻히지 않게 따로 쌓는다.
   */
  log(workspaceId: string, text: string, level: WorkspaceLogEntry['level'] = 'info'): WorkspaceLogEntry {
    const meta = this.get(workspaceId)
    const entry: WorkspaceLogEntry = { id: randomUUID(), text, level, at: Date.now() }
    meta.log.push(entry)
    if (meta.log.length > POLICY.MAX_WORKSPACE_LOG) {
      meta.log = meta.log.slice(-POLICY.MAX_WORKSPACE_LOG)
    }
    this.onChange()
    return entry
  }

  clearLog(workspaceId: string): void {
    const meta = this.get(workspaceId)
    if (meta.log.length === 0) return
    meta.log = []
    this.onChange()
  }

  // ── 체크리스트 (P25-4) ───────────────────────────────────────

  addTodo(workspaceId: string, text: string, state: TodoItem['state'], origin: TodoItem['origin']): TodoItem {
    const meta = this.get(workspaceId)
    if (meta.todo.length >= POLICY.MAX_TODO_ITEMS) {
      throw new Error(`체크리스트는 ${POLICY.MAX_TODO_ITEMS}개까지입니다`)
    }
    const item: TodoItem = { id: randomUUID(), text: trimText(text), state, origin }
    meta.todo.push(item)
    this.onChange()
    return item
  }

  /**
   * 순번이나 id로 항목을 집는다.
   *
   * `todo list`가 찍어 준 1부터 세는 번호를 그대로 되쓸 수 있어야 한다.
   */
  findTodo(workspaceId: string, ref: string): TodoItem | null {
    const meta = this.get(workspaceId)
    if (/^\d+$/.test(ref)) return meta.todo[Number.parseInt(ref, 10) - 1] ?? null
    return meta.todo.find((t) => t.id === ref) ?? null
  }

  setTodoState(workspaceId: string, ref: string, state: TodoItem['state']): TodoItem | null {
    const item = this.findTodo(workspaceId, ref)
    if (!item) return null
    item.state = state
    this.onChange()
    return item
  }

  editTodo(workspaceId: string, ref: string, text: string): TodoItem | null {
    const item = this.findTodo(workspaceId, ref)
    if (!item) return null
    item.text = trimText(text)
    this.onChange()
    return item
  }

  removeTodo(workspaceId: string, ref: string): boolean {
    const meta = this.get(workspaceId)
    const item = this.findTodo(workspaceId, ref)
    if (!item) return false
    meta.todo = meta.todo.filter((t) => t.id !== item.id)
    this.onChange()
    return true
  }

  clearTodo(workspaceId: string): void {
    const meta = this.get(workspaceId)
    if (meta.todo.length === 0) return
    meta.todo = []
    this.onChange()
  }

  /**
   * 목록을 통째로 갈아 끼운다 (P25-5).
   *
   * **id가 같은 항목은 정체를 지킨다** — 감시 루프가 매 틱마다 전체 목록을
   * 다시 보내도 체크박스가 새로 만들어지지 않아야 한다. 하나라도 잘못되면
   * 아무것도 바꾸지 않는다: 반쯤 적용된 체크리스트가 가장 나쁘다.
   */
  replaceTodo(workspaceId: string, items: Array<Partial<TodoItem>>): TodoItem[] {
    if (items.length > POLICY.MAX_TODO_ITEMS) {
      throw new Error(`체크리스트는 ${POLICY.MAX_TODO_ITEMS}개까지입니다`)
    }

    const meta = this.get(workspaceId)
    const existing = new Map(meta.todo.map((t) => [t.id, t]))
    const next: TodoItem[] = []

    for (const raw of items) {
      const text = trimText(String(raw.text ?? ''))
      if (text === '') throw new Error('빈 항목은 넣을 수 없습니다')

      const previous = typeof raw.id === 'string' ? existing.get(raw.id) : undefined
      next.push({
        id: previous?.id ?? randomUUID(),
        text,
        state: raw.state ?? previous?.state ?? 'pending',
        // 원래 누가 만든 것인지는 바뀌지 않는다
        origin: previous?.origin ?? raw.origin ?? 'user'
      })
    }

    meta.todo = next
    this.onChange()
    return next
  }

  /** 사라진 워크스페이스의 메타데이터를 치운다 */
  prune(alive: Iterable<string>): void {
    const keep = new Set(alive)
    let changed = false
    for (const id of [...this.meta.keys()]) {
      if (keep.has(id)) continue
      this.meta.delete(id)
      changed = true
    }
    if (changed) this.onChange()
  }
}

/** 너무 긴 한 줄은 사이드바를 밀어낸다. 저장 전에 자른다 */
function trimText(text: string): string {
  const trimmed = text.trim()
  return trimmed.length > POLICY.MAX_TODO_TEXT
    ? `${trimmed.slice(0, POLICY.MAX_TODO_TEXT - 1)}…`
    : trimmed
}

/**
 * 세션이 어느 워크스페이스에 있는가 (P25-6).
 *
 * 세션 안의 에이전트는 자기 워크스페이스 id를 모른다 — 아는 것은
 * `CVMUX_SESSION_ID`뿐이다. 배치는 렌더러가 저장할 때마다 main으로 넘어오므로
 * (P17), 여기서 그대로 되짚을 수 있다.
 */
export function workspaceOfSession(layout: Workspace[], sessionId: string): Workspace | null {
  for (const workspace of layout) {
    if (surfacesOf(workspace.root).includes(sessionId)) return workspace
  }
  return null
}

function surfacesOf(node: PaneNode): string[] {
  if (node.kind === 'leaf') return node.surfaces
  return node.children.flatMap(surfacesOf)
}

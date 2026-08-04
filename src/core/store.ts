import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname } from 'node:path'

import { POLICY } from '@shared/policy'
import type { Notification, PaneNode, Workspace } from '@shared/types'

/**
 * 세션 목록을 디스크에 남긴다 (POLICY.md P16).
 *
 * 복원되는 것은 "어디서 무엇을 하고 있었는가"이지 프로세스가 아니다. 이전 셸은
 * 이미 죽었고 새 셸이 그 자리에 선다 — 복원된 스크롤백 뒤에 구분선을 넣어
 * 그 사실을 감추지 않는다(P16-6).
 */

export interface PersistedSession {
  cwd: string
  /** 사용자가 직접 지정한 제목만 저장한다. 셸이 설정한 제목은 다시 오면 그만 */
  title: string | null
  scrollback: string
  /**
   * 이 세션에서 돌던 에이전트 대화 (P22-8).
   *
   * 세션 id는 복원할 때 새로 발급되므로 훅이 적어 둔 기록만으로는 짝을 지을 수
   * 없다. 그래서 저장 시점에 여기로 옮겨 적는다 — 세션과 대화가 같은 파일에서
   * 같은 순번으로 되살아난다.
   */
  agent?: { name: string; sessionId: string }
}

/**
 * 저장되는 pane 배치.
 *
 * 세션을 id가 아니라 **순번**으로 가리킨다. 복원할 때 세션 id는 새로 발급되므로
 * 저장된 id는 아무 의미가 없다. 순번은 sessions 배열의 위치를 뜻한다.
 */
export type PersistedPane =
  | { kind: 'leaf'; sessionIndex: number }
  | {
      kind: 'split'
      direction: 'row' | 'column'
      children: PersistedPane[]
      sizes: number[]
    }

export interface PersistedWorkspace {
  title: string | null
  root: PersistedPane
  /** 포커스된 잎이 가리키는 세션 순번 */
  focusedIndex: number
}

export interface PersistedState {
  version: 3
  savedAt: number
  sessions: PersistedSession[]
  workspaces: PersistedWorkspace[]
  /**
   * 알림함 (P21-8).
   *
   * 세션 순번이 아니라 세션 id를 그대로 들고 있다. 복원하면 그 id는 아무것도
   * 가리키지 않지만, 알림은 **무슨 일이 있었는가**의 기록이라 가리킬 세션이
   * 사라져도 읽을 값이 남는다 — 세션 제목을 함께 저장하는 이유다.
   */
  notifications: Notification[]
}

/** 스크롤백을 상한까지 줄인다. 이스케이프 시퀀스 중간에서 자르면 화면이 깨지므로 개행에서 자른다. P16-5 */
export function trimScrollback(text: string): string {
  if (text.length <= POLICY.PERSIST_SCROLLBACK_BYTES) return text
  const cut = text.length - POLICY.PERSIST_SCROLLBACK_BYTES
  const newline = text.indexOf('\n', cut)
  return text.slice(newline === -1 ? cut : newline + 1)
}

export class SessionStore {
  constructor(private readonly filePath: string) {}

  /**
   * @returns 파일이 없거나 읽을 수 없으면 null — 빈 상태로 시작한다. P16-2
   */
  load(): PersistedState | null {
    if (!existsSync(this.filePath)) return null

    let raw: string
    try {
      raw = readFileSync(this.filePath, 'utf8')
    } catch (error) {
      console.warn('[cvmux] 세션 파일을 읽지 못했습니다:', error)
      return null
    }

    try {
      const parsed: unknown = JSON.parse(raw)
      return this.validate(parsed)
    } catch (error) {
      // 손상된 파일은 덮어쓰기 전에 남겨둔다 — 사용자의 작업 기록이었을 수 있다. P16-2
      console.warn('[cvmux] 세션 파일이 손상되었습니다. .bak으로 보존합니다:', error)
      try {
        copyFileSync(this.filePath, `${this.filePath}.bak`)
      } catch {
        // 백업 실패는 치명적이지 않다
      }
      return null
    }
  }

  /** 임시 파일에 쓰고 원자적으로 바꿔치기한다. 반쪽 파일을 남기지 않는다. P16-3 */
  save(state: PersistedState): void {
    try {
      mkdirSync(dirname(this.filePath), { recursive: true })
      const temp = `${this.filePath}.tmp`
      writeFileSync(temp, JSON.stringify(state), 'utf8')
      renameSync(temp, this.filePath)
    } catch (error) {
      // 저장 실패가 앱을 멈추게 해서는 안 된다. P12-2
      console.warn('[cvmux] 세션을 저장하지 못했습니다:', error)
    }
  }

  private validate(value: unknown): PersistedState | null {
    if (typeof value !== 'object' || value === null) return null
    const state = value as {
      version?: unknown
      savedAt?: unknown
      sessions?: unknown
      workspaces?: unknown
      notifications?: unknown
    }
    /*
     * 옛 버전의 파일도 읽는다.
     *
     * version 1에는 pane 배치가, 2에는 알림함이 없었다. 없는 것은 비워 두면
     * 그만이고, 있는 것은 살린다 — 앱을 갱신했다고 열어 둔 세션이 사라지면
     * 그건 복원이 아니다(P16).
     */
    if (state.version !== 1 && state.version !== 2 && state.version !== 3) return null
    if (!Array.isArray(state.sessions)) return null

    const sessions: PersistedSession[] = []
    for (const entry of state.sessions) {
      if (typeof entry !== 'object' || entry === null) continue
      const s = entry as Partial<PersistedSession>
      if (typeof s.cwd !== 'string' || !s.cwd) continue
      sessions.push({
        cwd: s.cwd,
        title: typeof s.title === 'string' ? s.title : null,
        scrollback: typeof s.scrollback === 'string' ? s.scrollback : '',
        agent: parseAgentLink(s.agent)
      })
    }

    // 오래된 것부터 잘라 상한을 지킨다. P16-7
    const kept = sessions.slice(-POLICY.MAX_SESSIONS)
    const dropped = sessions.length - kept.length

    const rawWorkspaces = Array.isArray(state.workspaces) ? state.workspaces : []
    const workspaces: PersistedWorkspace[] = []
    for (const entry of rawWorkspaces) {
      const parsed = parseWorkspace(entry, kept.length, dropped)
      if (parsed) workspaces.push(parsed)
    }

    return {
      version: 3,
      savedAt: typeof state.savedAt === 'number' ? state.savedAt : 0,
      sessions: kept,
      workspaces,
      notifications: parseNotifications(state.notifications)
    }
  }
}

/**
 * 저장된 에이전트 연결 (P22-8).
 *
 * 이름과 id에 셸이 해석할 만한 글자가 섞이면 걸러낸다. 이 값은 나중에 셸
 * 명령줄에 그대로 실리므로, 파일을 손으로 고친 사람이 자기도 모르게 명령을
 * 심는 자리가 되어서는 안 된다.
 */
function parseAgentLink(value: unknown): { name: string; sessionId: string } | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const link = value as { name?: unknown; sessionId?: unknown }
  if (typeof link.name !== 'string' || typeof link.sessionId !== 'string') return undefined
  if (!/^[a-z0-9-]{1,32}$/i.test(link.name)) return undefined
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(link.sessionId)) return undefined
  return { name: link.name, sessionId: link.sessionId }
}

function parseNotifications(value: unknown): Notification[] {
  if (!Array.isArray(value)) return []
  const out: Notification[] = []
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue
    const n = entry as Partial<Notification>
    if (typeof n.id !== 'string' || typeof n.sessionId !== 'string') continue
    out.push({
      id: n.id,
      sessionId: n.sessionId,
      sessionTitle: typeof n.sessionTitle === 'string' ? n.sessionTitle : '세션',
      text: typeof n.text === 'string' ? n.text : '',
      createdAt: typeof n.createdAt === 'number' ? n.createdAt : 0,
      read: n.read === true
    })
  }
  return out.slice(-POLICY.MAX_NOTIFICATIONS)
}

function parseWorkspace(value: unknown, count: number, dropped: number): PersistedWorkspace | null {
  if (typeof value !== 'object' || value === null) return null
  const ws = value as Partial<PersistedWorkspace>
  const root = parsePane(ws.root, count, dropped)
  if (!root) return null
  const focused = typeof ws.focusedIndex === 'number' ? ws.focusedIndex - dropped : 0
  return {
    title: typeof ws.title === 'string' ? ws.title : null,
    root,
    focusedIndex: focused >= 0 && focused < count ? focused : 0
  }
}

/** 순번이 범위를 벗어난 잎은 걷어낸다 — 상한에 걸려 잘려나간 세션을 가리킬 수 있다 */
function parsePane(value: unknown, count: number, dropped: number): PersistedPane | null {
  if (typeof value !== 'object' || value === null) return null
  const node = value as Partial<PersistedPane> & { kind?: string }

  if (node.kind === 'leaf') {
    const raw = (node as { sessionIndex?: unknown }).sessionIndex
    if (typeof raw !== 'number') return null
    const index = raw - dropped
    if (index < 0 || index >= count) return null
    return { kind: 'leaf', sessionIndex: index }
  }

  if (node.kind === 'split') {
    const split = node as Partial<Extract<PersistedPane, { kind: 'split' }>>
    if (!Array.isArray(split.children)) return null
    const direction = split.direction === 'column' ? 'column' : 'row'
    const children: PersistedPane[] = []
    const sizes: number[] = []
    split.children.forEach((child, i) => {
      const parsed = parsePane(child, count, dropped)
      if (!parsed) return
      children.push(parsed)
      const size = Array.isArray(split.sizes) ? split.sizes[i] : undefined
      sizes.push(typeof size === 'number' && size > 0 ? size : 1)
    })
    if (children.length === 0) return null
    // 자식이 하나만 살아남으면 split은 껍데기다. P17-4
    if (children.length === 1) return children[0]
    const sum = sizes.reduce((a, b) => a + b, 0)
    return { kind: 'split', direction, children, sizes: sizes.map((s) => s / sum) }
  }

  return null
}

/** 저장된 배치를 실제 세션 id에 붙여 되살린다. 세션이 없는 잎은 버린다 */
export function workspacesFromPersisted(
  persisted: PersistedWorkspace[],
  sessionIds: Array<string | null>
): Workspace[] {
  const out: Workspace[] = []

  for (const entry of persisted) {
    const focusedSession = sessionIds[entry.focusedIndex] ?? null
    let focusedPaneId: string | null = null

    const build = (node: PersistedPane): PaneNode | null => {
      if (node.kind === 'leaf') {
        const sessionId = sessionIds[node.sessionIndex]
        if (!sessionId) return null
        const leaf: PaneNode = { kind: 'leaf', id: randomUUID(), sessionId }
        if (sessionId === focusedSession && focusedPaneId === null) focusedPaneId = leaf.id
        return leaf
      }

      const children: PaneNode[] = []
      const sizes: number[] = []
      node.children.forEach((child, i) => {
        const built = build(child)
        if (!built) return
        children.push(built)
        sizes.push(node.sizes[i] ?? 1)
      })
      if (children.length === 0) return null
      if (children.length === 1) return children[0] // P17-4
      const sum = sizes.reduce((a, b) => a + b, 0)
      return {
        kind: 'split',
        id: randomUUID(),
        direction: node.direction,
        children,
        sizes: sizes.map((s) => s / sum)
      }
    }

    const root = build(entry.root)
    if (!root) continue
    out.push({
      id: randomUUID(),
      title: entry.title,
      root,
      focusedPaneId: focusedPaneId ?? firstLeafId(root)
    })
  }

  return out
}

/** 렌더러가 준 배치를 순번 기반으로 바꿔 저장 가능한 형태로 만든다 */
export function workspacesToPersisted(
  workspaces: Workspace[],
  sessionOrder: string[]
): PersistedWorkspace[] {
  const indexOf = new Map(sessionOrder.map((id, i) => [id, i]))
  const out: PersistedWorkspace[] = []

  for (const workspace of workspaces) {
    let focusedIndex = 0

    const convert = (node: PaneNode): PersistedPane | null => {
      if (node.kind === 'leaf') {
        const index = indexOf.get(node.sessionId)
        if (index === undefined) return null
        if (node.id === workspace.focusedPaneId) focusedIndex = index
        return { kind: 'leaf', sessionIndex: index }
      }
      const children: PersistedPane[] = []
      const sizes: number[] = []
      node.children.forEach((child, i) => {
        const converted = convert(child)
        if (!converted) return
        children.push(converted)
        sizes.push(node.sizes[i] ?? 1)
      })
      if (children.length === 0) return null
      if (children.length === 1) return children[0]
      return { kind: 'split', direction: node.direction, children, sizes }
    }

    const root = convert(workspace.root)
    if (!root) continue
    out.push({ title: workspace.title, root, focusedIndex })
  }

  return out
}

function firstLeafId(node: PaneNode): string {
  return node.kind === 'leaf' ? node.id : firstLeafId(node.children[0])
}

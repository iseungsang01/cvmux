import type { PaneNode, SessionMeta, SessionStatus, Workspace } from '@shared/types'
import { activeSurface, collectSessionIds, createLeaf, findLeaf } from './layout'

/**
 * 워크스페이스(사이드바 한 줄)와 그 안의 pane들을 잇는 유틸 (POLICY.md P17).
 */

/**
 * 대표 상태를 고르는 우선순위 (P17-7).
 *
 * 사이드바는 "지금 나를 필요로 하는가"를 알려주는 곳이므로, 여러 pane 중
 * 가장 손이 필요한 것을 대표로 세운다. 실행 중인 pane 하나가 확인을 기다리는
 * pane을 가려서는 안 된다.
 */
const PRIORITY: Record<SessionStatus, number> = {
  attention: 5,
  waiting: 4,
  busy: 3,
  idle: 2,
  exited: 1
}

let counter = 0
export function nextWorkspaceId(): string {
  counter += 1
  return `ws-${counter}-${Math.floor(performance.now())}`
}

export function makeWorkspace(sessionId: string, title: string | null = null): Workspace {
  const leaf = createLeaf(sessionId)
  return { id: nextWorkspaceId(), title, root: leaf, focusedPaneId: leaf.id }
}

/** 포커스된 pane이 지금 보여주고 있는 surface. P24 */
export function focusedSessionId(workspace: Workspace): string | null {
  const leaf = findLeaf(workspace.root, workspace.focusedPaneId)
  return leaf && leaf.kind === 'leaf' ? activeSurface(leaf) : null
}

export function sessionIdOfPane(root: PaneNode, paneId: string): string | null {
  const leaf = findLeaf(root, paneId)
  return leaf && leaf.kind === 'leaf' ? activeSurface(leaf) : null
}

/** 워크스페이스를 대표하는 세션. 사이드바의 상태·미리보기가 이걸 따른다. P17-7 / P17-8 */
export function representativeSession(
  workspace: Workspace,
  sessions: Map<string, SessionMeta>
): SessionMeta | null {
  const metas = collectSessionIds(workspace.root)
    .map((id) => sessions.get(id))
    .filter((m): m is SessionMeta => m !== undefined)

  if (metas.length === 0) return null

  // 미읽음 알림이 있으면 무조건 그쪽이 먼저다
  return metas.reduce((best, meta) => {
    if (meta.unread && !best.unread) return meta
    if (best.unread && !meta.unread) return best
    return PRIORITY[meta.status] > PRIORITY[best.status] ? meta : best
  })
}

/** 사이드바에 쓸 이름. 사용자가 지은 이름이 없으면 포커스된 pane의 세션 제목 */
export function workspaceTitle(
  workspace: Workspace,
  sessions: Map<string, SessionMeta>
): string {
  if (workspace.title !== null) return workspace.title
  const focused = focusedSessionId(workspace)
  const meta = focused !== null ? sessions.get(focused) : undefined
  if (meta) return meta.title
  return representativeSession(workspace, sessions)?.title ?? 'session'
}

/**
 * 목록에서 한 줄을 뽑아 다른 자리에 끼운다 (P19-8).
 *
 * 범위를 벗어난 자리는 원본을 그대로 돌려준다. 드래그가 목록 밖에서 끝나거나
 * 그 사이 세션이 닫혀 자리가 사라지는 일이 실제로 생기는데, 그때 순서가
 * 흐트러지는 것보다 아무 일도 일어나지 않는 편이 낫다.
 */
export function reorder<T>(list: T[], from: number, to: number): T[] {
  if (from === to) return list
  if (from < 0 || from >= list.length) return list
  if (to < 0 || to >= list.length) return list

  const next = [...list]
  const [moved] = next.splice(from, 1)
  next.splice(to, 0, moved)
  return next
}

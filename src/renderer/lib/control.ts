import { resolveHandle, M } from '@shared/protocol'
import type { PaneNode, SessionMeta, Workspace } from '@shared/types'
import { collectLeaves } from './layout'
import { focusedSessionId, sessionIdOfPane, workspaceTitle } from './workspace'

/**
 * 제어 소켓이 렌더러에게 묻는 것들 (P20-7).
 *
 * 워크스페이스와 pane 배치는 렌더러가 들고 있으므로, `workspace.*` / `pane.*` /
 * `notification.*`은 여기서 답한다. App은 상태를 만지는 방법만 넘겨 주고
 * 프로토콜 해석은 이 파일이 맡는다 — 그래야 App이 프로토콜을 몰라도 된다.
 */

export interface ControlContext {
  workspaces(): Workspace[]
  sessions(): Map<string, SessionMeta>
  activeId(): string | null

  select(workspaceId: string): void
  create(options: { cwd?: string; title?: string }): Promise<string>
  closeWorkspace(workspaceId: string): void
  rename(workspaceId: string, title: string | null): void
  split(
    workspaceId: string,
    paneId: string,
    direction: 'row' | 'column'
  ): Promise<{ paneId: string; sessionId: string }>
  focusPane(workspaceId: string, paneId: string): void
  closeSession(sessionId: string): void
  markRead(sessionId: string): void
  /** 알림함·팔레트·찾기를 열고 닫는다. P21-11 */
  setPanel(
    panel: 'notifications' | 'palette' | 'find',
    open: boolean,
    scope: 'session' | 'all',
    query?: string
  ): void
}

/** 소켓 클라이언트에게 그대로 보이는 오류. 사유가 사람이 읽을 수 있어야 한다 */
export class ControlRequestError extends Error {}

export async function handleControl(
  method: string,
  params: Record<string, unknown>,
  ctx: ControlContext
): Promise<unknown> {
  switch (method) {
    case M.WORKSPACE_LIST:
      return { workspaces: ctx.workspaces().map((w, i) => workspacePayload(w, i, ctx)) }

    case M.WORKSPACE_CURRENT: {
      const list = ctx.workspaces()
      const index = list.findIndex((w) => w.id === ctx.activeId())
      if (index === -1) throw new ControlRequestError('열린 워크스페이스가 없습니다')
      return workspacePayload(list[index], index, ctx)
    }

    case M.WORKSPACE_CREATE: {
      const cwd = optionalString(params.cwd)
      const title = optionalString(params.title)
      const workspaceId = await ctx.create({ cwd, title })
      const list = ctx.workspaces()
      const index = list.findIndex((w) => w.id === workspaceId)
      // 방금 만든 것이 목록에 아직 없을 수 있다 — id만이라도 돌려준다
      return index === -1
        ? { id: workspaceId }
        : workspacePayload(list[index], index, ctx)
    }

    case M.WORKSPACE_SELECT: {
      const workspace = pickWorkspace(params, ctx)
      ctx.select(workspace.id)
      return { id: workspace.id }
    }

    case M.WORKSPACE_CLOSE: {
      const workspace = pickWorkspace(params, ctx)
      ctx.closeWorkspace(workspace.id)
      return { id: workspace.id, closed: true }
    }

    case M.WORKSPACE_RENAME: {
      const workspace = pickWorkspace(params, ctx)
      const raw = params.title
      const title = raw === null || raw === '' ? null : String(raw ?? '')
      ctx.rename(workspace.id, title)
      return { id: workspace.id, title }
    }

    case M.WORKSPACE_TREE:
      return {
        workspaces: ctx.workspaces().map((w, i) => ({
          ...workspacePayload(w, i, ctx),
          tree: treePayload(w.root, ctx)
        }))
      }

    case M.PANE_LIST: {
      const workspace = pickWorkspace(params, ctx)
      return { workspace_id: workspace.id, panes: panePayloads(workspace, ctx) }
    }

    case M.PANE_SPLIT: {
      const workspace = pickWorkspace(params, ctx)
      const pane = pickPane(workspace, params)
      const raw = String(params.direction ?? 'right')
      const direction = splitDirection(raw)
      if (direction === null) {
        throw new ControlRequestError(`방향은 right/left/down/up 중 하나여야 합니다: ${raw}`)
      }
      const created = await ctx.split(workspace.id, pane, direction)
      return { workspace_id: workspace.id, pane_id: created.paneId, session_id: created.sessionId }
    }

    case M.PANE_FOCUS: {
      const workspace = pickWorkspace(params, ctx)
      const pane = pickPane(workspace, params)
      ctx.select(workspace.id)
      ctx.focusPane(workspace.id, pane)
      return { workspace_id: workspace.id, pane_id: pane }
    }

    case M.PANE_CLOSE: {
      const workspace = pickWorkspace(params, ctx)
      const pane = pickPane(workspace, params)
      const sessionId = sessionIdOfPane(workspace.root, pane)
      if (sessionId === null) throw new ControlRequestError('pane을 찾을 수 없습니다')
      ctx.closeSession(sessionId)
      return { workspace_id: workspace.id, pane_id: pane, closed: true }
    }

    /*
     * 알림이 온 세션으로 이동한다 (P21-4).
     *
     * 알림함은 main이 들고 있으므로 여기 오는 것은 이미 정해진 세션 하나다.
     * 렌더러가 아는 것은 "그 세션이 어느 워크스페이스의 어느 pane인가" 뿐이다.
     */
    case M.NOTIFICATION_OPEN: {
      const target = optionalString(params.session)
      if (target === undefined) throw new ControlRequestError('세션을 지정해야 합니다')
      const session = resolveSession(target, ctx)

      const located = locateSession(session.id, ctx)
      if (!located) throw new ControlRequestError('그 세션이 있는 워크스페이스를 찾지 못했습니다')

      ctx.select(located.workspace.id)
      ctx.focusPane(located.workspace.id, located.paneId)
      ctx.markRead(session.id)
      return {
        session_id: session.id,
        workspace_id: located.workspace.id,
        pane_id: located.paneId
      }
    }

    /*
     * 화면의 겹판을 소켓에서 연다 (P21-11).
     *
     * 스크립트가 사람을 대신해 앱을 조작할 수 있어야 한다는 것이 P20의 전제인데,
     * 알림함과 팔레트만 단축키로만 열리면 그 전제에 구멍이 난다.
     */
    case M.APP_PANEL: {
      const panel = optionalString(params.panel)
      if (panel !== 'notifications' && panel !== 'palette' && panel !== 'find') {
        throw new ControlRequestError('panel은 notifications/palette/find 중 하나여야 합니다')
      }
      const open = params.open !== false
      const scope = optionalString(params.scope) === 'all' ? 'all' : 'session'
      const query = optionalString(params.query)
      ctx.setPanel(panel, open, scope, query)
      return { panel, open, scope, query: query ?? null }
    }

    case M.APP_OPEN: {
      const path = optionalString(params.path)
      if (path === undefined) throw new ControlRequestError('열 경로가 없습니다')
      const workspaceId = await ctx.create({ cwd: path })
      return { id: workspaceId, cwd: path }
    }

    default:
      throw new ControlRequestError(`렌더러가 모르는 메서드: ${method}`)
  }
}

// ── 인자 해석 ──────────────────────────────────────────────────

function optionalString(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  return String(value)
}

/** 인자가 없으면 지금 보고 있는 워크스페이스. P20-4 */
function pickWorkspace(params: Record<string, unknown>, ctx: ControlContext): Workspace {
  const list = ctx.workspaces()
  const ref = optionalString(params.workspace)
  if (ref === undefined) {
    const active = list.find((w) => w.id === ctx.activeId())
    if (!active) throw new ControlRequestError('열린 워크스페이스가 없습니다')
    return active
  }
  const found = resolveHandle(list, ref, 'workspace')
  if (!found) throw new ControlRequestError(`워크스페이스를 찾을 수 없습니다: ${ref}`)
  return found
}

/** 인자가 없으면 그 워크스페이스에서 포커스된 pane */
function pickPane(workspace: Workspace, params: Record<string, unknown>): string {
  const ref = optionalString(params.pane)
  if (ref === undefined) return workspace.focusedPaneId
  const leaves = collectLeaves(workspace.root)
  const found = resolveHandle(leaves, ref, 'pane')
  if (!found) throw new ControlRequestError(`pane을 찾을 수 없습니다: ${ref}`)
  return found.id
}

function resolveSession(ref: string, ctx: ControlContext): SessionMeta {
  const sessions = [...ctx.sessions().values()]
  const found = resolveHandle(sessions, ref, 'session')
  if (!found) throw new ControlRequestError(`세션을 찾을 수 없습니다: ${ref}`)
  return found
}

/** cmux의 `--direction right|down`을 cvmux의 flex 방향으로. P17-1 */
function splitDirection(raw: string): 'row' | 'column' | null {
  if (raw === 'right' || raw === 'left' || raw === 'row' || raw === 'horizontal') return 'row'
  if (raw === 'down' || raw === 'up' || raw === 'column' || raw === 'vertical') return 'column'
  return null
}

// ── 응답 만들기 ────────────────────────────────────────────────

function workspacePayload(
  workspace: Workspace,
  index: number,
  ctx: ControlContext
): Record<string, unknown> {
  const sessions = ctx.sessions()
  const focused = focusedSessionId(workspace)
  const meta = focused !== null ? sessions.get(focused) : undefined
  return {
    id: workspace.id,
    // 참조 표기 — 스크립트가 다음 명령에 그대로 되쓸 수 있다. P20-4
    ref: `workspace:${index + 1}`,
    index: index + 1,
    title: workspaceTitle(workspace, sessions),
    user_title: workspace.title,
    selected: workspace.id === ctx.activeId(),
    focused_pane_id: workspace.focusedPaneId,
    focused_session_id: focused,
    cwd: meta?.cwd ?? null,
    branch: meta?.git?.branch ?? null,
    repo: meta?.git?.repo ?? null,
    ports: meta?.ports ?? [],
    status: meta?.status ?? null,
    unread: collectLeaves(workspace.root).some((l) => sessions.get(l.sessionId)?.unread === true),
    pane_count: collectLeaves(workspace.root).length
  }
}

function panePayloads(workspace: Workspace, ctx: ControlContext): Record<string, unknown>[] {
  const sessions = ctx.sessions()
  return collectLeaves(workspace.root).map((leaf, i) => {
    const meta = sessions.get(leaf.sessionId)
    return {
      id: leaf.id,
      ref: `pane:${i + 1}`,
      index: i + 1,
      session_id: leaf.sessionId,
      focused: leaf.id === workspace.focusedPaneId,
      title: meta?.title ?? null,
      cwd: meta?.cwd ?? null,
      status: meta?.status ?? null,
      unread: meta?.unread ?? false
    }
  })
}

function treePayload(node: PaneNode, ctx: ControlContext): unknown {
  if (node.kind === 'leaf') {
    const meta = ctx.sessions().get(node.sessionId)
    return {
      kind: 'leaf',
      id: node.id,
      session_id: node.sessionId,
      title: meta?.title ?? null,
      status: meta?.status ?? null
    }
  }
  return {
    kind: 'split',
    id: node.id,
    direction: node.direction,
    sizes: node.sizes,
    children: node.children.map((child) => treePayload(child, ctx))
  }
}

function locateSession(
  sessionId: string,
  ctx: ControlContext
): { workspace: Workspace; paneId: string } | null {
  for (const workspace of ctx.workspaces()) {
    const leaf = collectLeaves(workspace.root).find((l) => l.sessionId === sessionId)
    if (leaf) return { workspace, paneId: leaf.id }
  }
  return null
}

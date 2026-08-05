import { resolveHandle, M, M_INTERNAL, type ControlErrorCode } from '@shared/protocol'
import type { BrowserMeta, PaneNode, SessionMeta, Workspace } from '@shared/types'
import { collectAllSurfaces, collectLeaves } from './layout'
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
  /** 열려 있는 브라우저 화면. 탭 목록이 종류와 제목을 여기서 가져온다. P23-2 */
  browsers(): Map<string, BrowserMeta>
  activeId(): string | null
  /** 오른쪽 사이드바가 지금 열려 있는가 — toggle이 이걸 본다. P25-7 */
  rightSidebarOpen(): boolean

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
  /** 내장 브라우저를 pane으로 연다. P23-1 */
  openBrowser(url: string, direction: 'row' | 'column'): Promise<string>
  /** pane 안에 탭을 하나 더 연다. P24-6 */
  openSurface(
    workspaceId: string,
    paneId: string,
    kind: 'terminal' | 'browser',
    url?: string
  ): Promise<string>
  /** 탭을 고른다. P24-6 */
  selectSurface(workspaceId: string, paneId: string, index: number): void
  /** 잎 하나를 트리에서 걷어낸다 — 브라우저를 소켓에서 닫았을 때. P23-2 */
  dropSurface(surfaceId: string): void
  /**
   * 워크스페이스를 이 창에서 떼어 낸다 (P27-7).
   *
   * `closeWorkspace`와 다르다 — 세션을 죽이지 않는다. 다른 창이 그대로 이어받기
   * 때문이다.
   */
  detachWorkspace(workspaceId: string): void
  /** 다른 창에서 온 워크스페이스를 이 창에 붙이고 그것을 고른다. P27-7 */
  attachWorkspace(workspace: Workspace): void
  /** 오른쪽 사이드바를 열고 닫는다. P25-7 */
  setRightSidebar(open: boolean, mode?: 'log' | 'todo' | 'sessions' | 'find'): void
  /** 알림함·팔레트·찾기를 열고 닫는다. P21-11 */
  setPanel(
    panel: 'notifications' | 'palette' | 'find',
    open: boolean,
    scope: 'session' | 'all',
    query?: string
  ): void
}

/**
 * 소켓 클라이언트에게 그대로 보이는 오류 (P20-8).
 *
 * 사유뿐 아니라 **코드도 함께** 건넨다. 렌더러가 던진 것이 전부
 * `internal_error`로 뭉개지면, 스크립트는 "내가 잘못 불렀는가"와 "앱이
 * 고장났는가"를 구분하지 못한다.
 */
export class ControlRequestError extends Error {
  constructor(
    message: string,
    readonly code: ControlErrorCode = 'invalid_params'
  ) {
    super(message)
  }
}

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
      if (index === -1) throw new ControlRequestError('열린 워크스페이스가 없습니다', 'not_found')
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

    /*
     * 창 사이 이동 (P27-7).
     *
     * 떼어 내기와 붙이기는 항상 짝으로 온다 — main이 `window.move-workspace`
     * 하나에서 두 창의 렌더러를 차례로 부른다. 세션은 앱 전체가 들고 있으므로
     * 화면만 건너가고 돌던 명령은 그대로 돈다.
     */
    case M_INTERNAL.WORKSPACE_DETACH: {
      const workspace = pickWorkspace(params, ctx)
      ctx.detachWorkspace(workspace.id)
      return { workspace }
    }

    case M_INTERNAL.WORKSPACE_ATTACH: {
      const incoming = params.workspace as Workspace | undefined
      if (!incoming || typeof incoming !== 'object' || typeof incoming.id !== 'string') {
        throw new ControlRequestError('붙일 워크스페이스가 없습니다', 'invalid_params')
      }
      ctx.attachWorkspace(incoming)
      return { id: incoming.id, attached: true }
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

    // ── 가로 탭 (P24-6) ──────────────────────────────────────
    case M.SURFACE_LIST: {
      const workspace = pickWorkspace(params, ctx)
      const pane = pickPane(workspace, params)
      const leaf = collectLeaves(workspace.root).find((l) => l.id === pane)
      if (!leaf) throw new ControlRequestError('pane을 찾을 수 없습니다', 'not_found')
      return { workspace_id: workspace.id, pane_id: pane, surfaces: surfacePayloads(leaf, ctx) }
    }

    case M.SURFACE_NEW: {
      const workspace = pickWorkspace(params, ctx)
      const pane = pickPane(workspace, params)
      const kind = optionalString(params.kind) === 'browser' ? 'browser' : 'terminal'
      const id = await ctx.openSurface(workspace.id, pane, kind, optionalString(params.url))
      return { workspace_id: workspace.id, pane_id: pane, surface_id: id, kind }
    }

    case M.SURFACE_SELECT: {
      const workspace = pickWorkspace(params, ctx)
      const pane = pickPane(workspace, params)
      const leaf = collectLeaves(workspace.root).find((l) => l.id === pane)
      if (!leaf) throw new ControlRequestError('pane을 찾을 수 없습니다', 'not_found')

      const index = pickSurfaceIndex(leaf, params)
      ctx.selectSurface(workspace.id, pane, index)
      return { workspace_id: workspace.id, pane_id: pane, index, surface_id: leaf.surfaces[index] }
    }

    case M.SURFACE_CLOSE: {
      const workspace = pickWorkspace(params, ctx)
      const pane = pickPane(workspace, params)
      const leaf = collectLeaves(workspace.root).find((l) => l.id === pane)
      if (!leaf) throw new ControlRequestError('pane을 찾을 수 없습니다', 'not_found')

      // 인자가 없으면 지금 보고 있는 탭이다
      const index = params.surface === undefined ? leaf.active : pickSurfaceIndex(leaf, params)
      const surfaceId = leaf.surfaces[index]
      ctx.closeSession(surfaceId)
      return { workspace_id: workspace.id, pane_id: pane, surface_id: surfaceId, closed: true }
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
      if (sessionId === null) throw new ControlRequestError('pane을 찾을 수 없습니다', 'not_found')
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
      if (!located) throw new ControlRequestError('그 세션이 있는 워크스페이스를 찾지 못했습니다', 'not_found')

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

    /*
     * 브라우저 열기 (P23-1).
     *
     * 화면 자체는 main이 만들지만 그것이 어느 pane에 놓이는지는 렌더러만 안다.
     * 기본은 오른쪽 분할이다 — 터미널 옆에 두는 것이 이 기능의 요점이므로.
     */
    case M.BROWSER_OPEN: {
      const url = optionalString(params.url) ?? 'about:blank'
      const raw = String(params.direction ?? 'right')
      const direction = splitDirection(raw)
      if (direction === null) {
        throw new ControlRequestError(`방향은 right/left/down/up 중 하나여야 합니다: ${raw}`)
      }
      const id = await ctx.openBrowser(url, direction)
      return { id, url }
    }

    // main이 브라우저를 닫았다 — 그 pane도 없어져야 한다
    case 'browser.closed': {
      const id = optionalString(params.browser)
      if (id !== undefined) ctx.dropSurface(id)
      return { dropped: id ?? null }
    }

    /*
     * 오른쪽 사이드바 (P25-7).
     *
     * cmux의 `right-sidebar toggle|show|hide|set <mode>`와 같은 자리다.
     * 에이전트가 로그를 남긴 뒤 "여기 보라"고 열어 줄 수 있어야 한다.
     */
    case M.RIGHT_SIDEBAR: {
      const action = optionalString(params.action) ?? 'toggle'
      const mode = optionalString(params.mode)
      if (mode !== undefined && !['log', 'todo', 'sessions', 'find'].includes(mode)) {
        throw new ControlRequestError('mode는 log/todo/sessions/find 중 하나여야 합니다')
      }

      const known = ['toggle', 'show', 'hide', 'set']
      if (!known.includes(action)) {
        throw new ControlRequestError(`action은 ${known.join('/')} 중 하나여야 합니다`)
      }

      const open = action === 'hide' ? false : action === 'toggle' ? !ctx.rightSidebarOpen() : true
      ctx.setRightSidebar(open, mode as 'log' | 'todo' | 'sessions' | 'find' | undefined)
      return { open, mode: mode ?? null }
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
    if (!active) throw new ControlRequestError('열린 워크스페이스가 없습니다', 'not_found')
    return active
  }
  const found = resolveHandle(list, ref, 'workspace')
  if (!found) throw new ControlRequestError(`워크스페이스를 찾을 수 없습니다: ${ref}`, 'not_found')
  return found
}

/** 인자가 없으면 그 워크스페이스에서 포커스된 pane */
function pickPane(workspace: Workspace, params: Record<string, unknown>): string {
  const ref = optionalString(params.pane)
  if (ref === undefined) return workspace.focusedPaneId
  const leaves = collectLeaves(workspace.root)
  const found = resolveHandle(leaves, ref, 'pane')
  if (!found) throw new ControlRequestError(`pane을 찾을 수 없습니다: ${ref}`, 'not_found')
  return found.id
}

/**
 * 탭 지정 (P24-6).
 *
 * `surface:2` 같은 참조나 순번, 또는 surface id를 받는다. 없는 자리를 가리키면
 * 거부한다 — 가장 가까운 탭을 골라 주면 스크립트가 조용히 다른 탭을 닫는다.
 */
function pickSurfaceIndex(
  leaf: { surfaces: string[]; active: number },
  params: Record<string, unknown>
): number {
  const ref = optionalString(params.surface)
  if (ref === undefined) throw new ControlRequestError('탭을 지정해야 합니다 (--surface)')

  const bare = ref.startsWith('surface:') ? ref.slice(8) : ref
  if (/^\d+$/.test(bare)) {
    const index = Number.parseInt(bare, 10) - 1
    if (index < 0 || index >= leaf.surfaces.length) {
      throw new ControlRequestError(`탭이 ${leaf.surfaces.length}개입니다: ${ref}`)
    }
    return index
  }

  const found = leaf.surfaces.indexOf(bare)
  if (found === -1) throw new ControlRequestError(`탭을 찾을 수 없습니다: ${ref}`, 'not_found')
  return found
}

function resolveSession(ref: string, ctx: ControlContext): SessionMeta {
  const sessions = [...ctx.sessions().values()]
  const found = resolveHandle(sessions, ref, 'session')
  if (!found) throw new ControlRequestError(`세션을 찾을 수 없습니다: ${ref}`, 'not_found')
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
    unread: collectAllSurfaces(workspace.root).some((id) => sessions.get(id)?.unread === true),
    pane_count: collectLeaves(workspace.root).length
  }
}

function panePayloads(workspace: Workspace, ctx: ControlContext): Record<string, unknown>[] {
  const sessions = ctx.sessions()
  return collectLeaves(workspace.root).map((leaf, i) => {
    const meta = sessions.get(leaf.surfaceId)
    return {
      id: leaf.id,
      ref: `pane:${i + 1}`,
      index: i + 1,
      session_id: leaf.surfaceId,
      focused: leaf.id === workspace.focusedPaneId,
      title: meta?.title ?? null,
      cwd: meta?.cwd ?? null,
      status: meta?.status ?? null,
      unread: meta?.unread ?? false,
      // 가로 탭 (P24). 하나뿐이면 탭을 쓰지 않는 것과 같다
      surfaces: surfacePayloads(leaf, ctx),
      active_surface: leaf.active
    }
  })
}

/** pane 안의 탭 하나하나. `surface:2` 참조로 가리킬 수 있다. P24-6 */
function surfacePayloads(
  leaf: { surfaces: string[]; active: number },
  ctx: ControlContext
): Record<string, unknown>[] {
  const sessions = ctx.sessions()
  return leaf.surfaces.map((id, i) => {
    const meta = sessions.get(id)
    const browser = meta ? undefined : ctx.browsers().get(id)
    return {
      id,
      ref: `surface:${i + 1}`,
      index: i + 1,
      kind: meta ? 'terminal' : 'browser',
      active: i === leaf.active,
      /*
       * 브라우저 탭도 이름이 있어야 목록에서 무엇인지 알 수 있다.
       *
       * 아직 안 뜬 페이지의 제목은 `null`이 아니라 **빈 문자열**이라 `??`로는
       * 걸러지지 않는다. 그때는 주소를 대신 보여준다.
       */
      title: meta?.title || browser?.title || browser?.url || null,
      status: meta?.status ?? null,
      unread: meta?.unread ?? false
    }
  })
}

function treePayload(node: PaneNode, ctx: ControlContext): unknown {
  if (node.kind === 'leaf') {
    const active = node.surfaces[node.active] ?? node.surfaces[0]
    const meta = ctx.sessions().get(active)
    return {
      kind: 'leaf',
      id: node.id,
      session_id: active,
      title: meta?.title ?? null,
      status: meta?.status ?? null,
      surfaces: surfacePayloads(node, ctx)
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
    // 숨은 탭도 본다 — 알림이 온 세션이 뒤쪽 탭일 수 있다. P24-4
    const leaf = collectLeaves(workspace.root).find((l) => l.surfaces.includes(sessionId))
    if (leaf) return { workspace, paneId: leaf.id }
  }
  return null
}

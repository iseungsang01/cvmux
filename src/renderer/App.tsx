import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react'

import { DEFAULT_CONFIG, type CvmuxConfig } from '@shared/config'
import { actionFor, compileBindings, formatChord, type Chord } from '@shared/keys'
import type {
  BrowserMeta,
  Notification,
  RightSidebarMode,
  SessionMeta,
  UpdateState,
  Workspace,
  WorkspaceMeta
} from '@shared/types'
import { CommandPalette } from './components/CommandPalette'
import { FindBar, type FindHit } from './components/FindBar'
import { NotificationPanel } from './components/NotificationPanel'
import { RightSidebar } from './components/RightSidebar'
import { PaneTree } from './components/PaneTree'
import { Sidebar } from './components/Sidebar'
import {
  addSurface,
  closeSurface as closeSurfaceInTree,
  collectAllSurfaces,
  cycleSurface,
  findLeaf,
  findLeafBySession,
  firstLeafId,
  moveSurface,
  resizeSplit,
  selectSurface,
  splitPane
} from './lib/layout'
import { ControlRequestError, handleControl, type ControlContext } from './lib/control'
import type { Command } from './lib/palette'
import { focusedSessionId, makeWorkspace, reorder, sessionIdOfPane } from './lib/workspace'
import { TerminalHost } from './terminal-host'

/**
 * 앱 단축키 (P6-3 / P17-1 / P22-5).
 *
 * 조합은 설정 파일이 정한다. 기본값은 전부 `Shift`나 `Alt`가 붙어 있는데,
 * `Ctrl+C`·`Ctrl+N`·`Ctrl+P`·`Ctrl+F`·`Ctrl+I`는 PSReadLine과 bash가 쓰는
 * 키라 앱이 가로채면 안 되기 때문이다(P6-1). 바꾸는 것은 사용자의 몫이다.
 *
 * 동작 이름은 명령 팔레트의 항목 id와 같다 — 단축키와 팔레트가 같은 동작을
 * 가리키므로, 표를 둘로 나누면 언젠가 한쪽만 손보게 된다.
 */

export function App(): JSX.Element {
  const [sessions, setSessions] = useState<SessionMeta[]>([])
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** 이름을 고치고 있는 워크스페이스. 단축키가 바깥에서 편집을 열 수 있어야 한다. P19-3 */
  const [renamingId, setRenamingId] = useState<string | null>(null)

  // ── 알림함 · 팔레트 · 찾기 (P21) ─────────────────────────────
  const [notifications, setNotifications] = useState<Notification[]>([])
  const [inboxOpen, setInboxOpen] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [config, setConfig] = useState<CvmuxConfig>(DEFAULT_CONFIG)
  /** 열려 있는 내장 브라우저 화면. 잎이 가리키는 id가 여기 있으면 브라우저다. P23-2 */
  const [browsers, setBrowsers] = useState<Map<string, BrowserMeta>>(() => new Map())
  /** 워크스페이스마다 에이전트가 적어 둔 것. P25 */
  const [workspaceMeta, setWorkspaceMeta] = useState<Record<string, WorkspaceMeta>>({})
  const [rightSidebar, setRightSidebar] = useState<{ open: boolean; mode: RightSidebarMode }>({
    open: false,
    mode: 'log'
  })
  /** 자동 업데이트 상태. P26 */
  const [update, setUpdate] = useState<UpdateState>({
    status: 'idle',
    version: null,
    notes: null,
    error: null,
    percent: 0,
    // main이 곧 진짜 값을 내려준다 — 그 전까지는 비교할 것이 없다
    installed: ''
  })
  const [find, setFind] = useState<{
    open: boolean
    query: string
    scope: 'session' | 'all'
    index: number
    count: number
  }>({ open: false, query: '', scope: 'session', index: 0, count: 0 })

  // 이벤트 핸들러가 오래된 클로저를 붙잡지 않도록 최신 값을 ref로 들고 다닌다
  const activeIdRef = useRef<string | null>(null)
  const workspacesRef = useRef<Workspace[]>([])
  const sessionsRef = useRef<SessionMeta[]>([])
  const composingRef = useRef(false)
  /**
   * 저장된 배치를 이미 읽었는가 (P17 / P27-5).
   *
   * 읽기 전에는 저장하지 않는다 — 빈 상태를 먼저 밀어 넣으면 저장본이 지워진다.
   * 읽은 뒤에는 **비어도 저장한다**: 마지막 워크스페이스를 다른 창으로 보낸
   * 창이 그 사실을 알리지 못하면, main은 그 창이 아직 들고 있다고 믿는다.
   */
  const layoutLoadedRef = useRef(false)
  const browsersRef = useRef<Map<string, BrowserMeta>>(new Map())
  const rightSidebarRef = useRef(false)

  /**
   * 동작 실행기 (P22-5).
   *
   * 단축키 처리기는 이 아래 함수들보다 위에 있다 — 그쪽이 먼저 세션과 pane을
   * 다루기 때문이다. 최신 값을 ref로 건네는 것은 이 파일이 이미 쓰는 방식이다.
   */
  const runActionRef = useRef((_action: string): void => {})
  /** 지금 유효한 단축키 표. 설정이 바뀌면 그 자리에서 갈린다 */
  const bindingsRef = useRef(compileBindings(DEFAULT_CONFIG.keybindings))

  activeIdRef.current = activeId
  workspacesRef.current = workspaces
  sessionsRef.current = sessions
  browsersRef.current = browsers
  rightSidebarRef.current = rightSidebar.open

  const sessionMap = useMemo(() => new Map(sessions.map((s) => [s.id, s])), [sessions])
  const unreadCount = useMemo(() => notifications.filter((n) => !n.read).length, [notifications])
  const activeWorkspace = useMemo(
    () => workspaces.find((w) => w.id === activeId) ?? null,
    [workspaces, activeId]
  )

  const host = useMemo(
    () =>
      new TerminalHost({
        onInput: (id, data) => {
          void window.cvmux.write(id, data)
        },
        onResize: (id, cols, rows) => {
          void window.cvmux.resize(id, cols, rows)
        },
        onRestartRequest: (id) => {
          void window.cvmux.restart(id)
        },
        isAppShortcut: (event) => actionFor(bindingsRef.current, event) !== null
      }),
    []
  )

  /** 지금 포커스된 pane의 세션 — cwd 상속과 알림 판단에 쓴다 */
  const currentSession = useCallback((): SessionMeta | undefined => {
    const workspace = workspacesRef.current.find((w) => w.id === activeIdRef.current)
    if (!workspace) return undefined
    const sessionId = focusedSessionId(workspace)
    if (sessionId === null) return undefined
    return sessionsRef.current.find((s) => s.id === sessionId)
  }, [])

  /**
   * 새 워크스페이스 (P11-1).
   *
   * 만든 워크스페이스의 id를 돌려준다 — 제어 소켓이 방금 만든 것을 가리켜야
   * 하기 때문이다(P20-7). 실패는 예외로 올린다: 사이드바에는 사유를 띄우고,
   * 소켓 클라이언트에게도 같은 사유가 간다.
   */
  const createWorkspace = useCallback(
    async (options: { cwd?: string; title?: string } = {}): Promise<string> => {
      // 새 워크스페이스는 지금 보고 있던 작업 디렉토리를 물려받는다. P11-1
      const result = await window.cvmux.create({ cwd: options.cwd ?? currentSession()?.cwd })
      if (!result.ok || !result.session) {
        // 상한 초과 같은 실패는 사유를 그대로 보여준다. P1-8 / P12-1
        const message = result.error ?? '세션을 만들지 못했습니다.'
        setError(message)
        throw new Error(message)
      }
      setError(null)
      const workspace = makeWorkspace(result.session.id, options.title ?? null)
      setWorkspaces((prev) => [...prev, workspace])
      setActiveId(workspace.id)
      return workspace.id
    },
    [currentSession]
  )

  /** pane 하나를 둘로 나눈다. P17-1 / P17-2 */
  const splitPaneIn = useCallback(
    async (
      workspaceId: string,
      paneId: string,
      direction: 'row' | 'column'
    ): Promise<{ paneId: string; sessionId: string }> => {
      const workspace = workspacesRef.current.find((w) => w.id === workspaceId)
      if (!workspace) throw new Error('워크스페이스를 찾을 수 없습니다.')

      // 새 pane은 나눈 pane의 작업 디렉토리에서 시작한다. P17-2
      const source = sessionIdOfPane(workspace.root, paneId)
      const cwd = source !== null ? sessionsRef.current.find((s) => s.id === source)?.cwd : undefined
      const result = await window.cvmux.create({ cwd })
      if (!result.ok || !result.session) {
        const message = result.error ?? '세션을 만들지 못했습니다.'
        setError(message)
        throw new Error(message)
      }
      setError(null)

      const sessionId = result.session.id
      const split = splitPane(workspace.root, paneId, direction, sessionId)
      if (!split) {
        // 나눌 자리를 잃었다 — 방금 만든 세션을 되돌린다
        void window.cvmux.close(sessionId)
        throw new Error('나눌 pane이 사라졌습니다.')
      }

      setWorkspaces((prev) =>
        prev.map((w) =>
          w.id === workspace.id ? { ...w, root: split.root, focusedPaneId: split.newPaneId } : w
        )
      )
      return { paneId: split.newPaneId, sessionId }
    },
    []
  )

  const splitFocused = useCallback(
    async (direction: 'row' | 'column'): Promise<void> => {
      const workspace = workspacesRef.current.find((w) => w.id === activeIdRef.current)
      if (!workspace) return
      // 단축키로 나눌 때의 실패는 이미 사이드바에 적혔다 — 여기서 더 할 일이 없다
      await splitPaneIn(workspace.id, workspace.focusedPaneId, direction).catch(() => undefined)
    },
    [splitPaneIn]
  )

  /**
   * 잎 하나를 트리에서 걷어낸다 (P17-3 / P17-4).
   *
   * 세션이 죽었을 때와 브라우저를 닫았을 때가 같은 길을 쓴다 — 배치를 다루는
   * 코드가 둘을 구분할 이유가 없다.
   */
  const dropSurface = useCallback((surfaceId: string): void => {
    setWorkspaces((prev) =>
      prev.flatMap((workspace) => {
        if (findLeafBySession(workspace.root, surfaceId) === null) return [workspace]

        /*
         * 탭 하나만 걷어낸다 (P24-2).
         *
         * 세션이 죽었다고 pane을 통째로 없애면 같은 pane의 다른 탭들이 함께
         * 사라진다. 마지막 탭이었을 때만 pane이 사라지고, 그것이 워크스페이스의
         * 마지막이었으면 워크스페이스가 사라진다.
         */
        const next = closeSurfaceInTree(workspace.root, surfaceId)
        if (next === null) return []
        const stillThere = findLeaf(next, workspace.focusedPaneId) !== null
        return [
          {
            ...workspace,
            root: next,
            focusedPaneId: stillThere ? workspace.focusedPaneId : firstLeafId(next)
          }
        ]
      })
    )
  }, [])

  // ── 가로 탭 (P24) ────────────────────────────────────────────

  const handleSelectSurface = useCallback((paneId: string, index: number): void => {
    setWorkspaces((prev) =>
      prev.map((w) =>
        w.id === activeIdRef.current ? { ...w, root: selectSurface(w.root, paneId, index) } : w
      )
    )
  }, [])

  /** 탭을 끌어 자리를 바꾼다. 저장은 배치 변경을 지켜보는 기존 경로가 한다. P24-3 */
  const handleMoveSurface = useCallback((paneId: string, from: number, to: number): void => {
    setWorkspaces((prev) =>
      prev.map((w) =>
        w.id === activeIdRef.current ? { ...w, root: moveSurface(w.root, paneId, from, to) } : w
      )
    )
  }, [])

  /**
   * 지금 pane에 탭을 하나 더 연다 (P24-1).
   *
   * 분할과 다르다 — 분할은 화면을 나누고, 탭은 같은 자리를 겹쳐 쓴다. 화면이
   * 좁은데 세션은 더 필요할 때 이쪽이 맞다.
   */
  const openSurfaceIn = useCallback(
    async (
      workspaceId: string,
      paneId: string,
      kind: 'terminal' | 'browser',
      url = 'about:blank'
    ): Promise<string> => {
      let surfaceId: string
      if (kind === 'browser') {
        const meta = await window.cvmux.browserCreate(url)
        setBrowsers((prev) => new Map(prev).set(meta.id, meta))
        surfaceId = meta.id
      } else {
        // 새 탭은 같은 pane이 보고 있던 작업 디렉토리에서 시작한다. P17-2와 같은 이유
        const source = workspacesRef.current.find((w) => w.id === workspaceId)
        const from = source ? sessionIdOfPane(source.root, paneId) : null
        const cwd = from !== null ? sessionsRef.current.find((s) => s.id === from)?.cwd : undefined
        const result = await window.cvmux.create({ cwd })
        if (!result.ok || !result.session) {
          const message = result.error ?? '세션을 만들지 못했습니다.'
          setError(message)
          throw new Error(message)
        }
        setError(null)
        surfaceId = result.session.id
      }

      setWorkspaces((prev) =>
        prev.map((w) => {
          if (w.id !== workspaceId) return w
          const next = addSurface(w.root, paneId, surfaceId)
          return next ? { ...w, root: next } : w
        })
      )
      return surfaceId
    },
    []
  )

  /** 단축키·팔레트에서 쓰는 짧은 길 — 지금 보고 있는 pane에 연다 */
  const openSurface = useCallback(
    async (kind: 'terminal' | 'browser' = 'terminal', url = 'about:blank'): Promise<void> => {
      const workspace = workspacesRef.current.find((w) => w.id === activeIdRef.current)
      if (!workspace) return
      await openSurfaceIn(workspace.id, workspace.focusedPaneId, kind, url).catch(() => undefined)
    },
    [openSurfaceIn]
  )

  const cycleFocusedSurface = useCallback((delta: number): void => {
    setWorkspaces((prev) =>
      prev.map((w) =>
        w.id === activeIdRef.current ? { ...w, root: cycleSurface(w.root, w.focusedPaneId, delta) } : w
      )
    )
  }, [])

  /** 터미널이든 브라우저든 이 id가 가리키는 것을 끝낸다. P23-2 */
  const closeSurface = useCallback(
    (surfaceId: string): void => {
      if (browsersRef.current.has(surfaceId)) {
        void window.cvmux.browserClose(surfaceId)
        // 브라우저에는 세션 종료 이벤트가 없다 — 여기서 직접 걷어낸다
        dropSurface(surfaceId)
        return
      }
      void window.cvmux.close(surfaceId)
    },
    [dropSurface]
  )

  /** 포커스된 pane을 닫는다. 세션을 끝내면 onClosed가 트리를 정리한다. P17-3 */
  const closeFocusedPane = useCallback((): void => {
    const workspace = workspacesRef.current.find((w) => w.id === activeIdRef.current)
    if (!workspace) return
    const sessionId = focusedSessionId(workspace)
    if (sessionId !== null) closeSurface(sessionId)
  }, [closeSurface])

  /**
   * 워크스페이스를 이 창에서 떼어 낸다 (P27-7).
   *
   * `closeWorkspace`와 다르다 — 세션을 죽이지 않는다. 다른 창이 그대로
   * 이어받으므로 돌던 명령은 계속 돈다.
   */
  const detachWorkspace = useCallback((workspaceId: string): void => {
    setWorkspaces((prev) => {
      const next = prev.filter((w) => w.id !== workspaceId)
      setActiveId((active) => (active === workspaceId ? (next[0]?.id ?? null) : active))
      return next
    })
  }, [])

  /** 다른 창에서 온 워크스페이스를 붙이고 그것을 보여 준다. P27-7 */
  const attachWorkspace = useCallback((workspace: Workspace): void => {
    setWorkspaces((prev) => (prev.some((w) => w.id === workspace.id) ? prev : [...prev, workspace]))
    setActiveId(workspace.id)
  }, [])

  const closeWorkspace = useCallback(
    (workspaceId: string): void => {
      const workspace = workspacesRef.current.find((w) => w.id === workspaceId)
      if (!workspace) return
      // 워크스페이스를 닫으면 그 안의 pane 전부를 끝낸다
      for (const leaf of collectAllSurfaces(workspace.root)) closeSurface(leaf)
    },
    [closeSurface]
  )

  // ── 초기 로드 ────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const [list, layout] = await Promise.all([window.cvmux.list(), window.cvmux.loadLayout()])
      if (cancelled) return
      setSessions(list)

      // 저장된 레이아웃이 있으면 그대로, 없으면 세션마다 pane 하나짜리 워크스페이스. P17
      const restored = layout.workspaces.filter((w) =>
        collectAllSurfaces(w.root).every((id) => list.some((s) => s.id === id))
      )
      /*
       * 떠도는 세션은 main이 골라 준다 (P27-5).
       *
       * 여기서 "내 배치에 없는 것"으로 판단하면 옆 창이 이미 보여주는 세션까지
       * 맡아 같은 세션이 두 창에 겹쳐 뜬다. 창은 자기 배치만 안다.
       */
      const alive = new Set(list.map((s) => s.id))
      const leftovers = layout.orphanSessions
        .filter((id) => alive.has(id))
        .map((id) => makeWorkspace(id))
      const all = [...restored, ...leftovers]

      layoutLoadedRef.current = true
      if (all.length > 0) {
        setWorkspaces(all)
        setActiveId(all[0].id)
      } else {
        // 첫 세션을 못 만들면 사유가 이미 화면에 있다. 빈 상태로 두고 기다린다. P1-7
        await createWorkspace().catch(() => undefined)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [createWorkspace])

  // ── main 이벤트 구독 ─────────────────────────────────────────
  useEffect(() => {
    const offData = window.cvmux.onData((id, chunk) => {
      host.write(id, chunk)
    })

    const offMeta = window.cvmux.onMeta((meta) => {
      host.setStatus(meta.id, meta.status)
      // 사용자가 보고 있는 pane의 알림은 미읽음으로 쌓지 않는다. P4-4
      const workspace = workspacesRef.current.find((w) => w.id === activeIdRef.current)
      if (meta.unread && workspace && focusedSessionId(workspace) === meta.id) {
        void window.cvmux.markRead(meta.id)
      }
      setSessions((prev) => prev.map((s) => (s.id === meta.id ? meta : s)))
    })

    const offCreated = window.cvmux.onCreated((meta) => {
      setSessions((prev) => (prev.some((s) => s.id === meta.id) ? prev : [...prev, meta]))
    })

    const offClosed = window.cvmux.onClosed((id) => {
      host.dispose(id)
      setSessions((prev) => prev.filter((s) => s.id !== id))
      // 세션이 끝나면 그 pane을 트리에서 걷어낸다. 마지막 pane이었다면
      // 워크스페이스 자체가 사라진다. P17-3 / P17-4
      dropSurface(id)
    })

    // 종료 자체는 meta 이벤트로도 전달된다. 여기서는 별도 처리가 없다. P1-1
    const offExit = window.cvmux.onExit(() => {})

    // 토스트를 클릭했다 — 그 세션이 있는 워크스페이스로 이동한다. P15-5
    const offActivate = window.cvmux.onActivate((sessionId) => {
      const workspace = workspacesRef.current.find(
        (w) => findLeafBySession(w.root, sessionId) !== null
      )
      if (!workspace) return
      const leaf = findLeafBySession(workspace.root, sessionId)
      setActiveId(workspace.id)
      if (leaf) {
        setWorkspaces((prev) =>
          prev.map((w) => (w.id === workspace.id ? { ...w, focusedPaneId: leaf.id } : w))
        )
      }
    })

    return () => {
      offData()
      offMeta()
      offCreated()
      offClosed()
      offExit()
      offActivate()
    }
  }, [host])

  // 창이 닫힐 때 xterm 인스턴스를 정리한다
  useEffect(() => () => host.disposeAll(), [host])

  // 레이아웃이 바뀔 때마다 main에 넘겨 저장하게 한다. P16 / P17
  useEffect(() => {
    if (!layoutLoadedRef.current) return
    void window.cvmux.saveLayout(workspaces)
  }, [workspaces])

  // 편집하던 줄이 사라졌다 — 열린 편집기를 닫는다
  useEffect(() => {
    if (renamingId !== null && !workspaces.some((w) => w.id === renamingId)) setRenamingId(null)
  }, [workspaces, renamingId])

  // ── 활성 워크스페이스 유지 ───────────────────────────────────
  useEffect(() => {
    if (activeId !== null && workspaces.some((w) => w.id === activeId)) return
    // 마지막 워크스페이스를 닫아도 앱은 살아있고, 빈 상태 화면을 보여준다. P1-7
    setActiveId(workspaces[0]?.id ?? null)
  }, [workspaces, activeId])

  // 워크스페이스를 옮겨 가면 main에 알린다 — 소켓의 `workspace.selected`가 여기서 나온다
  useEffect(() => {
    void window.cvmux.setActiveWorkspace(activeId)
  }, [activeId])

  // 포커스된 pane이 바뀌면 main에 알리고(P15-2) 미읽음을 해제한다(P4-5)
  const focusedId = activeWorkspace ? focusedSessionId(activeWorkspace) : null
  useEffect(() => {
    void window.cvmux.setActive(focusedId)
    if (focusedId === null) return
    void window.cvmux.markRead(focusedId)
    host.focus(focusedId)
  }, [focusedId, host])

  // ── 단축키 ───────────────────────────────────────────────────
  useEffect(() => {
    const onCompositionStart = (): void => {
      composingRef.current = true
    }
    const onCompositionEnd = (): void => {
      composingRef.current = false
    }

    const onKeyDown = (event: KeyboardEvent): void => {
      // 한글 조합 중에는 앱 단축키를 처리하지 않는다. P6-4
      if (composingRef.current || event.isComposing) return

      const action = actionFor(bindingsRef.current, event)
      if (action === null) return

      event.preventDefault()
      event.stopPropagation()
      runActionRef.current(action)
    }

    // capture 단계에서 잡아야 xterm의 textarea보다 먼저 받는다
    window.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('compositionstart', onCompositionStart, true)
    window.addEventListener('compositionend', onCompositionEnd, true)
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('compositionstart', onCompositionStart, true)
      window.removeEventListener('compositionend', onCompositionEnd, true)
    }
  }, [])

  // 사이드바 애니메이션이 끝난 뒤에 크기를 다시 맞춘다. P5-5
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const workspace = workspacesRef.current.find((w) => w.id === activeIdRef.current)
      if (!workspace) return
      for (const sessionId of collectAllSurfaces(workspace.root)) host.refit(sessionId)
    }, 220)
    return () => window.clearTimeout(timer)
  }, [sidebarCollapsed, host])

  // 최소화 → 복원, 다른 앱에서 돌아왔을 때 크기를 다시 맞춘다. P5-6
  useEffect(() => {
    const onFocus = (): void => {
      const workspace = workspacesRef.current.find((w) => w.id === activeIdRef.current)
      if (!workspace) return
      for (const sessionId of collectAllSurfaces(workspace.root)) host.refit(sessionId)
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [host])

  const focusPaneIn = useCallback((workspaceId: string, paneId: string): void => {
    setWorkspaces((prev) =>
      prev.map((w) => (w.id === workspaceId ? { ...w, focusedPaneId: paneId } : w))
    )
  }, [])

  const handleFocusPane = useCallback(
    (paneId: string): void => {
      if (activeIdRef.current === null) return
      focusPaneIn(activeIdRef.current, paneId)
    },
    [focusPaneIn]
  )

  /**
   * 사용자가 지은 이름 (P19-3).
   *
   * 워크스페이스에 붙인다 — 사이드바 한 줄이 곧 워크스페이스이고, 세션이 아니라
   * 이 줄에 이름을 다는 것이 사용자가 보는 그림과 맞는다. 배치가 바뀌면 저장이
   * 따라오므로(P17) 다시 켜도 이름이 남는다.
   */
  const renameWorkspace = useCallback((workspaceId: string, title: string | null): void => {
    setWorkspaces((prev) => prev.map((w) => (w.id === workspaceId ? { ...w, title } : w)))
  }, [])

  /**
   * 사이드바 줄 순서 바꾸기 (P19-8).
   *
   * 배열 위치가 곧 화면의 자리이고 `Ctrl+Alt+숫자`의 번호이므로, 옮기면 번호도
   * 따라 바뀐다 — 자주 쓰는 세션을 앞으로 끌어다 두면 1번이 되는 것이 자연스럽다.
   * 저장은 배치 변경을 지켜보는 기존 경로가 알아서 한다(P16 / P17).
   */
  const reorderWorkspaces = useCallback((from: number, to: number): void => {
    setWorkspaces((prev) => reorder(prev, from, to))
  }, [])

  const handleResize = useCallback(
    (splitId: string, dividerIndex: number, delta: number, minRatio: number): void => {
      setWorkspaces((prev) =>
        prev.map((w) =>
          w.id === activeIdRef.current
            ? { ...w, root: resizeSplit(w.root, splitId, dividerIndex, delta, minRatio) }
            : w
        )
      )
    },
    []
  )

  // ── 알림함 (P21) ─────────────────────────────────────────────
  useEffect(() => {
    void window.cvmux.notifications().then(setNotifications)
    return window.cvmux.onNotifications(setNotifications)
  }, [])

  /** 세션이 있는 워크스페이스로 이동한다. 알림함과 `jump-to-unread`가 함께 쓴다 */
  const revealSession = useCallback((sessionId: string): boolean => {
    const workspace = workspacesRef.current.find(
      (w) => findLeafBySession(w.root, sessionId) !== null
    )
    if (!workspace) return false
    const leaf = findLeafBySession(workspace.root, sessionId)
    setActiveId(workspace.id)
    if (leaf) focusPaneIn(workspace.id, leaf.id)
    void window.cvmux.markRead(sessionId)
    return true
  }, [focusPaneIn])

  const openNotification = useCallback(
    (item: Notification): void => {
      void window.cvmux.notificationRead(item.id)
      // 세션이 이미 닫혔을 수 있다. 그래도 알림은 읽음이 된다 — 사용자는 봤다
      revealSession(item.sessionId)
      setInboxOpen(false)
    },
    [revealSession]
  )

  /** 가장 최근 읽지 않은 알림으로. P21-4 */
  const jumpToUnread = useCallback((): void => {
    const latest = notifications.find((n) => !n.read)
    if (!latest) return
    openNotification(latest)
  }, [notifications, openNotification])

  // ── 찾기 (P21-9 / P21-10) ────────────────────────────────────

  /** 지금 화면에서 몇 번째인지 — 검색 애드온이 알려 준다 */
  useEffect(() => {
    if (!find.open || find.scope !== 'session' || focusedId === null) return
    return host.onSearchResults(focusedId, (index, count) => {
      setFind((prev) => (prev.index === index && prev.count === count ? prev : { ...prev, index, count }))
    })
  }, [find.open, find.scope, focusedId, host])

  // 질의가 바뀌면 첫 번째 자리를 찾아 둔다. 타이핑하는 동안 결과가 따라온다
  useEffect(() => {
    if (!find.open || find.scope !== 'session' || focusedId === null) return
    if (find.query === '') {
      host.clearSearch(focusedId)
      setFind((prev) => ({ ...prev, index: 0, count: 0 }))
      return
    }
    host.find(focusedId, find.query)
  }, [find.open, find.query, find.scope, focusedId, host])

  /**
   * 모든 세션에서 찾기 (P21-10).
   *
   * 이 앱에서 cmux의 "디렉토리에서 찾기"에 해당하는 것은 파일이 아니라
   * **세션들의 화면**이다 — 여기 쌓여 있는 것이 그것이고, 실제 질문은 "그 오류를
   * 어느 세션에서 봤더라"이기 때문이다.
   */
  const findHits = useMemo((): FindHit[] => {
    if (!find.open || find.scope !== 'all' || find.query.trim() === '') return []

    const needle = find.query.toLowerCase()
    const hits: FindHit[] = []
    for (const workspace of workspaces) {
      // 숨은 탭의 화면에서도 찾는다 — "어느 세션에서 봤더라"가 질문이므로. P24-4
      for (const surfaceId of collectAllSurfaces(workspace.root)) {
        const meta = sessionMap.get(surfaceId)
        if (!meta) continue
        const lines = host.bufferText(surfaceId)
        lines.forEach((text, line) => {
          if (hits.length >= 200) return
          if (!text.toLowerCase().includes(needle)) return
          hits.push({
            sessionId: surfaceId,
            sessionTitle: meta.title,
            workspaceId: workspace.id,
            line,
            text
          })
        })
      }
    }
    return hits
  }, [find.open, find.query, find.scope, workspaces, sessionMap, host])

  const pickHit = useCallback(
    (hit: FindHit): void => {
      setActiveId(hit.workspaceId)
      const workspace = workspacesRef.current.find((w) => w.id === hit.workspaceId)
      const leaf = workspace ? findLeafBySession(workspace.root, hit.sessionId) : null
      if (workspace && leaf) focusPaneIn(workspace.id, leaf.id)
      // 세션을 바꾼 뒤라 레이아웃이 아직 없다. 다음 프레임에 그 줄로 간다
      requestAnimationFrame(() => host.scrollToLine(hit.sessionId, hit.line))
    },
    [focusPaneIn, host]
  )

  const closeFind = useCallback((): void => {
    if (focusedId !== null) host.clearSearch(focusedId)
    setFind((prev) => ({ ...prev, open: false, query: '', index: 0, count: 0 }))
    if (focusedId !== null) host.focus(focusedId)
  }, [focusedId, host])

  const openFind = useCallback((scope: 'session' | 'all'): void => {
    setFind((prev) => ({ ...prev, open: true, scope, index: 0, count: 0 }))
  }, [])

  // ── 자동 업데이트 (P26) ──────────────────────────────────────
  useEffect(() => {
    void window.cvmux.updateState().then(setUpdate)
    return window.cvmux.onUpdate(setUpdate)
  }, [])

  // ── 사이드바 메타데이터 (P25) ────────────────────────────────
  useEffect(() => {
    void window.cvmux.workspaceMeta().then(setWorkspaceMeta)
    return window.cvmux.onWorkspaceMeta(setWorkspaceMeta)
  }, [])

  // ── 내장 브라우저 (P23) ──────────────────────────────────────
  useEffect(() => {
    void window.cvmux.browserList().then((list) => {
      setBrowsers(new Map(list.map((b) => [b.id, b])))
    })
    // 주소·제목·로딩이 바뀔 때마다 그 화면만 갈아 끼운다
    return window.cvmux.onBrowser((meta) => {
      setBrowsers((prev) => new Map(prev).set(meta.id, meta))
    })
  }, [])

  /**
   * 브라우저를 pane으로 연다 (P23-1).
   *
   * 터미널 옆에 두는 것이 이 기능의 요점이므로 기본은 **오른쪽 분할**이다.
   * 에이전트가 고친 화면을 보면서 셸을 그대로 쓸 수 있어야 한다.
   */
  const openBrowser = useCallback(
    async (url: string, direction: 'row' | 'column' = 'row'): Promise<string> => {
      const workspace = workspacesRef.current.find((w) => w.id === activeIdRef.current)
      if (!workspace) throw new Error('열린 워크스페이스가 없습니다.')

      const meta = await window.cvmux.browserCreate(url)
      setBrowsers((prev) => new Map(prev).set(meta.id, meta))

      const split = splitPane(workspace.root, workspace.focusedPaneId, direction, meta.id)
      if (!split) {
        void window.cvmux.browserClose(meta.id)
        throw new Error('나눌 pane이 사라졌습니다.')
      }
      setWorkspaces((prev) =>
        prev.map((w) =>
          w.id === workspace.id ? { ...w, root: split.root, focusedPaneId: split.newPaneId } : w
        )
      )
      return meta.id
    },
    []
  )

  // ── 설정 (P22) ───────────────────────────────────────────────
  useEffect(() => {
    void window.cvmux.config().then(setConfig)
    return window.cvmux.onConfig(setConfig)
  }, [])

  const bindings = useMemo(() => compileBindings(config.keybindings), [config.keybindings])
  bindingsRef.current = bindings

  // 폰트·색·커서는 그 자리에서 바뀐다. 셸처럼 세션을 만들 때 쓰이는 값은 main이 본다
  useEffect(() => {
    host.applyConfig(config)
  }, [config, host])

  // 사이드바 폭과 글자 크기는 CSS 변수 하나로 내려보낸다
  useEffect(() => {
    const root = document.documentElement
    root.style.setProperty('--sidebar-width', `${config.sidebar.width}px`)
    root.style.setProperty('--sidebar-font-size', `${config.sidebar.fontSize}px`)
  }, [config.sidebar])

  /** 단축키 안내. 설정에서 바꾼 조합이 팔레트에도 그대로 보인다. P22-5 */
  const hint = useCallback(
    (action: string): string | undefined => {
      const chord: Chord | undefined = bindings.get(action)
      return chord ? formatChord(chord) : undefined
    },
    [bindings]
  )

  // ── 명령 팔레트 (P21-6) ──────────────────────────────────────

  /**
   * 팔레트에 담기는 것들.
   *
   * 단축키가 있는 것은 조합을 함께 적는다 — 팔레트는 명령을 실행하는 자리이자
   * 단축키를 배우는 자리다. 열려 있는 워크스페이스도 항목으로 넣는다: 이름으로
   * 세션을 찾는 것이 `Ctrl+Alt+숫자`보다 자연스러운 순간이 있다.
   */
  const commands = useMemo((): Command[] => {
    const unread = notifications.filter((n) => !n.read).length
    const list: Command[] = [
      {
        id: 'workspace.new',
        title: '새 세션',
        keywords: 'new workspace session create',
        hint: hint('workspace.new'),
        section: '세션',
        run: () => void createWorkspace().catch(() => undefined)
      },
      {
        id: 'window.new',
        title: '새 창',
        keywords: 'new window 창',
        hint: hint('window.new'),
        section: '세션',
        run: () => void window.cvmux.newWindow().catch(() => undefined)
      },
      {
        id: 'pane.split.right',
        title: '오른쪽으로 분할',
        keywords: 'split right vertical pane',
        hint: hint('pane.split.right'),
        section: 'pane',
        run: () => void splitFocused('row')
      },
      {
        id: 'pane.split.down',
        title: '아래로 분할',
        keywords: 'split down horizontal pane',
        hint: hint('pane.split.down'),
        section: 'pane',
        run: () => void splitFocused('column')
      },
      {
        id: 'pane.close',
        title: '이 pane 닫기',
        keywords: 'close pane kill',
        hint: hint('pane.close'),
        section: 'pane',
        run: closeFocusedPane
      },
      {
        id: 'session.restart',
        title: '세션 재시작',
        keywords: 'restart respawn reload session',
        section: '세션',
        enabled: focusedId !== null,
        run: () => {
          if (focusedId !== null) void window.cvmux.restart(focusedId)
        }
      },
      {
        id: 'workspace.rename',
        title: '이름 바꾸기',
        keywords: 'rename title',
        hint: hint('workspace.rename'),
        section: '세션',
        enabled: activeId !== null,
        run: () => {
          setSidebarCollapsed(false)
          setRenamingId(activeIdRef.current)
        }
      },
      {
        id: 'find.session',
        title: '이 화면에서 찾기',
        keywords: 'find search buffer',
        hint: hint('find.session'),
        section: '찾기',
        run: () => openFind('session')
      },
      {
        id: 'find.all',
        title: '모든 세션에서 찾기',
        keywords: 'find search all sessions global',
        hint: hint('find.all'),
        section: '찾기',
        run: () => openFind('all')
      },
      {
        id: 'notifications.show',
        title: unread > 0 ? `알림 보기 (${unread})` : '알림 보기',
        keywords: 'notifications inbox bell alerts',
        hint: hint('notifications.show'),
        section: '알림',
        run: () => setInboxOpen(true)
      },
      {
        id: 'notifications.jump',
        title: '읽지 않은 알림으로 이동',
        keywords: 'jump unread notification next',
        hint: hint('notifications.jump'),
        section: '알림',
        enabled: unread > 0,
        run: jumpToUnread
      },
      {
        id: 'notifications.clear',
        title: '읽은 알림 치우기',
        keywords: 'clear notifications read dismiss',
        section: '알림',
        enabled: notifications.some((n) => n.read),
        run: () => void window.cvmux.notificationsClear('read')
      },
      {
        id: 'surface.new',
        title: '새 탭 (이 pane 안에)',
        keywords: 'new surface tab pane',
        hint: hint('surface.new'),
        section: 'pane',
        run: () => void openSurface('terminal').catch(() => undefined)
      },
      {
        id: 'surface.next',
        title: '다음 탭',
        keywords: 'next surface tab',
        hint: hint('surface.next'),
        section: 'pane',
        run: () => cycleFocusedSurface(1)
      },
      {
        id: 'surface.previous',
        title: '이전 탭',
        keywords: 'previous surface tab',
        hint: hint('surface.previous'),
        section: 'pane',
        run: () => cycleFocusedSurface(-1)
      },
      {
        id: 'browser.open',
        title: '브라우저 열기',
        keywords: 'browser open web preview page',
        // 기본 단축키가 없다 — 팔레트로만 연다. `session.restart`와 같은 자리다
        section: '브라우저',
        run: () => void openBrowser('about:blank').catch(() => undefined)
      },
      {
        id: 'update.check',
        title:
          update.status === 'ready'
            ? `업데이트 설치 (${update.version ?? '새 버전'})`
            : update.status === 'downloading'
              ? `업데이트 내려받는 중 ${update.percent}%`
              : '업데이트 확인',
        keywords: 'update upgrade version check install',
        section: '앱',
        run: () => {
          // 준비됐으면 설치가, 아니면 확인이 지금 할 일이다
          if (update.status === 'ready') void window.cvmux.updateInstall()
          else void window.cvmux.updateCheck().then(setUpdate)
        }
      },
      {
        id: 'view.right-sidebar',
        title: rightSidebar.open ? '오른쪽 사이드바 닫기' : '오른쪽 사이드바',
        keywords: 'right sidebar log todo panel',
        hint: hint('view.right-sidebar'),
        section: '보기',
        run: () => setRightSidebar((prev) => ({ ...prev, open: !prev.open }))
      },
      {
        id: 'view.sidebar',
        title: sidebarCollapsed ? '사이드바 펴기' : '사이드바 접기',
        keywords: 'sidebar toggle view',
        hint: hint('view.sidebar'),
        section: '보기',
        run: () => setSidebarCollapsed((v) => !v)
      }
    ]

    // 열려 있는 워크스페이스로 바로 가기
    workspaces.forEach((workspace, index) => {
      const meta = sessionMap.get(focusedSessionId(workspace) ?? '')
      const title = workspace.title ?? meta?.title ?? `세션 ${index + 1}`
      list.push({
        id: `goto.${workspace.id}`,
        title,
        keywords: `goto switch workspace ${meta?.git?.repo ?? ''} ${meta?.cwd ?? ''}`,
        hint: index < 8 ? hint(`workspace.select.${index + 1}`) : undefined,
        section: '이동',
        enabled: workspace.id !== activeId,
        run: () => setActiveId(workspace.id)
      })
    })

    return list
  }, [
    activeId,
    closeFocusedPane,
    createWorkspace,
    focusedId,
    hint,
    jumpToUnread,
    cycleFocusedSurface,
    notifications,
    openBrowser,
    openFind,
    openSurface,
    sessionMap,
    rightSidebar.open,
    sidebarCollapsed,
    update,
    splitFocused,
    workspaces
  ])

  /*
   * 단축키가 곧 팔레트 항목이다 (P22-5).
   *
   * 눌린 조합이 가리키는 동작 이름으로 명령을 찾아 그대로 실행한다. 표를 둘로
   * 나누면 언젠가 한쪽만 손보게 되고, 그러면 팔레트로는 되는데 단축키로는 안
   * 되는 동작이 생긴다.
   */
  runActionRef.current = (action: string): void => {
    const select = /^workspace\.select\.([1-8])$/.exec(action)
    if (select) {
      const target = workspacesRef.current[Number.parseInt(select[1], 10) - 1]
      if (target) setActiveId(target.id)
      return
    }

    // 팔레트는 토글이 아니라 열기다. 단축키로는 다시 눌러 닫을 수 있어야 한다
    if (action === 'view.palette') {
      setInboxOpen(false)
      setPaletteOpen((v) => !v)
      return
    }
    if (action === 'notifications.show') {
      setPaletteOpen(false)
      setInboxOpen((v) => !v)
      return
    }

    const command = commands.find((c) => c.id === action)
    if (command && command.enabled !== false) command.run()
  }

  /*
   * 제어 소켓이 묻는 것에 답한다 (P20-7).
   *
   * 워크스페이스와 pane은 여기 산다. main은 세션만 알기 때문에, CLI의
   * `workspace`·`pane`·`notification` 명령은 전부 이 길로 들어온다.
   */
  useEffect(() => {
    const ctx: ControlContext = {
      workspaces: () => workspacesRef.current,
      sessions: () => new Map(sessionsRef.current.map((s) => [s.id, s])),
      browsers: () => browsersRef.current,
      rightSidebarOpen: () => rightSidebarRef.current,
      activeId: () => activeIdRef.current,
      select: setActiveId,
      create: (options) => createWorkspace(options),
      closeWorkspace,
      rename: renameWorkspace,
      split: splitPaneIn,
      focusPane: focusPaneIn,
      closeSession: closeSurface,
      openBrowser: (url, direction) => openBrowser(url, direction),
      openSurface: (workspaceId, paneId, kind, url) =>
        openSurfaceIn(workspaceId, paneId, kind, url ?? 'about:blank'),
      selectSurface: (workspaceId, paneId, index) => {
        setWorkspaces((prev) =>
          prev.map((w) => (w.id === workspaceId ? { ...w, root: selectSurface(w.root, paneId, index) } : w))
        )
      },
      dropSurface,
      markRead: (id) => {
        void window.cvmux.markRead(id)
      },
      detachWorkspace,
      attachWorkspace,
      setRightSidebar: (open, mode) => {
        setRightSidebar((prev) => ({ open, mode: mode ?? prev.mode }))
      },
      setPanel: (panel, open, scope, query) => {
        if (panel === 'notifications') setInboxOpen(open)
        else if (panel === 'palette') setPaletteOpen(open)
        else if (!open) closeFind()
        else {
          openFind(scope)
          if (query !== undefined) setFind((prev) => ({ ...prev, query }))
        }
      }
    }

    return window.cvmux.onControlRequest((ask) => {
      void handleControl(ask.method, ask.params, ctx).then(
        (result) => window.cvmux.controlReply(ask.id, true, result),
        (error: unknown) =>
          window.cvmux.controlReply(
            ask.id,
            false,
            error instanceof ControlRequestError
              ? { code: error.code, message: error.message }
              : { code: 'internal_error', message: error instanceof Error ? error.message : String(error) }
          )
      )
    })
  }, [
    attachWorkspace,
    closeFind,
    closeSurface,
    closeWorkspace,
    createWorkspace,
    detachWorkspace,
    dropSurface,
    focusPaneIn,
    openBrowser,
    openSurfaceIn,
    openFind,
    renameWorkspace,
    splitPaneIn
  ])

  return (
    <div className={`app${sidebarCollapsed ? ' is-sidebar-collapsed' : ''}`}>
      <div className="titlebar">
        <button
          type="button"
          className="icon-button titlebar-toggle"
          onClick={() => setSidebarCollapsed((v) => !v)}
          title="사이드바 토글 (Ctrl+Shift+B)"
          aria-label="사이드바 토글"
        >
          ☰
        </button>
        <span className="titlebar-title">
          {focusedId !== null ? (sessionMap.get(focusedId)?.title ?? 'cvmux') : 'cvmux'}
        </span>

        {/*
          업데이트가 준비됐을 때만 뜬다 (P26-2).

          대화상자로 막아서지 않는다 — 하던 일을 끊지 않는 것이 이 기능의
          전제다. 누르면 그때 물어본다.
        */}
        {update.status === 'ready' && (
          <button
            type="button"
            className="titlebar-update"
            onClick={() => void window.cvmux.updateInstall()}
            title={
              update.installed
                ? `${update.installed} → ${update.version ?? '새 버전'} — 누르면 설치할지 묻습니다`
                : `${update.version ?? '새 버전'} — 누르면 설치할지 묻습니다`
            }
          >
            업데이트 준비됨
          </button>
        )}

        {/*
          알림 배지 (P21-3).

          미읽음이 없으면 숫자를 달지 않는다 — 늘 0이 떠 있으면 배지가 신호를
          잃는다. 종은 항상 자리를 지켜서, 눌러 볼 곳이 있다는 사실 자체는
          사라지지 않는다.
        */}
        <button
          type="button"
          className={`icon-button titlebar-bell${unreadCount > 0 ? ' is-unread' : ''}`}
          onClick={() => {
            setPaletteOpen(false)
            setInboxOpen((v) => !v)
          }}
          title="알림 (Ctrl+Shift+I)"
          aria-label={unreadCount > 0 ? `알림 ${unreadCount}개` : '알림'}
        >
          🔔
          {unreadCount > 0 ? <span className="titlebar-badge">{unreadCount}</span> : null}
        </button>

        <NotificationPanel
          items={notifications}
          open={inboxOpen}
          onClose={() => setInboxOpen(false)}
          onOpen={openNotification}
          onToggleRead={(item) => {
            void (item.read
              ? window.cvmux.notificationUnread(item.id)
              : window.cvmux.notificationRead(item.id))
          }}
          onDismiss={(item) => void window.cvmux.notificationDismiss(item.id)}
          onClear={(scope) => void window.cvmux.notificationsClear(scope)}
        />
      </div>

      <div className="body">
        <Sidebar
          workspaces={workspaces}
          sessions={sessionMap}
          meta={workspaceMeta}
          activeId={activeId}
          error={error}
          collapsed={sidebarCollapsed}
          onSelect={setActiveId}
          onClose={closeWorkspace}
          onCreate={() => void createWorkspace().catch(() => undefined)}
          onDismissError={() => setError(null)}
          onRename={renameWorkspace}
          renamingId={renamingId}
          onRenameStart={setRenamingId}
          onRenameEnd={() => setRenamingId(null)}
          onReorder={reorderWorkspaces}
        />

        <main className="main">
          <FindBar
            open={find.open}
            query={find.query}
            index={find.index}
            count={find.count}
            scope={find.scope}
            hits={findHits}
            onQueryChange={(query) => setFind((prev) => ({ ...prev, query }))}
            onNext={() => {
              if (focusedId !== null) host.find(focusedId, find.query, 'next')
            }}
            onPrevious={() => {
              if (focusedId !== null) host.find(focusedId, find.query, 'previous')
            }}
            onScopeChange={(scope) => setFind((prev) => ({ ...prev, scope }))}
            onPick={pickHit}
            onClose={closeFind}
          />

          {workspaces.length === 0 ? (
            <div className="empty">
              <h1>열린 세션이 없습니다</h1>
              <p>
                <kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>N</kbd> 으로 새 세션을 시작하세요
              </p>
              <button type="button" className="primary-button" onClick={() => void createWorkspace().catch(() => undefined)}>
                새 세션
              </button>
            </div>
          ) : (
            <div className="deck">
              {workspaces.map((workspace) => (
                <div
                  key={workspace.id}
                  className={`workspace${workspace.id === activeId ? ' is-active' : ''}`}
                >
                  <PaneTree
                    node={workspace.root}
                    sessions={sessionMap}
                    browsers={browsers}
                    host={host}
                    focusedPaneId={workspace.focusedPaneId}
                    visible={workspace.id === activeId}
                    onFocusPane={handleFocusPane}
                    onResize={handleResize}
                    onSelectSurface={handleSelectSurface}
                    onCloseSurface={closeSurface}
                    onMoveSurface={handleMoveSurface}
                  />
                </div>
              ))}
            </div>
          )}
        </main>

        <RightSidebar
          open={rightSidebar.open}
          mode={rightSidebar.mode}
          meta={activeId !== null ? (workspaceMeta[activeId] ?? null) : null}
          workspaceId={activeId}
          sessions={activeWorkspace ? visibleSessions(activeWorkspace, sessionMap) : []}
          findQuery={find.query}
          onModeChange={(mode) => setRightSidebar((prev) => ({ ...prev, mode }))}
          onClose={() => setRightSidebar((prev) => ({ ...prev, open: false }))}
          onFocusSession={(sessionId) => revealSession(sessionId)}
          onFindChange={(query) => {
            setFind((prev) => ({ ...prev, open: true, scope: 'all', query }))
          }}
        />
      </div>

      <CommandPalette
        commands={commands}
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
      />
    </div>
  )
}

/**
 * 이 워크스페이스가 붙들고 있는 세션들 — 오른쪽 사이드바의 '세션' 목록 (P25-7).
 *
 * 숨은 탭까지 센다. 보이는 것만 세면 탭 뒤의 세션이 조용히 남아 프로세스만
 * 살아 있게 된다(P24-4).
 */
function visibleSessions(
  workspace: Workspace,
  sessions: Map<string, SessionMeta>
): SessionMeta[] {
  return collectAllSurfaces(workspace.root)
    .map((id) => sessions.get(id))
    .filter((meta): meta is SessionMeta => meta !== undefined)
}

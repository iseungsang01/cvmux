import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react'

import type { Notification, SessionMeta, Workspace } from '@shared/types'
import { CommandPalette } from './components/CommandPalette'
import { FindBar, type FindHit } from './components/FindBar'
import { NotificationPanel } from './components/NotificationPanel'
import { PaneTree } from './components/PaneTree'
import { Sidebar } from './components/Sidebar'
import {
  closePane,
  collectLeaves,
  findLeafBySession,
  firstLeafId,
  findLeaf,
  resizeSplit,
  splitPane
} from './lib/layout'
import { handleControl, type ControlContext } from './lib/control'
import type { Command } from './lib/palette'
import { focusedSessionId, makeWorkspace, reorder, sessionIdOfPane } from './lib/workspace'
import { TerminalHost } from './terminal-host'

/**
 * 앱 단축키 (P6-3 / P17-1).
 *
 * 셸이 실제로 쓰는 키는 절대 가로채지 않는다. Ctrl+C는 인터럽트(P6-1),
 * Ctrl+N/Ctrl+B/Ctrl+W/Ctrl+D는 PSReadLine과 bash가 쓰므로 전부 Shift를 얹었다.
 */
type Shortcut =
  | { kind: 'new' }
  | { kind: 'close' }
  | { kind: 'sidebar' }
  | { kind: 'rename' }
  | { kind: 'split'; direction: 'row' | 'column' }
  | { kind: 'select'; index: number }
  | { kind: 'palette' }
  | { kind: 'notifications' }
  | { kind: 'jump-unread' }
  | { kind: 'find'; scope: 'session' | 'all' }

function matchShortcut(event: KeyboardEvent): Shortcut | null {
  if (event.ctrlKey && event.shiftKey && !event.altKey && !event.metaKey) {
    switch (event.code) {
      case 'KeyN':
        return { kind: 'new' }
      case 'KeyW':
        return { kind: 'close' }
      case 'KeyB':
        return { kind: 'sidebar' }
      /*
       * 이름 바꾸기 (P19-3).
       *
       * Windows 관례인 F2가 아니라 Ctrl+Shift+E를 쓴다. PSReadLine이 F2를
       * 예측 뷰 전환에 쓰고 있고, 셸이 실제로 쓰는 키는 가로채지 않는다(P6-1).
       */
      case 'KeyE':
        return { kind: 'rename' }
      /*
       * 팔레트·알림·찾기 (P21).
       *
       * cmux는 ⌘P · ⌘I · ⌘⇧U · ⌘F를 쓰지만 여기서는 전부 Shift를 얹는다.
       * Ctrl+P는 PSReadLine의 이전 기록, Ctrl+F는 한 글자 앞으로, Ctrl+I는
       * 탭 완성이다 — 셸이 쓰는 키는 가로채지 않는다(P6-1).
       */
      case 'KeyP':
        return { kind: 'palette' }
      case 'KeyI':
        return { kind: 'notifications' }
      case 'KeyU':
        return { kind: 'jump-unread' }
      case 'KeyF':
        return { kind: 'find', scope: 'all' }
      default:
        return null
    }
  }

  // Ctrl+F 단독은 PSReadLine의 것이라 쓸 수 없다. 찾기는 Alt+F로 연다
  if (event.altKey && !event.ctrlKey && !event.shiftKey && !event.metaKey) {
    if (event.code === 'KeyF') return { kind: 'find', scope: 'session' }
  }

  // 분할은 Windows Terminal 관례를 따른다 — 이 앱을 쓸 사람이 이미 익힌 키다. P17-1
  if (event.altKey && event.shiftKey && !event.ctrlKey && !event.metaKey) {
    if (event.code === 'Equal' || event.code === 'NumpadAdd') {
      return { kind: 'split', direction: 'row' } // 오른쪽에 새 pane
    }
    if (event.code === 'Minus' || event.code === 'NumpadSubtract') {
      return { kind: 'split', direction: 'column' } // 아래에 새 pane
    }
    return null
  }

  if (event.ctrlKey && event.altKey && !event.shiftKey && !event.metaKey) {
    // e.key 대신 e.code — 키보드 레이아웃이 달라도 숫자열 위치는 같다
    const match = /^Digit([1-8])$/.exec(event.code)
    if (match) return { kind: 'select', index: Number.parseInt(match[1], 10) - 1 }
  }
  return null
}

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
   * 알림·찾기 동작 (P21).
   *
   * 단축키 처리기는 이 함수들보다 위에 있다 — 그쪽이 먼저 세션과 pane을
   * 다루기 때문이다. 최신 값을 ref로 건네는 것은 이 파일이 이미 쓰는 방식이다.
   */
  const overlaysRef = useRef({
    jumpToUnread: (): void => {},
    openFind: (_scope: 'session' | 'all'): void => {}
  })

  activeIdRef.current = activeId
  workspacesRef.current = workspaces
  sessionsRef.current = sessions

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
        isAppShortcut: (event) => matchShortcut(event) !== null
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

  /** 포커스된 pane을 닫는다. 세션을 끝내면 onClosed가 트리를 정리한다. P17-3 */
  const closeFocusedPane = useCallback((): void => {
    const workspace = workspacesRef.current.find((w) => w.id === activeIdRef.current)
    if (!workspace) return
    const sessionId = focusedSessionId(workspace)
    if (sessionId !== null) void window.cvmux.close(sessionId)
  }, [])

  const closeWorkspace = useCallback((workspaceId: string): void => {
    const workspace = workspacesRef.current.find((w) => w.id === workspaceId)
    if (!workspace) return
    // 워크스페이스를 닫으면 그 안의 pane 전부를 끝낸다
    for (const leaf of paneSessionIds(workspace)) void window.cvmux.close(leaf)
  }, [])

  // ── 초기 로드 ────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const [list, layout] = await Promise.all([window.cvmux.list(), window.cvmux.loadLayout()])
      if (cancelled) return
      setSessions(list)

      // 저장된 레이아웃이 있으면 그대로, 없으면 세션마다 pane 하나짜리 워크스페이스. P17
      const restored = layout.filter((w) =>
        paneSessionIds(w).every((id) => list.some((s) => s.id === id))
      )
      const covered = new Set(restored.flatMap(paneSessionIds))
      const leftovers = list.filter((s) => !covered.has(s.id)).map((s) => makeWorkspace(s.id))
      const all = [...restored, ...leftovers]

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
      setWorkspaces((prev) =>
        prev.flatMap((workspace) => {
          const leaf = findLeafBySession(workspace.root, id)
          if (!leaf) return [workspace]
          const next = closePane(workspace.root, leaf.id)
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
    if (workspaces.length === 0) return
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

      const shortcut = matchShortcut(event)
      if (!shortcut) return

      event.preventDefault()
      event.stopPropagation()

      switch (shortcut.kind) {
        case 'new':
          void createWorkspace().catch(() => undefined)
          break
        case 'close':
          closeFocusedPane()
          break
        case 'sidebar':
          setSidebarCollapsed((v) => !v)
          break
        case 'rename':
          // 사이드바가 접혀 있으면 편집할 줄이 보이지 않는다 — 먼저 펼친다
          setSidebarCollapsed(false)
          setRenamingId(activeIdRef.current)
          break
        case 'split':
          void splitFocused(shortcut.direction)
          break
        case 'select': {
          const target = workspacesRef.current[shortcut.index]
          if (target) setActiveId(target.id)
          break
        }
        case 'palette':
          // 겹쳐 뜨는 것을 막는다 — 팔레트를 열면 나머지는 물러난다
          setInboxOpen(false)
          setPaletteOpen((v) => !v)
          break
        case 'notifications':
          setPaletteOpen(false)
          setInboxOpen((v) => !v)
          break
        case 'jump-unread':
          overlaysRef.current.jumpToUnread()
          break
        case 'find':
          overlaysRef.current.openFind(shortcut.scope)
          break
      }
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
  }, [closeFocusedPane, createWorkspace, splitFocused])

  // 사이드바 애니메이션이 끝난 뒤에 크기를 다시 맞춘다. P5-5
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const workspace = workspacesRef.current.find((w) => w.id === activeIdRef.current)
      if (!workspace) return
      for (const sessionId of paneSessionIds(workspace)) host.refit(sessionId)
    }, 220)
    return () => window.clearTimeout(timer)
  }, [sidebarCollapsed, host])

  // 최소화 → 복원, 다른 앱에서 돌아왔을 때 크기를 다시 맞춘다. P5-6
  useEffect(() => {
    const onFocus = (): void => {
      const workspace = workspacesRef.current.find((w) => w.id === activeIdRef.current)
      if (!workspace) return
      for (const sessionId of paneSessionIds(workspace)) host.refit(sessionId)
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
      for (const leaf of collectLeaves(workspace.root)) {
        const meta = sessionMap.get(leaf.sessionId)
        if (!meta) continue
        const lines = host.bufferText(leaf.sessionId)
        lines.forEach((text, line) => {
          if (hits.length >= 200) return
          if (!text.toLowerCase().includes(needle)) return
          hits.push({
            sessionId: leaf.sessionId,
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

  overlaysRef.current = { jumpToUnread, openFind }

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
        hint: 'Ctrl+Shift+N',
        section: '세션',
        run: () => void createWorkspace().catch(() => undefined)
      },
      {
        id: 'pane.split.right',
        title: '오른쪽으로 분할',
        keywords: 'split right vertical pane',
        hint: 'Alt+Shift+=',
        section: 'pane',
        run: () => void splitFocused('row')
      },
      {
        id: 'pane.split.down',
        title: '아래로 분할',
        keywords: 'split down horizontal pane',
        hint: 'Alt+Shift+-',
        section: 'pane',
        run: () => void splitFocused('column')
      },
      {
        id: 'pane.close',
        title: '이 pane 닫기',
        keywords: 'close pane kill',
        hint: 'Ctrl+Shift+W',
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
        hint: 'Ctrl+Shift+E',
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
        hint: 'Alt+F',
        section: '찾기',
        run: () => openFind('session')
      },
      {
        id: 'find.all',
        title: '모든 세션에서 찾기',
        keywords: 'find search all sessions global',
        hint: 'Ctrl+Shift+F',
        section: '찾기',
        run: () => openFind('all')
      },
      {
        id: 'notifications.show',
        title: unread > 0 ? `알림 보기 (${unread})` : '알림 보기',
        keywords: 'notifications inbox bell alerts',
        hint: 'Ctrl+Shift+I',
        section: '알림',
        run: () => setInboxOpen(true)
      },
      {
        id: 'notifications.jump',
        title: '읽지 않은 알림으로 이동',
        keywords: 'jump unread notification next',
        hint: 'Ctrl+Shift+U',
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
        id: 'view.sidebar',
        title: sidebarCollapsed ? '사이드바 펴기' : '사이드바 접기',
        keywords: 'sidebar toggle view',
        hint: 'Ctrl+Shift+B',
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
        hint: index < 8 ? `Ctrl+Alt+${index + 1}` : undefined,
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
    jumpToUnread,
    notifications,
    openFind,
    sessionMap,
    sidebarCollapsed,
    splitFocused,
    workspaces
  ])

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
      activeId: () => activeIdRef.current,
      select: setActiveId,
      create: (options) => createWorkspace(options),
      closeWorkspace,
      rename: renameWorkspace,
      split: splitPaneIn,
      focusPane: focusPaneIn,
      closeSession: (id) => {
        void window.cvmux.close(id)
      },
      markRead: (id) => {
        void window.cvmux.markRead(id)
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
            error instanceof Error ? error.message : String(error)
          )
      )
    })
  }, [closeFind, closeWorkspace, createWorkspace, focusPaneIn, openFind, renameWorkspace, splitPaneIn])

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
                    host={host}
                    focusedPaneId={workspace.focusedPaneId}
                    visible={workspace.id === activeId}
                    onFocusPane={handleFocusPane}
                    onResize={handleResize}
                  />
                </div>
              ))}
            </div>
          )}
        </main>
      </div>

      <CommandPalette
        commands={commands}
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
      />
    </div>
  )
}

function paneSessionIds(workspace: Workspace): string[] {
  const out: string[] = []
  const walk = (node: Workspace['root']): void => {
    if (node.kind === 'leaf') {
      out.push(node.sessionId)
      return
    }
    node.children.forEach(walk)
  }
  walk(workspace.root)
  return out
}

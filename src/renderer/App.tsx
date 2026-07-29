import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react'

import type { SessionMeta, Workspace } from '@shared/types'
import { PaneTree } from './components/PaneTree'
import { Sidebar } from './components/Sidebar'
import {
  closePane,
  findLeafBySession,
  firstLeafId,
  findLeaf,
  resizeSplit,
  splitPane
} from './lib/layout'
import { focusedSessionId, makeWorkspace, reorder } from './lib/workspace'
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
      default:
        return null
    }
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

  // 이벤트 핸들러가 오래된 클로저를 붙잡지 않도록 최신 값을 ref로 들고 다닌다
  const activeIdRef = useRef<string | null>(null)
  const workspacesRef = useRef<Workspace[]>([])
  const sessionsRef = useRef<SessionMeta[]>([])
  const composingRef = useRef(false)

  activeIdRef.current = activeId
  workspacesRef.current = workspaces
  sessionsRef.current = sessions

  const sessionMap = useMemo(() => new Map(sessions.map((s) => [s.id, s])), [sessions])
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

  const createWorkspace = useCallback(async (): Promise<void> => {
    // 새 워크스페이스는 지금 보고 있던 작업 디렉토리를 물려받는다. P11-1
    const result = await window.cvmux.create({ cwd: currentSession()?.cwd })
    if (!result.ok || !result.session) {
      // 상한 초과 같은 실패는 사유를 그대로 보여준다. P1-8 / P12-1
      setError(result.error ?? '세션을 만들지 못했습니다.')
      return
    }
    setError(null)
    const workspace = makeWorkspace(result.session.id)
    setWorkspaces((prev) => [...prev, workspace])
    setActiveId(workspace.id)
  }, [currentSession])

  /** 포커스된 pane을 둘로 나눈다. P17-1 / P17-2 */
  const splitFocused = useCallback(
    async (direction: 'row' | 'column'): Promise<void> => {
      const workspace = workspacesRef.current.find((w) => w.id === activeIdRef.current)
      if (!workspace) return

      // 새 pane은 나눈 pane의 작업 디렉토리에서 시작한다. P17-2
      const result = await window.cvmux.create({ cwd: currentSession()?.cwd })
      if (!result.ok || !result.session) {
        setError(result.error ?? '세션을 만들지 못했습니다.')
        return
      }
      setError(null)

      const sessionId = result.session.id
      const split = splitPane(workspace.root, workspace.focusedPaneId, direction, sessionId)
      if (!split) {
        // 나눌 자리를 잃었다 — 방금 만든 세션을 되돌린다
        void window.cvmux.close(sessionId)
        return
      }

      setWorkspaces((prev) =>
        prev.map((w) =>
          w.id === workspace.id ? { ...w, root: split.root, focusedPaneId: split.newPaneId } : w
        )
      )
    },
    [currentSession]
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
        await createWorkspace()
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
          void createWorkspace()
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

  const handleFocusPane = useCallback((paneId: string): void => {
    setWorkspaces((prev) =>
      prev.map((w) => (w.id === activeIdRef.current ? { ...w, focusedPaneId: paneId } : w))
    )
  }, [])

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
          onCreate={() => void createWorkspace()}
          onDismissError={() => setError(null)}
          onRename={renameWorkspace}
          renamingId={renamingId}
          onRenameStart={setRenamingId}
          onRenameEnd={() => setRenamingId(null)}
          onReorder={reorderWorkspaces}
        />

        <main className="main">
          {workspaces.length === 0 ? (
            <div className="empty">
              <h1>열린 세션이 없습니다</h1>
              <p>
                <kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>N</kbd> 으로 새 세션을 시작하세요
              </p>
              <button type="button" className="primary-button" onClick={() => void createWorkspace()}>
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

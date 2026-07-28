import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react'

import type { SessionMeta } from '@shared/types'
import { Sidebar } from './components/Sidebar'
import { TerminalDeck } from './components/TerminalDeck'
import { TerminalHost } from './terminal-host'

/**
 * 앱 단축키 (P6-3).
 *
 * 셸이 실제로 쓰는 키는 절대 가로채지 않는다. Ctrl+C는 인터럽트(P6-1),
 * Ctrl+N/Ctrl+B/Ctrl+W는 PSReadLine과 bash가 쓰므로 전부 Shift/Alt를 얹었다.
 */
type Shortcut =
  | { kind: 'new' }
  | { kind: 'close' }
  | { kind: 'sidebar' }
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
      default:
        return null
    }
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
  const [activeId, setActiveId] = useState<string | null>(null)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // 이벤트 핸들러가 오래된 클로저를 붙잡지 않도록 최신 값을 ref로 들고 다닌다
  const activeIdRef = useRef<string | null>(null)
  const sessionsRef = useRef<SessionMeta[]>([])
  const composingRef = useRef(false)

  activeIdRef.current = activeId
  sessionsRef.current = sessions

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

  const createSession = useCallback(async (): Promise<void> => {
    // 새 세션은 활성 세션의 작업 디렉토리를 물려받는다. P11-1
    const active = sessionsRef.current.find((s) => s.id === activeIdRef.current)
    const result = await window.cvmux.create({ cwd: active?.cwd })
    if (!result.ok) {
      // 상한 초과 같은 실패는 사유를 그대로 보여준다. P1-8 / P12-1
      setError(result.error ?? '세션을 만들지 못했습니다.')
      return
    }
    setError(null)
    if (result.session) setActiveId(result.session.id)
  }, [])

  const closeSession = useCallback((id: string): void => {
    void window.cvmux.close(id)
  }, [])

  // ── 초기 로드 ────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const list = await window.cvmux.list()
      if (cancelled) return
      setSessions(list)
      if (list.length > 0) {
        setActiveId(list[0].id)
      } else {
        await createSession()
      }
    })()
    return () => {
      cancelled = true
    }
  }, [createSession])

  // ── main 이벤트 구독 ─────────────────────────────────────────
  useEffect(() => {
    const offData = window.cvmux.onData((id, chunk) => {
      host.write(id, chunk)
    })

    const offMeta = window.cvmux.onMeta((meta) => {
      host.setStatus(meta.id, meta.status)
      // 사용자가 보고 있는 세션의 알림은 미읽음으로 쌓지 않는다. P4-4
      if (meta.unread && meta.id === activeIdRef.current) {
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
    })

    // 종료 자체는 meta 이벤트로도 전달된다. 여기서는 별도 처리가 없다. P1-1
    const offExit = window.cvmux.onExit(() => {})

    return () => {
      offData()
      offMeta()
      offCreated()
      offClosed()
      offExit()
    }
  }, [host])

  // 창이 닫힐 때 xterm 인스턴스를 정리한다
  useEffect(() => () => host.disposeAll(), [host])

  // ── 활성 세션 유지 ───────────────────────────────────────────
  useEffect(() => {
    if (activeId !== null && sessions.some((s) => s.id === activeId)) return
    // 마지막 세션을 닫아도 앱은 살아있고, 빈 상태 화면을 보여준다. P1-7
    setActiveId(sessions[0]?.id ?? null)
  }, [sessions, activeId])

  useEffect(() => {
    if (activeId === null) return
    // 세션을 열어 봤으므로 미읽음을 해제한다. P4-5
    void window.cvmux.markRead(activeId)
    host.focus(activeId)
  }, [activeId, host])

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
          void createSession()
          break
        case 'close': {
          const id = activeIdRef.current
          if (id !== null) closeSession(id)
          break
        }
        case 'sidebar':
          setSidebarCollapsed((v) => !v)
          break
        case 'select': {
          const target = sessionsRef.current[shortcut.index]
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
  }, [closeSession, createSession])

  // 사이드바 애니메이션이 끝난 뒤에 크기를 다시 맞춘다. P5-5
  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (activeIdRef.current !== null) host.refit(activeIdRef.current)
    }, 220)
    return () => window.clearTimeout(timer)
  }, [sidebarCollapsed, host])

  // 최소화 → 복원, 다른 앱에서 돌아왔을 때 크기를 다시 맞춘다. P5-6
  useEffect(() => {
    const onFocus = (): void => {
      if (activeIdRef.current !== null) host.refit(activeIdRef.current)
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [host])

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
          {sessions.find((s) => s.id === activeId)?.title ?? 'cvmux'}
        </span>
      </div>

      <div className="body">
        <Sidebar
          sessions={sessions}
          activeId={activeId}
          error={error}
          collapsed={sidebarCollapsed}
          onSelect={setActiveId}
          onClose={closeSession}
          onCreate={() => void createSession()}
          onDismissError={() => setError(null)}
        />

        <main className="main">
          {sessions.length === 0 ? (
            <div className="empty">
              <h1>열린 세션이 없습니다</h1>
              <p>
                <kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>N</kbd> 으로 새 세션을 시작하세요
              </p>
              <button type="button" className="primary-button" onClick={() => void createSession()}>
                새 세션
              </button>
            </div>
          ) : (
            <TerminalDeck host={host} sessions={sessions} activeId={activeId} />
          )}
        </main>
      </div>
    </div>
  )
}

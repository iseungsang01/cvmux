import { useEffect, useRef, type JSX } from 'react'

import type { SessionMeta } from '@shared/types'
import { exitLabel, isFailedExit } from '../lib/format'
import type { TerminalHost } from '../terminal-host'

/**
 * 모든 세션의 터미널을 동시에 마운트해두고 활성 세션만 보여준다 (P5-1).
 * 감추는 것은 CSS뿐이라 전환해도 스크롤백·커서·실행 중인 TUI가 그대로 남는다.
 */

interface TerminalDeckProps {
  host: TerminalHost
  sessions: SessionMeta[]
  activeId: string | null
}

export function TerminalDeck({ host, sessions, activeId }: TerminalDeckProps): JSX.Element {
  return (
    <div className="deck">
      {sessions.map((session) => (
        <TerminalPane
          key={session.id}
          host={host}
          session={session}
          active={session.id === activeId}
        />
      ))}
    </div>
  )
}

interface TerminalPaneProps {
  host: TerminalHost
  session: SessionMeta
  active: boolean
}

function TerminalPane({ host, session, active }: TerminalPaneProps): JSX.Element {
  const mountRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = mountRef.current
    if (!el) return
    host.attach(session.id, el)
    // 렌더러가 재시작됐다면 main의 재생 버퍼로 화면을 되살린다. P9-1
    void host.hydrate(session.id)
  }, [host, session.id])

  // 활성화되는 순간에만 크기를 맞춘다 — 숨은 상태의 fit은 1×1 터미널을 만든다. P2-3
  useEffect(() => {
    if (active) host.focus(session.id)
  }, [active, host, session.id])

  const attention = session.status === 'attention' || session.status === 'waiting'
  const classes = [
    'pane',
    active ? 'is-active' : '',
    // 에이전트가 기다리는 중이면 패널에 파란 링. P4-1
    attention ? 'is-attention' : '',
    session.status === 'attention' ? 'is-certain' : ''
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <section className={classes}>
      <div className="pane-terminal" ref={mountRef} />

      {/* 종료된 세션도 화면을 남긴다 — 사용자가 닫기 전까지 사라지지 않는다. P0-1 / P1-1 */}
      {session.status === 'exited' && (
        <div className="pane-exit">
          <div className={`pane-exit-code${isFailedExit(session) ? ' is-failed' : ''}`}>
            {exitLabel(session)}
          </div>
          <div className="pane-exit-hint">Enter를 누르면 같은 디렉토리에서 다시 시작합니다</div>
          {session.warning !== null && <div className="pane-exit-warning">{session.warning}</div>}
        </div>
      )}
    </section>
  )
}

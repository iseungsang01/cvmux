import type { JSX } from 'react'

import type { SessionMeta } from '@shared/types'
import { exitLabel, isFailedExit, shortenPath, statusLabel } from '../lib/format'

/**
 * 왼쪽 사이드바 — 이 앱의 존재 이유 (P4 시각 표현).
 *
 * 상태 → 표시:
 *   busy      초록 점(펄스)     출력이 흐르는 중
 *   idle      회색 빈 원        프롬프트 대기
 *   waiting   파란 링           입력 대기 추정 (추측)
 *   attention 파란 링 + 점      명시적 알림 (확실)
 *   exited    사각 + 종료 코드  종료됨
 */

interface SidebarProps {
  sessions: SessionMeta[]
  activeId: string | null
  error: string | null
  collapsed: boolean
  onSelect(id: string): void
  onClose(id: string): void
  onCreate(): void
  onDismissError(): void
}

export function Sidebar({
  sessions,
  activeId,
  error,
  collapsed,
  onSelect,
  onClose,
  onCreate,
  onDismissError
}: SidebarProps): JSX.Element {
  return (
    <aside className={`sidebar${collapsed ? ' is-collapsed' : ''}`} aria-hidden={collapsed}>
      <header className="sidebar-head">
        <span className="sidebar-brand">cvmux</span>
        <button
          type="button"
          className="icon-button"
          onClick={onCreate}
          title="새 세션 (Ctrl+Shift+N)"
          aria-label="새 세션"
        >
          +
        </button>
      </header>

      {/* 사용자가 조치할 수 있는 오류만 여기 뜬다. P12-1 */}
      {error !== null && (
        <div className="sidebar-error" role="alert">
          <span>{error}</span>
          <button type="button" className="icon-button" onClick={onDismissError} aria-label="닫기">
            ×
          </button>
        </div>
      )}

      <ul className="session-list">
        {sessions.map((session, index) => (
          <SessionRow
            key={session.id}
            session={session}
            index={index}
            active={session.id === activeId}
            onSelect={onSelect}
            onClose={onClose}
          />
        ))}
      </ul>

      <footer className="sidebar-foot">
        <span>{sessions.length}개 세션</span>
        <kbd>Ctrl+Shift+B</kbd>
      </footer>
    </aside>
  )
}

interface SessionRowProps {
  session: SessionMeta
  index: number
  active: boolean
  onSelect(id: string): void
  onClose(id: string): void
}

function SessionRow({
  session,
  index,
  active,
  onSelect,
  onClose
}: SessionRowProps): JSX.Element {
  const needsAttention = session.status === 'attention' || session.status === 'waiting'
  const classes = [
    'session-row',
    active ? 'is-active' : '',
    needsAttention ? 'is-attention' : '',
    session.status === 'exited' ? 'is-exited' : ''
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <li>
      <div
        className={classes}
        role="button"
        tabIndex={0}
        onClick={() => onSelect(session.id)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            onSelect(session.id)
          }
        }}
        title={`${session.title}\n${session.cwd}\n${statusLabel(session)}`}
      >
        <StatusDot session={session} />

        <div className="session-body">
          <div className="session-title-line">
            {/* 제목이 길면 말줄임 — 전체는 툴팁으로. P5-7 */}
            <span className="session-title">{session.title}</span>
            {index < 8 && <span className="session-index">{index + 1}</span>}
          </div>

          <div className="session-cwd">{shortenPath(session.cwd)}</div>

          {session.status === 'exited' ? (
            <div className={`session-exit${isFailedExit(session) ? ' is-failed' : ''}`}>
              {exitLabel(session)} · Enter로 재시작
            </div>
          ) : (
            <div className="session-preview">{session.preview || ' '}</div>
          )}

          {/* 조치가 필요한 경고만 노출한다. P12-1 / P12-3 */}
          {session.warning !== null && <div className="session-warning">{session.warning}</div>}
        </div>

        <button
          type="button"
          className="session-close"
          title="세션 닫기 (Ctrl+Shift+W)"
          aria-label="세션 닫기"
          onClick={(event) => {
            event.stopPropagation()
            onClose(session.id)
          }}
        >
          ×
        </button>
      </div>
    </li>
  )
}

function StatusDot({ session }: { session: SessionMeta }): JSX.Element {
  const classes = ['status-dot', `is-${session.status}`]
  // 추측으로 판정한 상태는 옅게 — 확실한 신호와 구분한다. P0-3
  if (session.confidence === 'inferred') classes.push('is-inferred')
  if (session.unread) classes.push('has-unread')

  return (
    <span className={classes.join(' ')} aria-label={statusLabel(session)}>
      <span className="status-core" />
    </span>
  )
}

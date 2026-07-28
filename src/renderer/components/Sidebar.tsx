import { useEffect, useRef, useState, type JSX } from 'react'

import type { SessionMeta, Workspace } from '@shared/types'
import { gitTooltip, isFailedExit, shortenPath, splitPorts, statusLabel } from '../lib/format'
import { paneCount } from '../lib/layout'
import { representativeSession, workspaceTitle } from '../lib/workspace'

/**
 * 왼쪽 사이드바 — 이 앱의 존재 이유 (P4 시각 표현 / P17-7).
 *
 * 한 줄이 워크스페이스 하나다. 워크스페이스 안에 pane이 여럿이면 그중 가장
 * 손이 필요한 pane이 대표로 올라온다 — 실행 중인 pane 하나가 확인을 기다리는
 * pane을 가려서는 안 되기 때문이다.
 *
 * 한 줄은 세 가지만 답한다(P19-1): **무엇인가**(제목), **어디인가**(저장소),
 * **지금 어떤가**(상태). 마지막 출력 줄을 흘려보내던 미리보기는 걷어냈다 —
 * 에이전트 CLI 안에서는 사용자가 타이핑하는 글자가 그대로 새어 나왔고,
 * 그것은 상태가 아니라 소음이었다(P19-2).
 *
 * 상태 → 표시:
 *   busy      초록 점(펄스)     출력이 흐르는 중
 *   idle      회색 빈 원        프롬프트 대기
 *   waiting   파란 링           입력 대기 추정 (추측)
 *   attention 파란 링 + 점      명시적 알림 (확실)
 *   exited    사각 + 종료 코드  종료됨
 */

interface SidebarProps {
  workspaces: Workspace[]
  sessions: Map<string, SessionMeta>
  activeId: string | null
  error: string | null
  collapsed: boolean
  onSelect(id: string): void
  onClose(id: string): void
  onCreate(): void
  onDismissError(): void
  /** 사용자가 지은 이름. null이면 자동 제목으로 되돌아간다. P19-3 */
  onRename(id: string, title: string | null): void
}

export function Sidebar({
  workspaces,
  sessions,
  activeId,
  error,
  collapsed,
  onSelect,
  onClose,
  onCreate,
  onDismissError,
  onRename
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
        {workspaces.map((workspace, index) => (
          <WorkspaceRow
            key={workspace.id}
            workspace={workspace}
            sessions={sessions}
            index={index}
            active={workspace.id === activeId}
            onSelect={onSelect}
            onClose={onClose}
            onRename={onRename}
          />
        ))}
      </ul>

      <footer className="sidebar-foot">
        <span>{workspaces.length}개 세션</span>
        <kbd>Ctrl+Shift+B</kbd>
      </footer>
    </aside>
  )
}

interface WorkspaceRowProps {
  workspace: Workspace
  sessions: Map<string, SessionMeta>
  index: number
  active: boolean
  onSelect(id: string): void
  onClose(id: string): void
  onRename(id: string, title: string | null): void
}

function WorkspaceRow({
  workspace,
  sessions,
  index,
  active,
  onSelect,
  onClose,
  onRename
}: WorkspaceRowProps): JSX.Element | null {
  const [editing, setEditing] = useState(false)
  // 대표 pane이 상태·미리보기·git·포트를 모두 대표한다. P17-7 / P17-8
  const session = representativeSession(workspace, sessions)
  if (!session) return null

  const panes = paneCount(workspace.root)
  const needsAttention = session.status === 'attention' || session.status === 'waiting'
  const classes = [
    'session-row',
    active ? 'is-active' : '',
    needsAttention ? 'is-attention' : '',
    session.status === 'exited' ? 'is-exited' : ''
  ]
    .filter(Boolean)
    .join(' ')

  const title = workspaceTitle(workspace, sessions)

  return (
    <li>
      <div
        className={classes}
        role="button"
        tabIndex={0}
        onClick={() => onSelect(workspace.id)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            onSelect(workspace.id)
          }
        }}
        title={`${title}\n${session.cwd}\n${statusLabel(session)}${panes > 1 ? `\npane ${panes}개` : ''}`}
      >
        <StatusDot session={session} />

        <div className="session-body">
          <div className="session-title-line">
            {editing ? (
              <TitleEditor
                value={title}
                onCommit={(next) => {
                  onRename(workspace.id, next)
                  setEditing(false)
                }}
                onCancel={() => setEditing(false)}
              />
            ) : (
              // 제목이 길면 말줄임 — 전체는 툴팁으로. P5-7
              <span
                className="session-title"
                onDoubleClick={(event) => {
                  event.stopPropagation()
                  setEditing(true)
                }}
              >
                {title}
              </span>
            )}
            {panes > 1 && <span className="session-panes">⊞{panes}</span>}
            {index < 8 && <span className="session-index">{index + 1}</span>}
          </div>

          {/* 어디인가 — 저장소 안이면 그 이름이 경로보다 정확한 답이다. P19-1 */}
          <div className="session-where">{session.git?.repo ?? shortenPath(session.cwd)}</div>

          <SessionFacts session={session} />

          {/* 지금 어떤가 — 흘러가는 출력 대신 상태 그 자체. P19-2 */}
          <div
            className={`session-status is-${session.status}${
              isFailedExit(session) ? ' is-failed' : ''
            }`}
          >
            {statusLabel(session)}
            {session.status === 'exited' && ' · Enter로 재시작'}
          </div>

          {/* 조치가 필요한 경고만 노출한다. P12-1 / P12-3 */}
          {session.warning !== null && <div className="session-warning">{session.warning}</div>}
        </div>

        <button
          type="button"
          className="session-close"
          title={panes > 1 ? `pane ${panes}개를 모두 닫습니다` : '세션 닫기 (Ctrl+Shift+W)'}
          aria-label="세션 닫기"
          onClick={(event) => {
            event.stopPropagation()
            onClose(workspace.id)
          }}
        >
          ×
        </button>
      </div>
    </li>
  )
}

interface TitleEditorProps {
  value: string
  /** 빈 이름은 null로 넘긴다 — 자동 제목으로 되돌아간다는 뜻이다. P19-3 */
  onCommit(title: string | null): void
  onCancel(): void
}

/**
 * 제목 인라인 편집 (P19-3).
 *
 * 키 이벤트를 여기서 멈춰 세운다. 이름을 치는 동안 `Ctrl+Shift+N` 같은 앱
 * 단축키가 발동하면 글자 대신 새 세션이 튀어나온다.
 */
function TitleEditor({ value, onCommit, onCancel }: TitleEditorProps): JSX.Element {
  const ref = useRef<HTMLInputElement>(null)
  // 편집을 시작하면 기존 이름이 통째로 선택돼 있어야 바로 갈아끼울 수 있다
  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [])

  return (
    <input
      ref={ref}
      className="session-title-input"
      defaultValue={value}
      maxLength={64}
      spellCheck={false}
      aria-label="세션 이름"
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        event.stopPropagation()
        if (event.key === 'Enter') {
          event.preventDefault()
          onCommit(event.currentTarget.value.trim() || null)
        } else if (event.key === 'Escape') {
          event.preventDefault()
          onCancel()
        }
      }}
      // 다른 곳을 눌러 빠져나가도 친 내용은 지킨다 — 취소는 Escape로만
      onBlur={(event) => onCommit(event.currentTarget.value.trim() || null)}
    />
  )
}

/** git 브랜치와 리슨 포트 — cmux 사이드바의 그 줄. P13 / P14 */
function SessionFacts({ session }: { session: SessionMeta }): JSX.Element | null {
  const { git, ports } = session
  if (!git && ports.length === 0) return null

  const { shown, extra } = splitPorts(ports)

  return (
    <div className="session-facts">
      {git && (
        <span className={`fact fact-git${git.dirty ? ' is-dirty' : ''}`} title={gitTooltip(git)}>
          {/* 브랜치는 ⎇, detached HEAD는 커밋을 가리키므로 ◉ */}
          <span className="fact-icon">{git.detached ? '◉' : '⎇'}</span>
          <span className="fact-branch">{git.branch}</span>
          {git.operation !== null && <span className="fact-op">{git.operation}</span>}
          {git.dirty && <span className="fact-dot" aria-label="변경사항 있음" />}
          {git.ahead > 0 && <span className="fact-ab">↑{git.ahead}</span>}
          {git.behind > 0 && <span className="fact-ab">↓{git.behind}</span>}
        </span>
      )}

      {shown.map((port) => (
        <span key={port} className="fact fact-port">
          :{port}
        </span>
      ))}
      {extra > 0 && (
        <span className="fact fact-port" title={ports.join(', ')}>
          +{extra}
        </span>
      )}
    </div>
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

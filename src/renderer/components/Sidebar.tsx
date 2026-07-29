import { useEffect, useRef, type JSX } from 'react'

import type { SessionMeta, Workspace } from '@shared/types'
import { gitTooltip, isFailedExit, splitPorts, statusLabel, whereLabel } from '../lib/format'
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
 * 왼쪽 점은 신호등이다(P4). 세 색이 답하는 질문은 하나 — 지금 나를 필요로 하는가.
 *
 *   busy      초록 점(펄스)     출력이 흐른다. 일이 돌아가는 중이니 둬도 된다
 *   attention 노란 점 + 링      명시적으로 나를 불렀다 (확실)
 *   waiting   빨간 점           떠 있는 채로 조용하다 — 끝났거나 답을 기다린다
 *   idle      회색 빈 원        셸 프롬프트. 아무것도 돌지 않는 빈손 상태
 *   exited    회색 사각         셸이 죽었다 — 상태가 아니라 부재다
 *
 * `waiting`과 `idle`을 가르는 것이 이 화면의 핵심이다(P4-14). 에이전트를
 * 띄워두면 명령은 몇 시간이고 살아 있으므로, "명령이 있다"만으로 초록을
 * 유지하면 신호가 영영 꺼지지 않는다.
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
  /**
   * 지금 이름을 고치고 있는 줄. 편집 상태를 행 안에 가두지 않는 이유는
   * 단축키(Ctrl+Shift+E)가 바깥에서 편집을 시작할 수 있어야 하기 때문이다. P19-3
   */
  renamingId: string | null
  onRenameStart(id: string): void
  onRenameEnd(): void
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
  onRename,
  renamingId,
  onRenameStart,
  onRenameEnd
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
            renaming={workspace.id === renamingId}
            onSelect={onSelect}
            onClose={onClose}
            onRename={onRename}
            onRenameStart={onRenameStart}
            onRenameEnd={onRenameEnd}
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
  renaming: boolean
  onSelect(id: string): void
  onClose(id: string): void
  onRename(id: string, title: string | null): void
  onRenameStart(id: string): void
  onRenameEnd(): void
}

function WorkspaceRow({
  workspace,
  sessions,
  index,
  active,
  renaming,
  onSelect,
  onClose,
  onRename,
  onRenameStart,
  onRenameEnd
}: WorkspaceRowProps): JSX.Element | null {
  // 대표 pane이 상태·미리보기·git·포트를 모두 대표한다. P17-7 / P17-8
  const session = representativeSession(workspace, sessions)
  if (!session) return null

  const panes = paneCount(workspace.root)
  // 줄 전체를 두르는 링은 명시적 신호에만 쓴다. 조용한 상태(waiting)까지
  // 강조하면 에이전트를 띄워둔 줄이 전부 빛나 링이 뜻을 잃는다. P4-14
  const needsAttention = session.status === 'attention'
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
        title={`${title}\n${session.cwd}\n${statusLabel(session)}${
          panes > 1 ? `\npane ${panes}개` : ''
        }\n이름 바꾸기: 제목 더블클릭 또는 Ctrl+Shift+E`}
      >
        <StatusDot session={session} />

        <div className="session-body">
          <div className="session-title-line">
            {renaming ? (
              <TitleEditor
                value={title}
                onCommit={(next) => {
                  onRename(workspace.id, next)
                  onRenameEnd()
                }}
                onCancel={onRenameEnd}
              />
            ) : (
              // 제목이 길면 말줄임 — 전체는 툴팁으로. P5-7
              <span
                className="session-title"
                onDoubleClick={(event) => {
                  event.stopPropagation()
                  onRenameStart(workspace.id)
                }}
              >
                {title}
              </span>
            )}
            {panes > 1 && <span className="session-panes">⊞{panes}</span>}
            {index < 8 && <span className="session-index">{index + 1}</span>}
          </div>

          {/* 어디인가 — 저장소 이름에 그 안에서의 자리를 붙인다. P19-1 / P19-7 */}
          <div className="session-where" title={session.cwd}>
            {whereLabel(session)}
          </div>

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

        {/*
          이름 바꾸기의 **보이는** 진입점 (P19-3).

          더블클릭만으로는 기능이 있다는 사실 자체가 전달되지 않는다. 실제로
          "제목을 수정할 수 있게 해달라"는 요청을 받았을 때 기능은 이미 있었다 —
          없었던 것은 발견할 방법이었다.
        */}
        {!renaming && (
          <button
            type="button"
            className="session-rename"
            title="이름 바꾸기 (Ctrl+Shift+E)"
            aria-label="이름 바꾸기"
            onClick={(event) => {
              event.stopPropagation()
              onRenameStart(workspace.id)
            }}
          >
            ✎
          </button>
        )}

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
      // 비우면 자동 제목으로 돌아간다는 것을 지우는 순간 알 수 있게 한다
      placeholder="비우면 자동 이름"
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

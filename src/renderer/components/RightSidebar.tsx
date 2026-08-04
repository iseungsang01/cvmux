import { useState, type JSX } from 'react'

import type {
  RightSidebarMode,
  SessionMeta,
  TodoItem,
  WorkspaceMeta
} from '@shared/types'

/**
 * 오른쪽 사이드바 (POLICY.md P25-7).
 *
 * 왼쪽 사이드바가 "어떤 세션들이 있는가"에 답한다면, 이쪽은 **지금 보고 있는
 * 워크스페이스 안에서 무슨 일이 벌어지는가**에 답한다. cmux의 오른쪽 사이드바와
 * 같은 자리이고, 담는 것도 같은 부류다 — 로그·체크리스트·세션·찾기.
 *
 * 여기 있는 내용은 대부분 **에이전트가 적은 것**이다(P25). cvmux가 출력을 보고
 * 짐작한 것이 아니라, 소켓으로 직접 들어온 말이다.
 */

export interface RightSidebarProps {
  open: boolean
  mode: RightSidebarMode
  meta: WorkspaceMeta | null
  /** 이 워크스페이스의 세션들 — `sessions` 모드가 쓴다 */
  sessions: SessionMeta[]
  workspaceId: string | null
  onModeChange(mode: RightSidebarMode): void
  onClose(): void
  onFocusSession(sessionId: string): void
  onFindChange(query: string): void
  findQuery: string
}

const MODES: Array<{ id: RightSidebarMode; label: string; title: string }> = [
  { id: 'log', label: '로그', title: '에이전트가 남긴 기록' },
  { id: 'todo', label: '할 일', title: '체크리스트' },
  { id: 'sessions', label: '세션', title: '이 워크스페이스의 세션' },
  { id: 'find', label: '찾기', title: '모든 세션에서 찾기' }
]

export function RightSidebar(props: RightSidebarProps): JSX.Element | null {
  const { open, mode, meta, sessions, workspaceId } = props
  const [draft, setDraft] = useState('')

  if (!open) return null

  return (
    <aside className="right-sidebar" aria-label="워크스페이스 정보">
      <div className="right-tabs" role="tablist">
        {MODES.map((entry) => (
          <button
            key={entry.id}
            type="button"
            role="tab"
            aria-selected={mode === entry.id}
            className={`right-tab${mode === entry.id ? ' is-active' : ''}`}
            title={entry.title}
            onClick={() => props.onModeChange(entry.id)}
          >
            {entry.label}
            {entry.id === 'log' && meta && meta.log.length > 0 ? (
              <span className="right-tab-count">{meta.log.length}</span>
            ) : null}
            {entry.id === 'todo' && meta && meta.todo.length > 0 ? (
              <span className="right-tab-count">
                {meta.todo.filter((t) => t.state !== 'completed').length}
              </span>
            ) : null}
          </button>
        ))}
        <button
          type="button"
          className="icon-button right-close"
          onClick={props.onClose}
          title="닫기"
          aria-label="오른쪽 사이드바 닫기"
        >
          ×
        </button>
      </div>

      <div className="right-body">
        {mode === 'log' && <LogView meta={meta} />}

        {mode === 'todo' && (
          <TodoView
            meta={meta}
            workspaceId={workspaceId}
            draft={draft}
            onDraftChange={setDraft}
          />
        )}

        {mode === 'sessions' && (
          <SessionsView sessions={sessions} onFocus={props.onFocusSession} />
        )}

        {mode === 'find' && (
          <div className="right-find">
            <input
              className="right-find-input"
              value={props.findQuery}
              placeholder="모든 세션에서 찾기"
              spellCheck={false}
              onChange={(event) => props.onFindChange(event.target.value)}
            />
            <p className="right-hint">
              결과는 화면 위쪽 찾기 바에 나옵니다. <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>F</kbd>
            </p>
          </div>
        )}
      </div>
    </aside>
  )
}

function LogView({ meta }: { meta: WorkspaceMeta | null }): JSX.Element {
  if (!meta || meta.log.length === 0) {
    return (
      <div className="right-empty">
        <p>기록이 없습니다.</p>
        <p className="right-hint">
          에이전트가 <code>cvmux log &quot;…&quot;</code>로 남긴 줄이 여기 쌓입니다.
        </p>
      </div>
    )
  }

  // 최신이 아래다 — 터미널과 같은 방향이라 눈이 헤매지 않는다
  return (
    <ul className="right-log">
      {meta.log.map((entry) => (
        <li key={entry.id} className={`right-log-row is-${entry.level}`}>
          <span className="right-log-time">{clock(entry.at)}</span>
          <span className="right-log-text">{entry.text}</span>
        </li>
      ))}
    </ul>
  )
}

interface TodoViewProps {
  meta: WorkspaceMeta | null
  workspaceId: string | null
  draft: string
  onDraftChange(value: string): void
}

function TodoView({ meta, workspaceId, draft, onDraftChange }: TodoViewProps): JSX.Element {
  const items = meta?.todo ?? []

  const add = (): void => {
    const text = draft.trim()
    if (!text || workspaceId === null) return
    void window.cvmux.todoAdd(workspaceId, text)
    onDraftChange('')
  }

  return (
    <div className="right-todo">
      <div className="right-todo-add">
        <input
          className="right-todo-input"
          value={draft}
          placeholder="할 일 추가"
          spellCheck={false}
          onChange={(event) => onDraftChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return
            if (event.key === 'Enter') add()
          }}
        />
      </div>

      {items.length === 0 ? (
        <div className="right-empty">
          <p>할 일이 없습니다.</p>
          <p className="right-hint">
            에이전트도 <code>cvmux todo add</code>로 여기에 적을 수 있습니다.
          </p>
        </div>
      ) : (
        <ul className="right-todo-list">
          {items.map((item, index) => (
            <li key={item.id} className={`right-todo-row is-${item.state}`}>
              <button
                type="button"
                className="right-todo-check"
                title={item.state === 'completed' ? '완료 취소' : '완료'}
                onClick={() => {
                  if (workspaceId === null) return
                  void window.cvmux.todoSetState(
                    workspaceId,
                    item.id,
                    nextState(item.state)
                  )
                }}
              >
                {mark(item.state)}
              </button>
              <span className="right-todo-text">{item.text}</span>
              {/* 누가 적었는지 보인다 — 에이전트가 사람의 항목을 지우면 안 되는 근거 */}
              {item.origin === 'agent' ? <span className="right-todo-origin">에이전트</span> : null}
              <button
                type="button"
                className="icon-button right-todo-remove"
                title="지우기"
                aria-label={`${index + 1}번 항목 지우기`}
                onClick={() => {
                  if (workspaceId === null) return
                  void window.cvmux.todoRemove(workspaceId, item.id)
                }}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function SessionsView({
  sessions,
  onFocus
}: {
  sessions: SessionMeta[]
  onFocus(sessionId: string): void
}): JSX.Element {
  if (sessions.length === 0) {
    return (
      <div className="right-empty">
        <p>세션이 없습니다.</p>
      </div>
    )
  }

  return (
    <ul className="right-sessions">
      {sessions.map((session) => (
        <li key={session.id}>
          <button type="button" onClick={() => onFocus(session.id)} title={session.cwd}>
            <span className={`right-session-dot is-${session.status}`} />
            <span className="right-session-title">{session.title}</span>
            {session.ports.length > 0 ? (
              <span className="right-session-port">:{session.ports[0]}</span>
            ) : null}
          </button>
        </li>
      ))}
    </ul>
  )
}

/** 누르면 다음 상태로 — 대기 → 진행 중 → 완료 → 대기 */
function nextState(state: TodoItem['state']): TodoItem['state'] {
  if (state === 'pending') return 'in-progress'
  if (state === 'in-progress') return 'completed'
  return 'pending'
}

function mark(state: TodoItem['state']): string {
  if (state === 'completed') return '✓'
  if (state === 'in-progress') return '◐'
  return ''
}

function clock(at: number): string {
  const date = new Date(at)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

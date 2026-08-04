import { useEffect, useRef, type JSX } from 'react'

/**
 * 찾기 바 (POLICY.md P21-9).
 *
 * 화면 오른쪽 위에 뜬다. 터미널을 가리지 않으려고 폭을 좁게 잡고, 열려 있는
 * 동안에도 **터미널은 계속 돌아간다** — 찾는 동안 세션이 멈춘 것처럼 보이면
 * 안 된다.
 */

/** 다른 세션에서 찾은 한 줄. P21-10 */
export interface FindHit {
  sessionId: string
  sessionTitle: string
  workspaceId: string
  /** 스크롤백에서의 줄 번호 */
  line: number
  text: string
}

export interface FindBarProps {
  open: boolean
  query: string
  /** 몇 개 중 몇 번째. 없으면 0/0 */
  index: number
  count: number
  /** 모든 세션에서 찾는 중인가. P21-10 */
  scope: 'session' | 'all'
  /** scope가 'all'일 때의 결과 */
  hits: FindHit[]
  onQueryChange(query: string): void
  onNext(): void
  onPrevious(): void
  onScopeChange(scope: 'session' | 'all'): void
  onPick(hit: FindHit): void
  onClose(): void
}

export function FindBar(props: FindBarProps): JSX.Element | null {
  const { open, query, index, count } = props
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (open) inputRef.current?.select()
  }, [open])

  if (!open) return null

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.nativeEvent.isComposing) return

    if (event.key === 'Enter') {
      event.preventDefault()
      // Shift+Enter는 뒤로 — 편집기 관례 그대로다
      if (event.shiftKey) props.onPrevious()
      else props.onNext()
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      props.onClose()
    }
  }

  return (
    <div className="findbar-wrap">
    <div className="findbar" role="search">
      <input
        ref={inputRef}
        className="findbar-input"
        type="text"
        value={query}
        placeholder={props.scope === 'all' ? '모든 세션에서 찾기' : '이 화면에서 찾기'}
        spellCheck={false}
        onChange={(event) => props.onQueryChange(event.target.value)}
        onKeyDown={onKeyDown}
      />

      <span className="findbar-count">
        {query === ''
          ? ''
          : props.scope === 'all'
            ? props.hits.length === 0
              ? '없음'
              : `${props.hits.length}줄`
            : count === 0
              ? '없음'
              : `${index + 1}/${count}`}
      </span>

      <button
        type="button"
        className={`findbar-scope${props.scope === 'all' ? ' is-on' : ''}`}
        onClick={() => props.onScopeChange(props.scope === 'all' ? 'session' : 'all')}
        title="모든 세션에서 찾기 (Ctrl+Shift+F)"
      >
        전체
      </button>

      <button
        type="button"
        className="icon-button"
        onClick={props.onPrevious}
        title="이전 (Shift+Enter)"
        aria-label="이전"
      >
        ↑
      </button>
      <button
        type="button"
        className="icon-button"
        onClick={props.onNext}
        title="다음 (Enter)"
        aria-label="다음"
      >
        ↓
      </button>
      <button
        type="button"
        className="icon-button"
        onClick={props.onClose}
        title="닫기 (Escape)"
        aria-label="닫기"
      >
        ×
      </button>
    </div>

    {/* 다른 세션의 결과. 어느 세션의 몇 번째 줄인지가 답이다. P21-10 */}
    {props.scope === 'all' && query !== '' && props.hits.length > 0 ? (
      <ul className="findbar-hits">
        {props.hits.map((hit) => (
          <li key={`${hit.sessionId}:${hit.line}`}>
            <button type="button" onMouseDown={() => props.onPick(hit)}>
              <span className="findbar-hit-session">{hit.sessionTitle}</span>
              <span className="findbar-hit-text">{hit.text.trim()}</span>
            </button>
          </li>
        ))}
      </ul>
    ) : null}
    </div>
  )
}

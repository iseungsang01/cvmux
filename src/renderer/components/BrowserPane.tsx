import { useEffect, useRef, useState, type JSX } from 'react'

import type { BrowserMeta } from '@shared/types'

/**
 * 내장 브라우저 pane (POLICY.md P23).
 *
 * 여기서 그리는 것은 **주소창과 빈 자리**뿐이다. 페이지 자체는 창에 직접 얹힌
 * 네이티브 뷰라 DOM 안에 없다 — 그래서 자리표시 div의 사각형을 계속 재서
 * main에 알려 준다(P23-2). 이 pane이 화면에서 사라지면 뷰도 떼어 낸다.
 */

const CHROME_HEIGHT = 34

export interface BrowserPaneProps {
  paneId: string
  meta: BrowserMeta
  focused: boolean
  visible: boolean
  onFocus(paneId: string): void
}

export function BrowserPane({
  paneId,
  meta,
  focused,
  visible,
  onFocus
}: BrowserPaneProps): JSX.Element {
  const holdRef = useRef<HTMLDivElement>(null)
  const [draft, setDraft] = useState(meta.url)
  const [editing, setEditing] = useState(false)

  // 사용자가 주소창을 고치는 중이면 페이지 이동이 그것을 덮지 않는다
  useEffect(() => {
    if (!editing) setDraft(meta.url)
  }, [meta.url, editing])

  /*
   * 자리 재기 (P23-2).
   *
   * 크기가 바뀌는 길이 여러 갈래다 — 분할 드래그, 창 리사이즈, 사이드바 접기,
   * 워크스페이스 전환. 하나씩 붙잡는 대신 ResizeObserver로 실제 사각형을 보고,
   * 스크롤·이동까지 잡히도록 창 이벤트도 함께 듣는다.
   */
  useEffect(() => {
    const el = holdRef.current
    if (!el) return

    const report = (): void => {
      if (!visible) {
        void window.cvmux.browserPlace(meta.id, null)
        return
      }
      const box = el.getBoundingClientRect()
      void window.cvmux.browserPlace(meta.id, {
        x: box.x,
        y: box.y,
        width: box.width,
        height: box.height
      })
    }

    report()
    const observer = new ResizeObserver(report)
    observer.observe(el)
    window.addEventListener('resize', report)

    return () => {
      observer.disconnect()
      window.removeEventListener('resize', report)
      // 이 pane이 사라지면 뷰도 떼어 낸다 — 떼지 않으면 다른 화면 위에 남는다
      void window.cvmux.browserPlace(meta.id, null)
    }
  }, [meta.id, visible])

  const go = (): void => {
    setEditing(false)
    void window.cvmux.browserAction(meta.id, { kind: 'navigate', url: draft })
  }

  return (
    <section
      className={`pane pane-browser${focused ? ' is-focused' : ''}`}
      onPointerDownCapture={() => {
        if (!focused) onFocus(paneId)
      }}
    >
      <div className="browser-chrome" style={{ height: CHROME_HEIGHT }}>
        <button
          type="button"
          className="icon-button"
          disabled={!meta.canGoBack}
          onClick={() => void window.cvmux.browserAction(meta.id, { kind: 'back' })}
          title="뒤로"
          aria-label="뒤로"
        >
          ←
        </button>
        <button
          type="button"
          className="icon-button"
          disabled={!meta.canGoForward}
          onClick={() => void window.cvmux.browserAction(meta.id, { kind: 'forward' })}
          title="앞으로"
          aria-label="앞으로"
        >
          →
        </button>
        <button
          type="button"
          className="icon-button"
          onClick={() => void window.cvmux.browserAction(meta.id, { kind: 'reload' })}
          title="새로고침"
          aria-label="새로고침"
        >
          {meta.loading ? '×' : '⟳'}
        </button>

        <input
          className="browser-url"
          value={draft}
          spellCheck={false}
          placeholder="주소 또는 검색어"
          onChange={(event) => {
            setEditing(true)
            setDraft(event.target.value)
          }}
          onFocus={(event) => event.target.select()}
          onBlur={() => setEditing(false)}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return
            if (event.key === 'Enter') go()
            if (event.key === 'Escape') {
              setEditing(false)
              setDraft(meta.url)
              event.currentTarget.blur()
            }
          }}
        />

        <button
          type="button"
          className="icon-button"
          onClick={() => void window.cvmux.browserAction(meta.id, { kind: 'devtools' })}
          title="개발자 도구"
          aria-label="개발자 도구"
        >
          ⚙
        </button>
      </div>

      {/*
        페이지가 얹힐 자리. 비어 있는 것이 맞다 — 여기 무엇을 그리면 네이티브
        뷰 뒤에 가려 보이지 않는다. 로딩 중 표시만 배경으로 남긴다.
      */}
      <div className="browser-hold" ref={holdRef}>
        {meta.url === 'about:blank' && !meta.loading ? (
          <div className="browser-blank">주소를 입력하세요</div>
        ) : null}
      </div>
    </section>
  )
}

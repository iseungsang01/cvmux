import { useCallback, useEffect, useRef, type JSX, type PointerEvent as ReactPointerEvent } from 'react'

import type { PaneNode, SessionMeta } from '@shared/types'
import { exitLabel, isFailedExit } from '../lib/format'
import type { TerminalHost } from '../terminal-host'

/**
 * 워크스페이스 안의 pane 배치를 그린다 (POLICY.md P17).
 *
 * 트리를 그대로 재귀 렌더링한다. 잎은 터미널, 가지는 flex 컨테이너와 그 사이의
 * 드래그 손잡이다. 터미널 인스턴스 자체는 여기서 만들지 않는다 — 세션이 사는
 * 동안 유지되어야 하므로 TerminalHost가 따로 들고 있다(P5-1).
 */

/** 각 칸이 지켜야 할 최소 픽셀. P17-5 */
const MIN_PANE_PX = 120

interface PaneTreeProps {
  node: PaneNode
  sessions: Map<string, SessionMeta>
  host: TerminalHost
  focusedPaneId: string
  /** 이 워크스페이스가 지금 화면에 보이는가 */
  visible: boolean
  onFocusPane(paneId: string): void
  onResize(splitId: string, dividerIndex: number, ratioDelta: number, minRatio: number): void
}

export function PaneTree(props: PaneTreeProps): JSX.Element | null {
  const { node, sessions, host, focusedPaneId, visible, onFocusPane, onResize } = props

  if (node.kind === 'leaf') {
    const session = sessions.get(node.sessionId)
    if (!session) return null
    return (
      <TerminalPane
        paneId={node.id}
        session={session}
        host={host}
        focused={node.id === focusedPaneId}
        visible={visible}
        onFocus={onFocusPane}
      />
    )
  }

  return (
    <div className={`split is-${node.direction}`}>
      {node.children.map((child, index) => (
        <PaneFragment key={child.id}>
          {/*
            비율은 flex-grow로 준다. flex-basis 백분율로 주면 divider 두께가
            더해져 합이 100%를 넘고, 첫 칸이 나머지를 밀어내 버린다.
            grow는 divider가 쓰고 남은 공간만 비율대로 나눈다.
          */}
          <div className="split-slot" style={{ flexGrow: node.sizes[index] }}>
            <PaneTree {...props} node={child} />
          </div>
          {index < node.children.length - 1 && (
            <Divider
              direction={node.direction}
              onDrag={(delta, minRatio) => onResize(node.id, index, delta, minRatio)}
            />
          )}
        </PaneFragment>
      ))}
    </div>
  )
}

/** key를 달기 위한 껍데기 — Fragment에 key를 주면 자식 두 개를 묶을 수 없다 */
function PaneFragment({ children }: { children: React.ReactNode }): JSX.Element {
  return <>{children}</>
}

interface DividerProps {
  direction: 'row' | 'column'
  onDrag(ratioDelta: number, minRatio: number): void
}

function Divider({ direction, onDrag }: DividerProps): JSX.Element {
  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      event.preventDefault()
      const handle = event.currentTarget
      const container = handle.parentElement
      if (!container) return

      const horizontal = direction === 'row'
      const total = horizontal ? container.clientWidth : container.clientHeight
      if (total <= 0) return
      const minRatio = Math.min(0.4, MIN_PANE_PX / total)

      // 직전 위치와의 차이를 계속 더해 나간다 — 시작점 기준으로 계산하면
      // 최소 크기에 걸려 잘린 뒤 마우스를 되돌릴 때 값이 튄다
      let last = horizontal ? event.clientX : event.clientY
      handle.setPointerCapture(event.pointerId)

      const onMove = (moveEvent: PointerEvent): void => {
        const current = horizontal ? moveEvent.clientX : moveEvent.clientY
        const delta = (current - last) / total
        last = current
        if (delta !== 0) onDrag(delta, minRatio)
      }

      const onUp = (): void => {
        handle.removeEventListener('pointermove', onMove)
        handle.removeEventListener('pointerup', onUp)
        handle.removeEventListener('pointercancel', onUp)
      }

      handle.addEventListener('pointermove', onMove)
      handle.addEventListener('pointerup', onUp)
      handle.addEventListener('pointercancel', onUp)
    },
    [direction, onDrag]
  )

  return (
    <div
      className={`divider is-${direction}`}
      onPointerDown={onPointerDown}
      role="separator"
      aria-orientation={direction === 'row' ? 'vertical' : 'horizontal'}
    />
  )
}

interface TerminalPaneProps {
  paneId: string
  session: SessionMeta
  host: TerminalHost
  focused: boolean
  visible: boolean
  onFocus(paneId: string): void
}

function TerminalPane({
  paneId,
  session,
  host,
  focused,
  visible,
  onFocus
}: TerminalPaneProps): JSX.Element {
  const mountRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = mountRef.current
    if (!el) return
    host.attach(session.id, el)
    // 렌더러가 재시작됐다면 main의 재생 버퍼로 화면을 되살린다. P9-1
    void host.hydrate(session.id)
  }, [host, session.id])

  // 보이게 되거나 포커스를 받은 순간에만 크기를 맞춘다. 숨은 상태의 fit은
  // 1×1 터미널을 만든다. P2-3 / P17-6
  useEffect(() => {
    if (!visible) return
    if (focused) host.focus(session.id)
    else host.refit(session.id)
  }, [visible, focused, host, session.id])

  // 사이드바와 같은 기준 — 명시적 신호에만 테두리를 두른다. P4-14
  const attention = session.status === 'attention'
  const classes = [
    'pane',
    focused ? 'is-focused' : '',
    // 에이전트가 명시적으로 부른 pane에 노란 링. P4-1
    attention ? 'is-attention' : ''
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <section
      className={classes}
      onPointerDownCapture={() => {
        if (!focused) onFocus(paneId)
      }}
    >
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

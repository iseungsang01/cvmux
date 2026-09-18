import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type JSX,
  type PointerEvent as ReactPointerEvent
} from 'react'

import type { BrowserMeta, PaneNode, RelayMode, SessionMeta } from '@shared/types'
import { exitLabel, isFailedExit } from '../lib/format'
import type { TerminalHost } from '../terminal-host'
import { BrowserPane } from './BrowserPane'

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
  /** 내장 브라우저 화면들. 잎이 가리키는 id가 여기 있으면 브라우저다. P23-2 */
  browsers: Map<string, BrowserMeta>
  host: TerminalHost
  focusedPaneId: string
  /** 이 워크스페이스가 지금 화면에 보이는가 */
  visible: boolean
  onFocusPane(paneId: string): void
  onResize(splitId: string, dividerIndex: number, ratioDelta: number, minRatio: number): void
  /** 가로 탭 (P24) */
  onSelectSurface(paneId: string, index: number): void
  onCloseSurface(surfaceId: string): void
  /** 탭을 끌어 자리를 바꾼다. P24-3 */
  onMoveSurface(paneId: string, from: number, to: number): void
  /** 분할선의 ⇄ — a가 왼쪽(위), b가 오른쪽(아래) 세션. P29-2 */
  onSetRelay(a: string, b: string, mode: RelayMode): void
  /** 사람 입력 없이 자동으로 넘기는 연속 횟수 상한. ⇄를 우클릭해 바꾼다. P29-6 */
  relayLimit: number
  onSetRelayLimit(value: number): void
}

/**
 * pane 안의 가로 탭 (P24-1).
 *
 * cmux는 이 자리를 surface라 부른다. 사이드바 한 줄이 워크스페이스, 그 안의
 * 칸이 pane, pane 안의 탭이 surface다.
 */
interface SurfaceTabsProps {
  paneId: string
  surfaces: string[]
  active: number
  sessions: Map<string, SessionMeta>
  browsers: Map<string, BrowserMeta>
  onSelect(paneId: string, index: number): void
  onClose(surfaceId: string): void
  onFocusPane(paneId: string): void
  onMove(paneId: string, from: number, to: number): void
}

function SurfaceTabs({
  paneId,
  surfaces,
  active,
  sessions,
  browsers,
  onSelect,
  onClose,
  onFocusPane,
  onMove
}: SurfaceTabsProps): JSX.Element {
  /*
   * 끌고 있는 탭 (P24-3).
   *
   * 어느 자리에 놓일지는 끌던 탭과 지나는 탭의 관계로만 정해지므로, 상태는
   * 탭 하나가 아니라 탭 바가 들고 있어야 한다 — 사이드바 줄 재정렬과 같다(P19-8).
   */
  const [dragFrom, setDragFrom] = useState<number | null>(null)
  const [overIndex, setOverIndex] = useState<number | null>(null)

  const endDrag = (): void => {
    setDragFrom(null)
    setOverIndex(null)
  }

  return (
    <div className="surface-tabs" role="tablist">
      {surfaces.map((id, index) => {
        const browser = browsers.get(id)
        const session = sessions.get(id)
        const label = browser ? (browser.title || browser.url || '브라우저') : (session?.title ?? '세션')
        // 탭이 좁아도 상태는 보여야 한다 — 색 점 하나로 줄인다. P4
        const status = session?.status ?? null
        const unread = session?.unread === true

        return (
          <div
            key={id}
            className={[
              'surface-tab',
              index === active ? 'is-active' : '',
              unread ? 'is-unread' : '',
              dragFrom === index ? 'is-dragging' : '',
              // 끌어온 방향이 선의 위치를 정한다 — 놓으면 그 자리에 들어간다
              dragFrom !== null && overIndex === index && dragFrom !== index
                ? dragFrom < index
                  ? 'is-drop-after'
                  : 'is-drop-before'
                : ''
            ]
              .filter(Boolean)
              .join(' ')}
            role="tab"
            aria-selected={index === active}
            title={label}
            draggable
            onDragStart={(event) => {
              event.dataTransfer.setData('text/plain', String(index))
              event.dataTransfer.effectAllowed = 'move'
              setDragFrom(index)
            }}
            onDragOver={(event) => {
              // preventDefault를 해야 이 탭이 드롭을 받는다
              event.preventDefault()
              event.dataTransfer.dropEffect = 'move'
              setOverIndex(index)
            }}
            onDrop={(event) => {
              event.preventDefault()
              if (dragFrom !== null && dragFrom !== index) onMove(paneId, dragFrom, index)
              endDrag()
            }}
            // 탭 바 밖에서 손을 놓아도 끌던 표시는 걷어야 한다
            onDragEnd={endDrag}
            onPointerDown={(event) => {
              // 가운데 버튼으로 닫기 — 브라우저 탭의 관례다
              if (event.button === 1) {
                event.preventDefault()
                onClose(id)
                return
              }
              onFocusPane(paneId)
              onSelect(paneId, index)
            }}
          >
            {browser ? (
              <span className="surface-tab-icon">◱</span>
            ) : (
              <span className={`surface-tab-dot${status ? ` is-${status}` : ''}`} />
            )}
            <span className="surface-tab-label">{label}</span>
            <button
              type="button"
              className="surface-tab-close"
              onPointerDown={(event) => {
                event.stopPropagation()
                event.preventDefault()
                onClose(id)
              }}
              title="탭 닫기"
              aria-label="탭 닫기"
            >
              ×
            </button>
          </div>
        )
      })}
    </div>
  )
}

export function PaneTree(props: PaneTreeProps): JSX.Element | null {
  const {
    node,
    sessions,
    browsers,
    host,
    focusedPaneId,
    visible,
    onFocusPane,
    onResize,
    onSelectSurface,
    onCloseSurface,
    onMoveSurface,
    onSetRelay,
    relayLimit,
    onSetRelayLimit
  } = props

  if (node.kind === 'leaf') {
    const active = node.surfaces[Math.min(node.active, node.surfaces.length - 1)]
    const focused = node.id === focusedPaneId

    /*
     * 잎 하나는 터미널이거나 브라우저다 (P23-2).
     *
     * 트리에 종류를 따로 적지 않고 id가 어느 목록에 있는지로 가른다 — 배치를
     * 다루는 코드(분할·닫기·복원)가 둘을 구분할 이유가 없기 때문이다.
     */
    const browser = browsers.get(active)
    const session = browser ? undefined : sessions.get(active)
    if (!browser && !session) return null

    return (
      <div className="pane-stack">
        {/*
          탭 바는 탭이 둘 이상일 때만 그린다 (P24-1).

          하나뿐인데 탭 바가 있으면 화면만 잡아먹고 아무것도 알려주지 않는다.
          나누어 쓰지 않는 사용자에게는 이 구조가 아예 보이지 않아야 한다.
        */}
        {node.surfaces.length > 1 && (
          <SurfaceTabs
            paneId={node.id}
            surfaces={node.surfaces}
            active={node.active}
            sessions={sessions}
            browsers={browsers}
            onSelect={onSelectSurface}
            onClose={onCloseSurface}
            onFocusPane={onFocusPane}
            onMove={onMoveSurface}
          />
        )}

        {browser ? (
          <BrowserPane
            paneId={node.id}
            meta={browser}
            focused={focused}
            visible={visible}
            onFocus={onFocusPane}
          />
        ) : (
          <TerminalPane
            paneId={node.id}
            session={session!}
            host={host}
            focused={focused}
            visible={visible}
            onFocus={onFocusPane}
          />
        )}
      </div>
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
              relay={relayPair(child, node.children[index + 1], sessions)}
              onSetRelay={onSetRelay}
              relayLimit={relayLimit}
              onSetRelayLimit={onSetRelayLimit}
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

/**
 * 분할선 양쪽의 두 세션 (P29-2).
 *
 * 양쪽이 모두 터미널 잎일 때만 ⇄를 단다. 한쪽이 다시 나뉘어 있으면 어느 칸과
 * 잇는지 분할선만 보고는 알 수 없다. 잇는 것은 그 순간 보이는 탭의 세션이고,
 * 연결은 세션을 따라간다 — 탭을 바꿔도 끊기지 않는다.
 */
interface RelayPair {
  a: string
  b: string
  mode: RelayMode
}

function relayPair(
  left: PaneNode,
  right: PaneNode,
  sessions: Map<string, SessionMeta>
): RelayPair | null {
  const end = (node: PaneNode): SessionMeta | null =>
    node.kind === 'leaf' ? (sessions.get(node.surfaces[node.active]) ?? null) : null
  const a = end(left)
  const b = end(right)
  if (!a || !b) return null
  const forward = a.relayTo === b.id
  const backward = b.relayTo === a.id
  const mode: RelayMode = forward && backward ? 'both' : forward ? 'forward' : backward ? 'backward' : 'off'
  return { a: a.id, b: b.id, mode }
}

/** 누를 때마다 끔 → 오른쪽(아래)으로 → 왼쪽(위)으로 → 양방향. P29-2 */
const NEXT_MODE: Record<RelayMode, RelayMode> = {
  off: 'forward',
  forward: 'backward',
  backward: 'both',
  both: 'off'
}

function relayGlyph(mode: RelayMode, direction: 'row' | 'column'): string {
  const row = direction === 'row'
  if (mode === 'forward') return row ? '→' : '↓'
  if (mode === 'backward') return row ? '←' : '↑'
  return row ? '⇄' : '⇅'
}

function relayTitle(mode: RelayMode, direction: 'row' | 'column', limit: number): string {
  const [ahead, back] = direction === 'row' ? ['오른쪽으로', '왼쪽으로'] : ['아래로', '위로']
  const now =
    mode === 'off'
      ? '꺼짐'
      : mode === 'forward'
        ? `${ahead} 넘김`
        : mode === 'backward'
          ? `${back} 넘김`
          : '양쪽으로 넘김'
  return (
    `옆 에이전트에게 답 넘기기: ${now} — 누르면 바뀝니다 (에이전트가 턴을 끝낼 때마다 마지막 답을 옆 입력창에 넣습니다)\n` +
    `우클릭: 연속 전달 상한 바꾸기 (지금 ${limit}번)`
  )
}

/**
 * 연속 전달 상한 편집 (P29-6).
 *
 * 값은 설정 파일(relay.maxAutoTurns)에 적힌다 — 파일로 고친 사람과 화면에서
 * 고친 사람이 같은 값을 본다. Enter나 다른 곳을 누르면 저장, Esc는 취소.
 */
function RelayLimitEditor({
  limit,
  onSave,
  onClose
}: {
  limit: number
  onSave(value: number): void
  onClose(): void
}): JSX.Element {
  const [text, setText] = useState(String(limit))
  // Enter로 저장하고 닫으면 뒤이어 blur가 한 번 더 온다 — 두 번 적지 않는다
  const done = useRef(false)
  const value = Number(text)
  const valid = Number.isInteger(value) && value >= 1 && value <= 1000

  const finish = (save: boolean): void => {
    if (done.current) return
    done.current = true
    if (save && valid && value !== limit) onSave(value)
    onClose()
  }

  return (
    <div
      className="relay-limit"
      role="dialog"
      aria-label="연속 전달 상한"
      onPointerDown={(event) => event.stopPropagation()}
    >
      <label className="relay-limit-row">
        사람 입력 없이
        <input
          type="number"
          min={1}
          max={1000}
          value={text}
          autoFocus
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            // 앱 단축키와 터미널로 새지 않게 여기서 끝낸다
            event.stopPropagation()
            if (event.key === 'Enter') finish(true)
            if (event.key === 'Escape') finish(false)
          }}
          onBlur={() => finish(true)}
        />
        번까지 넘깁니다
      </label>
      <div className={`relay-limit-hint${valid ? '' : ' is-invalid'}`}>
        {valid ? '넘으면 두 방향 모두 멈춥니다. 모든 ⇄에 함께 적용됩니다' : '1에서 1000 사이로 적어 주세요'}
      </div>
    </div>
  )
}

interface DividerProps {
  direction: 'row' | 'column'
  onDrag(ratioDelta: number, minRatio: number): void
  relay: RelayPair | null
  onSetRelay(a: string, b: string, mode: RelayMode): void
  relayLimit: number
  onSetRelayLimit(value: number): void
}

function Divider({
  direction,
  onDrag,
  relay,
  onSetRelay,
  relayLimit,
  onSetRelayLimit
}: DividerProps): JSX.Element {
  const [editingLimit, setEditingLimit] = useState(false)
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
    >
      {relay && (
        <button
          type="button"
          className={`relay-toggle is-${relay.mode}`}
          title={relayTitle(relay.mode, direction, relayLimit)}
          aria-label={relayTitle(relay.mode, direction, relayLimit)}
          aria-pressed={relay.mode !== 'off'}
          // 분할선을 끄는 동작이 시작되지 않게 한다
          onPointerDown={(event) => event.stopPropagation()}
          onClick={() => onSetRelay(relay.a, relay.b, NEXT_MODE[relay.mode])}
          onContextMenu={(event) => {
            event.preventDefault()
            setEditingLimit(true)
          }}
        >
          {relayGlyph(relay.mode, direction)}
        </button>
      )}
      {relay && editingLimit && (
        <RelayLimitEditor
          limit={relayLimit}
          onSave={onSetRelayLimit}
          onClose={() => setEditingLimit(false)}
        />
      )}
    </div>
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
  const dormant = session.status === 'dormant'
  /*
   * 켜지 않은 세션은 xterm도 만들지 않는다 (P28-2).
   *
   * 셸만 재워 두고 터미널은 세션마다 만들어 두면, 볼 일 없는 스크롤백이
   * 렌더러 메모리를 그대로 붙든다. 처음 보일 때 만들고 그때 화면을 되살린다.
   */
  const shown = visible || !dormant

  useEffect(() => {
    if (!shown) return
    const el = mountRef.current
    if (!el) return
    host.attach(session.id, el)
    // 렌더러가 재시작됐다면 main의 재생 버퍼로 화면을 되살린다. P9-1
    void host.hydrate(session.id)
  }, [host, session.id, shown])

  /*
   * 보이는 순간 셸을 띄운다 (P28-2).
   *
   * 화면을 되살리는 요청(위)이 먼저 나가야 한다 — 셸이 먼저 뜨면 그 첫 출력이
   * 재생 버퍼와 실시간 이벤트 양쪽으로 와서 두 번 그려진다.
   */
  useEffect(() => {
    if (visible && dormant) void window.cvmux.wake(session.id)
  }, [visible, dormant, session.id])

  // 보이지 않는 워크스페이스의 터미널은 WebGL 컨텍스트를 놓아준다. P5-10
  useEffect(() => {
    host.setVisible(session.id, visible)
  }, [host, session.id, visible])

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

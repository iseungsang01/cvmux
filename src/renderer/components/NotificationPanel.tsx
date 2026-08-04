import { useEffect, useRef, type JSX } from 'react'

import type { Notification } from '@shared/types'

/**
 * 알림함 (POLICY.md P21-3).
 *
 * 사이드바의 파란 링은 "지금 누가 나를 부르는가"에 답한다. 이 패널은
 * **"자리를 비운 동안 무슨 일이 있었나"**에 답한다 — 링은 세션을 한 번
 * 들여다보면 꺼지고, 무엇을 알리려 했는지는 남지 않기 때문이다.
 */

export interface NotificationPanelProps {
  items: Notification[]
  open: boolean
  onClose(): void
  onOpen(item: Notification): void
  onToggleRead(item: Notification): void
  onDismiss(item: Notification): void
  onClear(scope: 'read' | 'all'): void
}

export function NotificationPanel(props: NotificationPanelProps): JSX.Element | null {
  const { items, open, onClose } = props
  const ref = useRef<HTMLDivElement>(null)

  // 바깥을 누르거나 Escape로 닫는다 — 팝오버의 관례다
  useEffect(() => {
    if (!open) return

    const onPointerDown = (event: MouseEvent): void => {
      if (ref.current && !ref.current.contains(event.target as Node)) onClose()
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
      }
    }

    window.addEventListener('mousedown', onPointerDown, true)
    window.addEventListener('keydown', onKeyDown, true)
    return () => {
      window.removeEventListener('mousedown', onPointerDown, true)
      window.removeEventListener('keydown', onKeyDown, true)
    }
  }, [open, onClose])

  if (!open) return null

  const unread = items.filter((n) => !n.read).length

  return (
    <div className="notify-panel" ref={ref} role="dialog" aria-label="알림">
      <div className="notify-head">
        <span className="notify-head-title">
          알림
          {unread > 0 ? <span className="notify-head-count">{unread}</span> : null}
        </span>
        <div className="notify-head-actions">
          <button
            type="button"
            className="link-button"
            onClick={() => props.onClear('read')}
            disabled={items.every((n) => !n.read)}
          >
            읽은 것 치우기
          </button>
          <button
            type="button"
            className="link-button"
            onClick={() => props.onClear('all')}
            disabled={items.length === 0}
          >
            모두 비우기
          </button>
        </div>
      </div>

      {items.length === 0 ? (
        <div className="notify-empty">
          <p>알림이 없습니다.</p>
          <p className="notify-empty-hint">
            에이전트가 확인을 기다리거나 작업을 마치면 여기에 쌓입니다.
          </p>
        </div>
      ) : (
        <ul className="notify-list">
          {items.map((item) => (
            <li key={item.id} className={`notify-item${item.read ? '' : ' is-unread'}`}>
              <button
                type="button"
                className="notify-item-main"
                onClick={() => props.onOpen(item)}
                title="이 세션으로 이동"
              >
                <span className="notify-item-title">{item.sessionTitle}</span>
                <span className="notify-item-text">{item.text || '(내용 없음)'}</span>
                <span className="notify-item-time">{relativeTime(item.createdAt)}</span>
              </button>
              <div className="notify-item-actions">
                <button
                  type="button"
                  className="icon-button"
                  onClick={() => props.onToggleRead(item)}
                  title={item.read ? '읽지 않음으로 표시' : '읽음으로 표시'}
                  aria-label={item.read ? '읽지 않음으로 표시' : '읽음으로 표시'}
                >
                  {item.read ? '○' : '●'}
                </button>
                <button
                  type="button"
                  className="icon-button"
                  onClick={() => props.onDismiss(item)}
                  title="지우기"
                  aria-label="지우기"
                >
                  ×
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/**
 * 언제였는지 (P21-3).
 *
 * 절대 시각은 목록에서 읽기 어렵다. "3분 전"은 지금 대응해야 하는지를
 * 바로 알려주지만 "14:22"는 계산을 시킨다.
 */
function relativeTime(at: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - at) / 1000))
  if (seconds < 60) return '방금'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}분 전`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}시간 전`
  return `${Math.floor(hours / 24)}일 전`
}

import { Notification } from 'electron'

import { POLICY } from '@shared/policy'

/**
 * Windows 토스트 알림 (POLICY.md P15).
 *
 * 사이드바의 파란 링이 1차 신호이고 토스트는 보조 수단이다. 그래서 사용자가
 * 이미 그 세션을 보고 있으면 띄우지 않는다 — 알림의 목적은 "지금 안 보고 있는
 * 것"을 알리는 데 있다.
 */

export interface NotifyRequest {
  sessionId: string
  sessionTitle: string
  text: string
  /** 사용자가 지금 이 세션을 보고 있는가 */
  isActiveSession: boolean
  /** 창이 포커스를 갖고 있는가 */
  windowFocused: boolean
}

export class Notifier {
  private readonly supported = Notification.isSupported()
  private readonly lastAt = new Map<string, number>()
  private readonly active = new Map<string, Notification>()

  constructor(private readonly onActivate: (sessionId: string) => void) {}

  notify(request: NotifyRequest): void {
    // 시스템 알림이 꺼져 있어도 사이드바 표시는 그대로 동작한다. P15-6
    if (!this.supported) return

    // 보고 있는 세션 + 포커스된 창이면 띄우지 않는다. 창이 뒤에 있으면
    // 활성 세션이라도 알린다. P15-2 / P15-3
    if (request.isActiveSession && request.windowFocused) return

    const now = Date.now()
    const previous = this.active.get(request.sessionId)
    const last = this.lastAt.get(request.sessionId) ?? 0

    // 짧은 시간에 연달아 오면 이전 것을 닫고 마지막 내용만 남긴다. P15-4
    if (previous && now - last < POLICY.NOTIFY_COALESCE_MS) {
      try {
        previous.close()
      } catch {
        // 이미 닫혔다
      }
    }

    const notification = new Notification({
      title: request.sessionTitle,
      // 단독 BEL처럼 내용이 없는 알림도 있다. P15-7
      body: request.text.trim() || '확인이 필요합니다',
      silent: false
    })

    notification.on('click', () => this.onActivate(request.sessionId)) // P15-5
    notification.on('close', () => {
      if (this.active.get(request.sessionId) === notification) {
        this.active.delete(request.sessionId)
      }
    })

    try {
      notification.show()
      this.active.set(request.sessionId, notification)
      this.lastAt.set(request.sessionId, now)
    } catch (error) {
      // 알림 실패가 앱 흐름을 막아서는 안 된다. P12-2
      console.warn('[cvmux] 알림을 띄우지 못했습니다:', error)
    }
  }

  /** 세션이 닫히면 관련 알림도 정리한다 */
  forget(sessionId: string): void {
    const notification = this.active.get(sessionId)
    if (notification) {
      try {
        notification.close()
      } catch {
        // 이미 닫혔다
      }
    }
    this.active.delete(sessionId)
    this.lastAt.delete(sessionId)
  }
}

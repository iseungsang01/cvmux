import { randomUUID } from 'node:crypto'

import { POLICY } from '@shared/policy'
import type { Notification } from '@shared/types'

/**
 * 알림함 (POLICY.md P21).
 *
 * 지금까지 알림은 세션에 붙은 미읽음 표시 하나가 전부였다. 그것은 "지금 누가
 * 나를 부르는가"에는 답하지만 **"내가 자리를 비운 동안 무슨 일이 있었나"**에는
 * 답하지 못한다. 세션을 한 번 들여다보면 표시가 지워지고, 무엇을 알리려 했는지는
 * 남지 않는다.
 *
 * 그래서 알림을 목록으로 남긴다. 세션이 닫혀도 남는다 — 무엇이 나를 불렀는지는
 * 그 세션이 사라진 뒤에도 알아야 할 때가 있다.
 */
export class NotificationStore {
  private items: Notification[] = []

  constructor(private readonly onChange: () => void) {}

  /**
   * 알림을 넣는다 (P21-1).
   *
   * 같은 세션이 짧은 사이에 여러 번 부르면 마지막 것만 남긴다 — 토스트를
   * 합치는 것과 같은 이유다(P15-4). 다섯 줄이 쌓이는 것보다 마지막 한 줄이
   * 지금 상태를 더 정확히 말한다.
   */
  add(sessionId: string, sessionTitle: string, text: string): Notification {
    const now = Date.now()
    const previous = this.items.at(-1)

    if (
      previous &&
      previous.sessionId === sessionId &&
      !previous.read &&
      now - previous.createdAt < POLICY.NOTIFY_COALESCE_MS
    ) {
      previous.text = text
      previous.sessionTitle = sessionTitle
      previous.createdAt = now
      this.onChange()
      return previous
    }

    const item: Notification = {
      id: randomUUID(),
      sessionId,
      sessionTitle,
      text,
      createdAt: now,
      read: false
    }
    this.items.push(item)
    this.prune()
    this.onChange()
    return item
  }

  /** 최신이 앞이다 — 목록을 여는 사람은 방금 온 것을 먼저 본다. P21-3 */
  list(): Notification[] {
    return [...this.items].reverse()
  }

  unreadCount(): number {
    let n = 0
    for (const item of this.items) if (!item.read) n++
    return n
  }

  /** 가장 최근의 읽지 않은 알림. `jump-to-unread`가 쓴다. P21-4 */
  latestUnread(): Notification | null {
    for (let i = this.items.length - 1; i >= 0; i--) {
      if (!this.items[i].read) return this.items[i]
    }
    return null
  }

  markRead(id: string): boolean {
    const item = this.items.find((n) => n.id === id)
    if (!item || item.read) return false
    item.read = true
    this.onChange()
    return true
  }

  /**
   * 세션을 보면 그 세션의 알림은 전부 읽은 것이 된다 (P21-5).
   *
   * 사이드바의 파란 링과 알림함이 따로 놀면 안 된다 — 링이 꺼졌는데 알림함에
   * 미읽음이 남아 있으면 배지가 거짓말을 한다.
   */
  markSessionRead(sessionId: string): boolean {
    let changed = false
    for (const item of this.items) {
      if (item.sessionId !== sessionId || item.read) continue
      item.read = true
      changed = true
    }
    if (changed) this.onChange()
    return changed
  }

  markAllRead(): void {
    let changed = false
    for (const item of this.items) {
      if (item.read) continue
      item.read = true
      changed = true
    }
    if (changed) this.onChange()
  }

  /** 다시 읽지 않음으로. 나중에 보려고 남겨 두는 용도다. P21-7 */
  setUnread(id: string): boolean {
    const item = this.items.find((n) => n.id === id)
    if (!item || !item.read) return false
    item.read = false
    this.onChange()
    return true
  }

  dismiss(id: string): boolean {
    const before = this.items.length
    this.items = this.items.filter((n) => n.id !== id)
    if (this.items.length === before) return false
    this.onChange()
    return true
  }

  /** 읽은 것만 치운다. 아직 보지 않은 것을 지우는 것은 사용자만 할 수 있다. P21-2 */
  dismissRead(): void {
    const before = this.items.length
    this.items = this.items.filter((n) => !n.read)
    if (this.items.length !== before) this.onChange()
  }

  clear(): void {
    if (this.items.length === 0) return
    this.items = []
    this.onChange()
  }

  find(id: string): Notification | null {
    return this.items.find((n) => n.id === id) ?? null
  }

  /** 저장/복원. 세션과 함께 남는다. P21-8 */
  serialize(): Notification[] {
    return this.items.map((item) => ({ ...item }))
  }

  restore(items: Notification[]): void {
    this.items = items.slice(-POLICY.MAX_NOTIFICATIONS)
  }

  /**
   * 상한을 지킨다 (P21-2).
   *
   * 읽은 것부터 밀어낸다. 그래도 넘치면 그때는 오래된 것부터 — 그 지경이면
   * 미읽음이 200개라는 뜻이고, 목록 자체가 이미 신호가 아니다.
   */
  private prune(): void {
    if (this.items.length <= POLICY.MAX_NOTIFICATIONS) return

    const excess = this.items.length - POLICY.MAX_NOTIFICATIONS
    let removed = 0
    this.items = this.items.filter((item) => {
      if (removed >= excess || !item.read) return true
      removed++
      return false
    })

    if (this.items.length > POLICY.MAX_NOTIFICATIONS) {
      this.items = this.items.slice(-POLICY.MAX_NOTIFICATIONS)
    }
  }
}

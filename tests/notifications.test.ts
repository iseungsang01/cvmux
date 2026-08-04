/*
 * 알림함(POLICY.md P21)의 회귀 테스트.
 *
 * 알림함이 지켜야 하는 것은 **아직 보지 않은 것은 절대 잃지 않는다**이다.
 * 목록이 가득 찼다고 미읽음이 밀려나면 그건 알림함이 아니라 그냥 로그다.
 *
 * 실행: npm test
 */
import { NotificationStore } from '../src/core/notifications'
import { POLICY } from '../src/shared/policy'

const results: string[] = []
let failed = 0

function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failed++
  results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `  ← ${detail}` : ''}`)
}

function main(): void {
  // ── 기본
  {
    let changes = 0
    const inbox = new NotificationStore(() => changes++)

    inbox.add('s1', '빌드', '시작했습니다')
    inbox.add('s2', 'claude', '확인이 필요합니다')

    check('두 개가 쌓인다', inbox.list().length === 2)
    check('바뀔 때마다 알린다', changes === 2, String(changes))
    check('최신이 앞', inbox.list()[0].sessionId === 's2')
    check('미읽음 수', inbox.unreadCount() === 2)
    check('가장 최근 미읽음', inbox.latestUnread()?.sessionId === 's2')
  }

  /*
   * 같은 세션의 연속 알림은 합친다 (P21-1).
   *
   * 에이전트는 한 작업에서 여러 번 부를 수 있다. 다섯 줄이 쌓이는 것보다
   * 마지막 한 줄이 지금 상태를 더 정확히 말한다.
   */
  {
    const inbox = new NotificationStore(() => {})
    inbox.add('s1', 'claude', '첫 번째')
    inbox.add('s1', 'claude', '두 번째')
    inbox.add('s1', 'claude', '세 번째')

    check('연속 알림은 한 줄', inbox.list().length === 1, String(inbox.list().length))
    check('마지막 내용이 남는다', inbox.list()[0].text === '세 번째')

    // 다른 세션이 끼어들면 합치지 않는다 — 다른 일이기 때문이다
    inbox.add('s2', '빌드', '끝')
    inbox.add('s1', 'claude', '네 번째')
    check('사이에 다른 세션이 오면 새 줄', inbox.list().length === 3, String(inbox.list().length))
  }

  // 이미 읽은 알림에는 합치지 않는다 — 읽은 것을 되살리면 배지가 되살아난다
  {
    const inbox = new NotificationStore(() => {})
    const first = inbox.add('s1', 'claude', '처음')
    inbox.markRead(first.id)
    inbox.add('s1', 'claude', '다음')
    check('읽은 알림에는 합치지 않는다', inbox.list().length === 2, String(inbox.list().length))
  }

  // ── 읽음 처리
  {
    const inbox = new NotificationStore(() => {})
    const a = inbox.add('s1', 'A', '1')
    inbox.add('s2', 'B', '2')

    check('하나 읽음', inbox.markRead(a.id) && inbox.unreadCount() === 1)
    check('이미 읽은 것은 변화 없음', !inbox.markRead(a.id))
    check('다시 안 읽음으로', inbox.setUnread(a.id) && inbox.unreadCount() === 2)

    inbox.markAllRead()
    check('전부 읽음', inbox.unreadCount() === 0)
    check('미읽음이 없으면 latestUnread는 null', inbox.latestUnread() === null)
  }

  /*
   * 세션을 보면 그 세션의 알림이 전부 읽음이 된다 (P21-5).
   *
   * 사이드바의 링과 알림함 배지가 따로 놀면 둘 중 하나는 거짓말이 된다.
   */
  {
    const inbox = new NotificationStore(() => {})
    inbox.add('s1', 'A', '1')
    inbox.add('s2', 'B', '2')
    inbox.add('s1', 'A', '3')

    inbox.markSessionRead('s1')
    check('그 세션 것만 읽음', inbox.unreadCount() === 1)
    check('남은 미읽음은 다른 세션', inbox.latestUnread()?.sessionId === 's2')
  }

  // ── 치우기
  {
    const inbox = new NotificationStore(() => {})
    const a = inbox.add('s1', 'A', '1')
    inbox.add('s2', 'B', '2')
    inbox.markRead(a.id)

    inbox.dismissRead()
    check('읽은 것만 치운다', inbox.list().length === 1 && inbox.list()[0].sessionId === 's2')

    inbox.clear()
    check('전부 비운다', inbox.list().length === 0)
  }

  /*
   * 상한 (P21-2).
   *
   * 여기가 이 테스트의 핵심이다. 오래된 것부터가 아니라 **읽은 것부터**
   * 밀어낸다 — 목록이 가득 찼다고 아직 보지 않은 알림이 사라지면 안 된다.
   */
  {
    const inbox = new NotificationStore(() => {})
    const cap = POLICY.MAX_NOTIFICATIONS

    // 세션을 번갈아 넣는다. 같은 세션이 연달아 오면 합쳐지기 때문이다
    for (let i = 0; i < cap; i++) inbox.add(`s${i % 2}`, 'old', `읽을 것 ${i}`)
    inbox.markAllRead()
    check('상한만큼 찼다', inbox.list().length === cap, String(inbox.list().length))

    for (let i = 0; i < 10; i++) inbox.add(`n${i % 2}`, 'new', `새 것 ${i}`)

    check('상한을 넘지 않는다', inbox.list().length === cap, String(inbox.list().length))
    check('새 미읽음이 전부 남았다', inbox.unreadCount() === 10, String(inbox.unreadCount()))
    check('밀려난 것은 읽은 쪽', inbox.list().every((n) => !n.read || n.sessionTitle === 'old'))
  }

  // ── 저장과 복원 (P21-8)
  {
    const inbox = new NotificationStore(() => {})
    inbox.add('s1', 'A', '1')
    const saved = inbox.serialize()

    const restored = new NotificationStore(() => {})
    restored.restore(saved)
    check('복원된다', restored.list().length === 1 && restored.list()[0].text === '1')
    check('읽음 상태도 함께', restored.unreadCount() === 1)

    // 직렬화가 내부 배열을 그대로 넘기면 저장본이 나중에 함께 바뀐다
    inbox.markAllRead()
    check('저장본은 복사본', saved[0].read === false)
  }

  console.log(results.join('\n'))
  console.log(`\n${results.length - failed}/${results.length} passed`)
  process.exit(failed === 0 ? 0 : 1)
}

main()

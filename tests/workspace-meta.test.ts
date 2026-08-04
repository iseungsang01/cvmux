/*
 * 사이드바 메타데이터(POLICY.md P25)의 회귀 테스트.
 *
 * 여기 담기는 것은 cvmux가 알아낸 것이 아니라 **에이전트가 적어 둔 것**이다.
 * 그래서 지켜야 하는 것도 다르다.
 *
 * 1. **같은 이름의 pill은 덮어쓴다.** 에이전트는 단계가 바뀔 때마다 같은
 *    이름으로 다시 쓰는데, 쌓이면 사이드바에 낡은 단계가 남는다.
 * 2. **목록을 통째로 갈아 끼워도 항목의 정체가 유지된다.** 감시 루프가 매
 *    틱마다 전체를 다시 보내도 체크박스가 새로 만들어지면 안 된다.
 *
 * 실행: npm test
 */
import { WorkspaceMetaStore, workspaceOfSession } from '../src/core/workspace-meta'
import { POLICY } from '../src/shared/policy'
import type { Workspace } from '../src/shared/types'

const results: string[] = []
let failed = 0

function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failed++
  results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `  ← ${detail}` : ''}`)
}

function main(): void {
  // ── P25-1: 상태 pill
  {
    let changes = 0
    const store = new WorkspaceMetaStore(() => changes++)

    store.setStatus('ws', 'build', '컴파일 중')
    check('pill이 붙는다', store.get('ws').status.length === 1)
    check('바뀌면 알린다', changes === 1)

    /*
     * 같은 이름으로 다시 쓰면 덮어쓴다.
     *
     * 쌓이면 사이드바에 `컴파일 중` `테스트 중` `배포 중`이 함께 남아,
     * 지금이 어느 단계인지 알 수 없게 된다.
     */
    store.setStatus('ws', 'build', '테스트 중')
    check('같은 이름은 덮어쓴다', store.get('ws').status.length === 1)
    check('내용은 최신', store.get('ws').status[0].text === '테스트 중')

    store.setStatus('ws', 'deploy', '대기')
    check('다른 이름은 따로', store.get('ws').status.length === 2)

    check('이름으로 지운다', store.clearStatus('ws', 'build') === 1)
    check('남은 것은 그대로', store.get('ws').status[0].name === 'deploy')
    check('전부 지운다', store.clearStatus('ws') === 1 && store.get('ws').status.length === 0)
  }

  // 사이드바 한 줄에 들어갈 수 있는 것은 몇 개뿐이다
  {
    const store = new WorkspaceMetaStore(() => {})
    for (let i = 0; i < POLICY.MAX_STATUS_PILLS + 3; i++) {
      store.setStatus('ws', `p${i}`, String(i))
    }
    check('pill 상한', store.get('ws').status.length === POLICY.MAX_STATUS_PILLS)
    // 오래된 것부터 밀려난다 — 방금 쓴 것이 사라지면 쓴 보람이 없다
    check('최신이 남는다', store.get('ws').status.at(-1)?.name === `p${POLICY.MAX_STATUS_PILLS + 2}`)
  }

  // ── P25-2: 진행률
  {
    const store = new WorkspaceMetaStore(() => {})
    store.setProgress('ws', 0.5, '절반')
    check('진행률', store.get('ws').progress?.value === 0.5)
    check('설명도 함께', store.get('ws').progress?.text === '절반')

    // 범위를 벗어난 값은 잘라 넣는다 — 200%짜리 막대는 화면을 뚫는다
    store.setProgress('ws', 5)
    check('1을 넘지 않는다', store.get('ws').progress?.value === 1)
    store.setProgress('ws', -2)
    check('0 아래로 가지 않는다', store.get('ws').progress?.value === 0)

    // 끝을 모르는 채 돌고 있을 때
    store.setProgress('ws', null, '스캔 중')
    check('값 없이도 된다', store.get('ws').progress?.value === null)

    store.clearProgress('ws')
    check('지운다', store.get('ws').progress === null)
  }

  // ── P25-3: 로그
  {
    const store = new WorkspaceMetaStore(() => {})
    store.log('ws', '시작', 'info')
    store.log('ws', '실패', 'error')
    check('두 줄', store.get('ws').log.length === 2)
    check('수준이 실린다', store.get('ws').log[1].level === 'error')

    for (let i = 0; i < POLICY.MAX_WORKSPACE_LOG + 10; i++) store.log('ws', `줄 ${i}`)
    check('로그 상한', store.get('ws').log.length === POLICY.MAX_WORKSPACE_LOG)
    // 오래된 것부터 밀려난다 — 방금 일어난 일을 봐야 하므로
    check('최신이 남는다', store.get('ws').log.at(-1)?.text === `줄 ${POLICY.MAX_WORKSPACE_LOG + 9}`)

    store.clearLog('ws')
    check('비운다', store.get('ws').log.length === 0)
  }

  // ── P25-4: 체크리스트
  {
    const store = new WorkspaceMetaStore(() => {})
    const first = store.addTodo('ws', '테스트 통과시키기', 'pending', 'agent')
    store.addTodo('ws', '문서 고치기', 'pending', 'user')

    check('두 항목', store.get('ws').todo.length === 2)
    check('누가 만들었는지 남는다', first.origin === 'agent')

    // 1부터 세는 번호로도, id로도 집을 수 있다
    check('번호로 찾기', store.findTodo('ws', '2')?.text === '문서 고치기')
    check('id로 찾기', store.findTodo('ws', first.id)?.text === '테스트 통과시키기')
    check('없는 번호', store.findTodo('ws', '9') === null)

    check('상태 바꾸기', store.setTodoState('ws', '1', 'completed')?.state === 'completed')
    check('내용 고치기', store.editTodo('ws', '1', '전부 통과')?.text === '전부 통과')
    check('지우기', store.removeTodo('ws', '1') && store.get('ws').todo.length === 1)
    check('없는 것 지우기', !store.removeTodo('ws', '9'))

    // 너무 긴 한 줄은 사이드바를 밀어낸다
    const long = store.addTodo('ws', 'x'.repeat(POLICY.MAX_TODO_TEXT + 50), 'pending', 'user')
    check('긴 줄은 잘린다', long.text.length === POLICY.MAX_TODO_TEXT)
  }

  /*
   * ── P25-5: 통째로 갈아 끼우기
   *
   * 여기가 이 테스트의 핵심이다. 감시 루프가 매 틱마다 전체 목록을 다시
   * 보내도 체크박스의 정체가 유지되어야 한다 — id가 바뀌면 화면이 매번
   * 깜빡이고, 사용자가 방금 체크한 것이 되돌아간다.
   */
  {
    const store = new WorkspaceMetaStore(() => {})
    const a = store.addTodo('ws', 'lint', 'pending', 'user')
    const b = store.addTodo('ws', 'test', 'pending', 'agent')

    const next = store.replaceTodo('ws', [
      { id: a.id, text: 'lint', state: 'completed' },
      { id: b.id, text: 'test', state: 'in-progress' },
      { text: 'build' }
    ])

    check('세 항목', next.length === 3)
    check('id가 유지된다', next[0].id === a.id && next[1].id === b.id)
    check('상태가 갱신된다', next[0].state === 'completed' && next[1].state === 'in-progress')
    check('새 항목에는 새 id', next[2].id !== a.id && next[2].id !== b.id)
    // 원래 누가 만든 것인지는 바뀌지 않는다
    check('origin은 지켜진다', next[1].origin === 'agent')
    check('새 항목의 기본 origin', next[2].origin === 'user')

    // 이름이 빠진 항목은 사라진다
    const shrunk = store.replaceTodo('ws', [{ id: a.id, text: 'lint' }])
    check('빠진 것은 사라진다', shrunk.length === 1)
  }

  /*
   * 하나라도 잘못되면 아무것도 바꾸지 않는다.
   *
   * 반쯤 적용된 체크리스트가 가장 나쁘다 — 스크립트는 성공한 줄 알고 넘어가고,
   * 화면에는 앞부분만 들어와 있다.
   */
  {
    const store = new WorkspaceMetaStore(() => {})
    store.addTodo('ws', '남아 있어야 함', 'pending', 'user')

    let threw = false
    try {
      store.replaceTodo('ws', [{ text: '괜찮음' }, { text: '   ' }])
    } catch {
      threw = true
    }
    check('빈 항목이 있으면 거부', threw)
    check('원본은 그대로', store.get('ws').todo.length === 1)
    check('원본 내용도 그대로', store.get('ws').todo[0].text === '남아 있어야 함')

    let capThrew = false
    try {
      store.replaceTodo(
        'ws',
        Array.from({ length: POLICY.MAX_TODO_ITEMS + 1 }, (_, i) => ({ text: `t${i}` }))
      )
    } catch {
      capThrew = true
    }
    check('상한을 넘으면 거부', capThrew)
    check('그래도 원본은 그대로', store.get('ws').todo.length === 1)
  }

  /*
   * ── P25-6: 세션 → 워크스페이스
   *
   * 세션 안의 에이전트는 자기 워크스페이스 id를 모른다. 이걸 되짚지 못하면
   * `cvmux log`가 어느 줄에 쓸지 알 수 없다.
   */
  {
    const layout: Workspace[] = [
      {
        id: 'ws-a',
        title: null,
        root: { kind: 'leaf', id: 'p1', surfaces: ['s1'], active: 0 },
        focusedPaneId: 'p1'
      },
      {
        id: 'ws-b',
        title: null,
        root: {
          kind: 'split',
          id: 'sp',
          direction: 'row',
          sizes: [0.5, 0.5],
          children: [
            { kind: 'leaf', id: 'p2', surfaces: ['s2'], active: 0 },
            // 숨은 탭 — 보이지 않아도 그 워크스페이스의 세션이다
            { kind: 'leaf', id: 'p3', surfaces: ['s3', 's4'], active: 0 }
          ]
        },
        focusedPaneId: 'p2'
      }
    ]

    check('첫 워크스페이스', workspaceOfSession(layout, 's1')?.id === 'ws-a')
    check('분할 안쪽', workspaceOfSession(layout, 's2')?.id === 'ws-b')
    check('숨은 탭도 찾는다', workspaceOfSession(layout, 's4')?.id === 'ws-b')
    check('없는 세션', workspaceOfSession(layout, 'nope') === null)
  }

  // 워크스페이스가 사라지면 메타데이터도 치운다
  {
    const store = new WorkspaceMetaStore(() => {})
    store.setStatus('ws-a', 'x', '1')
    store.setStatus('ws-b', 'x', '2')
    store.prune(['ws-a'])
    check('살아 있는 것만 남는다', store.get('ws-a').status.length === 1)
    check('사라진 것은 비었다', store.get('ws-b').status.length === 0)
  }

  console.log(results.join('\n'))
  console.log(`\n${results.length - failed}/${results.length} passed`)
  process.exit(failed === 0 ? 0 : 1)
}

main()

/*
 * 제어 소켓 프로토콜(POLICY.md P20)의 회귀 테스트.
 *
 * 여기서 지키는 것은 두 가지다.
 *
 * 1. **핸들 해석** — `workspace:2`, UUID, 줄여 쓴 id, 순번이 모두 같은 자리로
 *    간다. 스크립트가 `list-workspaces`가 찍어 준 `ref`를 다음 명령에 그대로
 *    되쓰는데, 그 왕복이 어긋나면 엉뚱한 워크스페이스를 닫는다.
 * 2. **키 이름** — `send-key Enter`가 실제로 CR을 보내야 한다. 이름을 잘못
 *    옮기면 에이전트가 "엔터를 눌렀는데 아무 일도 없다"를 보게 된다.
 *
 * 실행: npm test
 */
import { resolveHandle } from '../src/shared/protocol'
import { keySequence } from '../src/main/control-socket'

const results: string[] = []
let failed = 0

function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failed++
  results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `  ← ${detail}` : ''}`)
}

function main(): void {
  const items = [{ id: 'ws-alpha-1' }, { id: 'ws-beta-2' }, { id: 'ws-gamma-3' }]

  // ── P20-4: 참조 표기
  check('workspace:2는 두 번째', resolveHandle(items, 'workspace:2', 'workspace')?.id === 'ws-beta-2')
  check('맨 숫자도 순번', resolveHandle(items, '3', 'workspace')?.id === 'ws-gamma-3')
  check('1부터 센다', resolveHandle(items, 'workspace:1', 'workspace')?.id === 'ws-alpha-1')
  check('범위를 벗어나면 null', resolveHandle(items, 'workspace:9', 'workspace') === null)
  check('0번은 없다', resolveHandle(items, '0', 'workspace') === null)

  // id로 가리키기
  check('전체 id', resolveHandle(items, 'ws-beta-2', 'workspace')?.id === 'ws-beta-2')
  check('줄여 쓴 id', resolveHandle(items, 'ws-be', 'workspace')?.id === 'ws-beta-2')

  /*
   * 여러 개에 걸리는 접두는 가리킨 것이 없는 것과 같다.
   *
   * 하나를 골라 주면 스크립트는 조용히 엉뚱한 대상을 조작한다. 애매하면
   * 실패하는 편이 낫다 — 이 앱에서 "닫기"는 되돌릴 수 없다(P1-1).
   */
  check('애매한 접두는 거부', resolveHandle(items, 'ws-', 'workspace') === null)

  check('빈 값은 null', resolveHandle(items, '', 'workspace') === null)
  check('없는 값은 null', resolveHandle(items, undefined, 'workspace') === null)

  // 다른 종류의 접두어가 붙어 있으면 id로 본다 — 그런 id는 없으므로 null
  check('종류가 다르면 못 찾는다', resolveHandle(items, 'pane:2', 'workspace') === null)

  // ── P20-5: 키 이름
  check('Enter는 CR', keySequence('Enter') === '\r')
  check('Tab', keySequence('Tab') === '\t')
  check('Escape', keySequence('Escape') === '\x1b')
  check('Backspace는 DEL', keySequence('Backspace') === '\x7f')
  check('ArrowUp', keySequence('ArrowUp') === '\x1b[A')
  check('Up도 같은 것', keySequence('Up') === keySequence('ArrowUp'))
  check('Space는 공백', keySequence('Space') === ' ')

  // Ctrl 조합 — 세 가지 표기를 모두 받는다
  check('Ctrl+C', keySequence('Ctrl+C') === '\x03')
  check('C-c 표기', keySequence('C-c') === '\x03')
  check('^C 표기', keySequence('^C') === '\x03')
  check('Ctrl+D', keySequence('Ctrl+D') === '\x04')

  // 기능키
  check('F1', keySequence('F1') === '\x1bOP')
  check('F5', keySequence('F5') === '\x1b[15~')
  check('F12', keySequence('F12') === '\x1b[24~')
  check('F13은 없다', keySequence('F13') === null)

  // 한 글자는 그대로, 모르는 이름은 거부
  check('한 글자는 그대로', keySequence('a') === 'a')
  check('한글 한 글자도 그대로', keySequence('가') === '가')
  check('모르는 이름은 null', keySequence('Frobnicate') === null)

  console.log(results.join('\n'))
  console.log(`\n${results.length - failed}/${results.length} passed`)
  process.exit(failed === 0 ? 0 : 1)
}

main()

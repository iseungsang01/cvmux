/*
 * 명령 팔레트 검색(POLICY.md P21-6)의 회귀 테스트.
 *
 * 팔레트가 지켜야 하는 것은 두 가지다.
 *
 * 1. **영타로 한글 명령을 찾을 수 있다.** 명령 이름은 한글인데 손은 영문
 *    자판에 있는 순간이 흔하다. `split`을 쳐서 "오른쪽으로 분할"이 나오지
 *    않으면 팔레트를 쓸 이유가 없다.
 * 2. **순서가 흔들리지 않는다.** 같은 점수의 항목이 검색할 때마다 자리를
 *    바꾸면, 눈으로 겨냥하고 엔터를 치는 동작이 도박이 된다.
 *
 * 실행: npm test
 */
import { filterCommands, type Command } from '../src/renderer/lib/palette'

const results: string[] = []
let failed = 0

function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failed++
  results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `  ← ${detail}` : ''}`)
}

function cmd(id: string, title: string, keywords?: string, enabled?: boolean): Command {
  return { id, title, keywords, section: '테스트', enabled, run: () => {} }
}

function main(): void {
  const commands: Command[] = [
    cmd('new', '새 세션', 'new workspace session create'),
    cmd('split.right', '오른쪽으로 분할', 'split right vertical pane'),
    cmd('split.down', '아래로 분할', 'split down horizontal pane'),
    cmd('close', '이 pane 닫기', 'close pane kill'),
    cmd('find', '이 화면에서 찾기', 'find search buffer'),
    cmd('find.all', '모든 세션에서 찾기', 'find search all sessions'),
    cmd('disabled', '쓸 수 없는 명령', 'disabled', false)
  ]

  const ids = (query: string): string[] =>
    filterCommands(commands, query).map((m) => m.command.id)

  // ── 빈 질의는 전부 (쓸 수 없는 것만 뺀다)
  {
    const all = ids('')
    check('빈 질의는 전체 목록', all.length === 6, String(all.length))
    check('쓸 수 없는 명령은 빠진다', !all.includes('disabled'))
  }

  // ── 한글 제목으로 찾기
  {
    check('한글 부분 일치', ids('분할').includes('split.right'))
    check('띄어 쓴 질의도 같다', ids('아래 분할').includes('split.down'), ids('아래 분할').join(','))
  }

  /*
   * 영문 키워드로 찾기.
   *
   * 이것이 이 테스트의 이유다 — 제목이 한글뿐이면 영문 자판에 있는 손은
   * 팔레트에 닿지 못한다.
   */
  {
    const split = ids('split')
    check('영타로 한글 명령을 찾는다', split.includes('split.right') && split.includes('split.down'), split.join(','))
    check('search로 찾기 명령', ids('search').includes('find'))
    check('kill로 닫기', ids('kill').includes('close'))
  }

  // ── 맞는 것이 없으면 빈 목록
  check('없는 질의는 빈 목록', ids('zzzzz').length === 0)

  // ── 제목에서 맞은 것이 키워드로 맞은 것보다 위
  {
    // 'pane'은 '이 pane 닫기'의 제목에 있고 분할 명령들의 키워드에 있다
    const order = ids('pane')
    check('제목 일치가 먼저', order[0] === 'close', order.join(','))
  }

  // ── 이어 붙은 글자가 흩어진 글자보다 위
  {
    const ranked = filterCommands(
      [cmd('a', 'axbxcx'), cmd('b', 'xxabc')],
      'abc'
    ).map((m) => m.command.id)
    check('이어진 일치가 먼저', ranked[0] === 'b', ranked.join(','))
  }

  /*
   * 같은 점수면 원래 순서를 지킨다.
   *
   * 검색할 때마다 자리가 바뀌면 눈으로 겨냥하고 엔터를 치는 동작이 도박이 된다.
   */
  {
    const same = [cmd('first', 'zzz alpha'), cmd('second', 'zzz beta')]
    const once = filterCommands(same, 'zzz').map((m) => m.command.id)
    const twice = filterCommands(same, 'zzz').map((m) => m.command.id)
    check('결과 순서가 안정적', once.join(',') === twice.join(',') && once[0] === 'first')
  }

  // ── 하이라이트 자리
  {
    const [match] = filterCommands([cmd('x', 'abcdef')], 'ace')
    check('맞은 자리를 알려준다', match.hits.join(',') === '0,2,4', match.hits.join(','))
  }

  // ── 대소문자를 가리지 않는다
  check('대문자 질의', ids('SPLIT').includes('split.right'))

  console.log(results.join('\n'))
  console.log(`\n${results.length - failed}/${results.length} passed`)
  process.exit(failed === 0 ? 0 : 1)
}

main()

/*
 * 내장 브라우저(POLICY.md P23)의 회귀 테스트.
 *
 * 여기서 지키는 것은 두 가지다.
 *
 * 1. **주소창 해석** — `localhost:5173`은 주소이고 `버그 재현 방법`은 검색어다.
 *    이걸 뒤집으면 개발 서버를 열려던 사람이 구글 검색 결과를 보게 된다.
 * 2. **조작 코드의 값 심기** — 페이지는 신뢰 경계 밖이다(P23-6). 선택자나
 *    입력값에 따옴표가 섞여도 스크립트가 깨지거나, 더 나쁘게는 남의 코드가
 *    실행되어서는 안 된다.
 *
 * 실행: npm test
 */
import { normalizeUrl } from '../src/shared/url'
import { clickScript, fillScript, getScript, unwrapError } from '../src/main/browser-agent'

const results: string[] = []
let failed = 0

function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failed++
  results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `  ← ${detail}` : ''}`)
}

function main(): void {
  // ── P23-1: 주소인가 검색어인가
  check('스킴이 있으면 그대로', normalizeUrl('https://example.com') === 'https://example.com')
  check('about:blank', normalizeUrl('about:blank') === 'about:blank')
  check('file 스킴', normalizeUrl('file:///C:/x.html') === 'file:///C:/x.html')

  check('localhost는 http', normalizeUrl('localhost:5173') === 'http://localhost:5173')
  check('포트 없는 localhost', normalizeUrl('localhost') === 'http://localhost')
  check('localhost 경로', normalizeUrl('localhost:3000/api') === 'http://localhost:3000/api')
  check('IP 주소', normalizeUrl('127.0.0.1:8080') === 'http://127.0.0.1:8080')

  check('점이 있으면 주소', normalizeUrl('example.com') === 'https://example.com')
  check('점 + 경로', normalizeUrl('example.com/docs') === 'https://example.com/docs')

  /*
   * 점도 콜론도 없으면 검색어다.
   *
   * 한글 문장을 주소로 보면 "찾을 수 없음"만 뜬다. 사람이 주소창에 문장을
   * 쳤다면 찾아 달라는 뜻이다.
   */
  {
    const searched = normalizeUrl('버그 재현 방법')
    check('한글 문장은 검색', searched.startsWith('https://www.google.com/search?q='), searched)
    check('검색어는 인코딩된다', !searched.includes(' '))
  }
  check('공백만 있으면 빈 페이지', normalizeUrl('   ') === 'about:blank')

  /*
   * ── P23-6: 값은 코드가 아니라 값으로 들어간다
   *
   * 따옴표가 섞인 입력이 스크립트를 깨뜨리거나 코드로 실행되면 안 된다.
   */
  {
    // 스크립트를 감싸는 것은 큰따옴표다 — 값 안의 큰따옴표가 반드시 이스케이프돼야 한다
    const nasty = `"); alert("xss"); ("`
    const script = fillScript(nasty, undefined, '#name')
    check('입력값은 JSON으로 감싼다', script.includes(JSON.stringify(nasty)))
    check('큰따옴표가 이스케이프된다', script.includes('\\"'))
    check('따옴표를 벗어난 원문이 없다', !script.includes(`); alert("xss"); (`))

    const selectorScript = clickScript(undefined, `a[href="x"]`)
    check('선택자도 감싼다', selectorScript.includes(JSON.stringify(`a[href="x"]`)))

    // 줄바꿈이 섞이면 스크립트가 통째로 깨질 수 있다
    const multiline = fillScript('첫 줄\n둘째 줄', undefined, '#name')
    check('줄바꿈도 안전하다', multiline.includes('\\n') && !multiline.includes('첫 줄\n둘째'))
  }

  // 조작 스크립트는 ref와 선택자를 모두 받는다
  {
    const byRef = clickScript('e12', undefined)
    check('ref가 실린다', byRef.includes('"e12"'))
    check('선택자 자리는 null', byRef.includes('const selector = null'))

    const bySelector = clickScript(undefined, '#go')
    check('선택자가 실린다', bySelector.includes('"#go"'))
    check('ref 자리는 null', bySelector.includes('const ref = null'))
  }

  // 읽을 수 있는 것은 고정된 목록이다 — 페이지가 정하지 못한다
  {
    const script = getScript('title', undefined, undefined)
    check('what이 실린다', script.includes('"title"'))
    check('허용 목록이 코드 안에 있다', script.includes("what === 'url'"))
  }

  /*
   * ── P23-7: 던진 오류가 값으로 살아 돌아온다
   *
   * executeJavaScript는 스크립트가 던지면 우리 메시지를 버린다. 감싸지 않으면
   * 에이전트에게 "스냅샷을 다시 뜨라"고 말해 줄 수 없다.
   */
  {
    check('감싼 오류를 알아본다', unwrapError({ __cvmuxError: '그 요소가 없습니다' }) === '그 요소가 없습니다')
    check('평범한 값은 오류가 아니다', unwrapError({ clicked: true }) === null)
    check('null도 오류가 아니다', unwrapError(null) === null)
    check('문자열도 오류가 아니다', unwrapError('ok') === null)
    check('조작 스크립트는 감싸져 있다', clickScript('e1', undefined).includes('__cvmuxError'))
  }

  console.log(results.join('\n'))
  console.log(`\n${results.length - failed}/${results.length} passed`)
  process.exit(failed === 0 ? 0 : 1)
}

main()

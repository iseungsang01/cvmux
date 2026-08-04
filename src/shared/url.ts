/**
 * 사람이 주소창에 치는 것을 URL로 (POLICY.md P23-1).
 *
 * `localhost:5173`은 스킴이 없지만 주소다. 반면 `버그 재현 방법`은 검색어다.
 * 이걸 뒤집으면 개발 서버를 열려던 사람이 검색 결과를 보게 된다.
 *
 * 판단 기준은 하나다 — **점이나 콜론이 있으면 주소로 본다.** 완벽하지는 않지만
 * (`node.js`는 검색하고 싶을 수 있다) 터미널 옆에 두는 브라우저에서 실제로
 * 치는 것은 대부분 localhost 주소다.
 */
export function normalizeUrl(input: string): string {
  const text = input.trim()
  if (text === '') return 'about:blank'

  /*
   * 호스트:포트를 스킴으로 오해하지 않는다.
   *
   * `localhost:5173`은 스킴 문법과 구별되지 않는다 — `localhost`가 스킴 이름의
   * 모양을 하고 있기 때문이다. 콜론 뒤가 숫자뿐이면 포트로 본다. 이걸 아래
   * 스킴 검사보다 먼저 두지 않으면 개발 서버 주소가 통째로 그대로 나가고,
   * 브라우저는 `localhost:` 스킴을 모른다고 답한다.
   */
  if (/^[a-z][a-z0-9+.-]*:\d+(\/|$|\?)/i.test(text)) return `http://${text}`
  // IP는 숫자로 시작해 위 규칙에 걸리지 않는다. 포트가 붙어도 마찬가지다
  if (/^\d{1,3}(\.\d{1,3}){3}(:\d+)?(\/|$|\?)/.test(text)) return `http://${text}`

  if (/^[a-z][a-z0-9+.-]*:/i.test(text)) return text
  if (/^localhost(\/|$|\?)/i.test(text)) return `http://${text}`
  if (/^[^\s/]+\.[^\s/]+/.test(text)) return `https://${text}`
  return `https://www.google.com/search?q=${encodeURIComponent(text)}`
}

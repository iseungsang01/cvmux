import { POLICY } from '@shared/policy'

/**
 * 명령 팔레트의 검색 (POLICY.md P21-6).
 *
 * 앱이 할 수 있는 일이 늘어날수록 단축키만으로는 닿지 않는 것이 생긴다.
 * 팔레트는 **외우지 않아도 되는 입구**다 — 이름의 일부만 기억하면 된다.
 *
 * 한글 제목만으로는 영타로 찾을 수 없으므로 명령마다 영문 키워드를 함께 단다.
 * `split`을 쳐서 "오른쪽으로 분할"이 나오지 않으면 팔레트를 쓸 이유가 없다.
 */

export interface Command {
  id: string
  title: string
  /** 영문 키워드. 검색에만 쓰이고 화면에는 나오지 않는다 */
  keywords?: string
  /** 단축키 안내 — 팔레트는 단축키를 가르치는 자리이기도 하다 */
  hint?: string
  section: string
  /** 지금 이 명령을 쓸 수 있는가. 쓸 수 없으면 목록에서 뺀다 */
  enabled?: boolean
  run(): void
}

export interface PaletteMatch {
  command: Command
  score: number
  /** 제목에서 글자가 맞은 자리. 하이라이트에 쓴다 */
  hits: number[]
}

/**
 * 부분 수열 검색.
 *
 * 질의의 글자가 순서대로 나타나면 맞은 것으로 본다. 정확히는 두 번 본다 —
 * 제목에서 먼저 찾고, 못 찾으면 키워드까지 붙여 찾는다. 제목에서 맞은 쪽이
 * 항상 위로 온다.
 */
export function filterCommands(commands: Command[], query: string): PaletteMatch[] {
  const available = commands.filter((c) => c.enabled !== false)
  const trimmed = query.trim().toLowerCase()

  if (trimmed === '') {
    return available.slice(0, POLICY.PALETTE_MAX_RESULTS).map((command) => ({
      command,
      score: 0,
      hits: []
    }))
  }

  const matches: PaletteMatch[] = []
  for (const command of available) {
    const title = command.title.toLowerCase()
    const inTitle = match(title, trimmed)
    if (inTitle) {
      matches.push({ command, score: inTitle.score + 1000, hits: inTitle.hits })
      continue
    }
    const keywords = (command.keywords ?? '').toLowerCase()
    if (keywords && match(keywords, trimmed)) {
      matches.push({ command, score: 0, hits: [] })
    }
  }

  // 점수가 같으면 원래 순서를 지킨다 — 목록이 검색할 때마다 뒤바뀌면 안 된다
  return matches
    .map((m, i) => ({ m, i }))
    .sort((a, b) => b.m.score - a.m.score || a.i - b.i)
    .slice(0, POLICY.PALETTE_MAX_RESULTS)
    .map(({ m }) => m)
}

function match(haystack: string, needle: string): { score: number; hits: number[] } | null {
  const hits: number[] = []
  let score = 0
  let at = 0

  for (const char of needle) {
    // 공백은 건너뛴다 — "새 세션"과 "새세션"이 같은 것을 찾아야 한다
    if (char === ' ') continue

    const found = haystack.indexOf(char, at)
    if (found === -1) return null

    // 이어 붙은 글자는 흩어진 글자보다 훨씬 낫다
    if (hits.length > 0 && found === hits[hits.length - 1] + 1) score += 8
    // 단어 첫 글자에 맞으면 이름을 알고 친 것이다
    if (found === 0 || haystack[found - 1] === ' ' || haystack[found - 1] === '/') score += 5
    // 앞쪽일수록 좋다
    score += Math.max(0, 4 - Math.floor(found / 4))

    hits.push(found)
    at = found + 1
  }

  return { score, hits }
}

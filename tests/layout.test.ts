/*
 * pane 트리 조작(POLICY.md P17)의 회귀 테스트.
 *
 * 분할·닫기는 순수 함수라 UI 없이 검증할 수 있다. 트리가 깊어지거나
 * 껍데기 split이 남는 것은 눈으로 보기 전에 여기서 걸린다.
 *
 * 실행: npm test
 */
import { M } from '../src/shared/protocol'
import type { PaneNode, SessionMeta, Workspace } from '../src/shared/types'
import { ControlRequestError, handleControl, type ControlContext } from '../src/renderer/lib/control'
import {
  addSurface,
  closePane,
  closeSurface,
  collectAllSurfaces,
  collectSessionIds,
  createLeaf,
  cycleSurface,
  equalizeSplits,
  extractPane,
  findLeafBySession,
  firstLeafId,
  leafRects,
  moveSurface,
  neighborPane,
  paneCount,
  resizeSplit,
  resizeToward,
  selectSurface,
  splitPane
} from '../src/renderer/lib/layout'
import { inputTargets, reorder } from '../src/renderer/lib/workspace'

const results: string[] = []
let failed = 0

function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failed++
  results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `  ← ${detail}` : ''}`)
}

/**
 * 트리 모양을 문자열로 — 비교하기 쉽게.
 *
 * 잎에 탭이 여럿이면 `[a|b]`로 적고, 활성 탭에 `*`를 붙인다.
 */
function shape(node: PaneNode): string {
  if (node.kind === 'leaf') {
    if (node.surfaces.length === 1) return node.surfaces[0]
    return `[${node.surfaces.map((s, i) => (i === node.active ? `*${s}` : s)).join('|')}]`
  }
  return `${node.direction === 'row' ? 'H' : 'V'}(${node.children.map(shape).join(' ')})`
}

function depth(node: PaneNode): number {
  return node.kind === 'leaf' ? 1 : 1 + Math.max(...node.children.map(depth))
}

async function main(): Promise<void> {
  // ── P17-1: 잎 하나를 나누면 split이 된다
  {
    const root = createLeaf('s1')
    const result = splitPane(root, root.id, 'row', 's2')
    check('P17-1 잎 분할 → split 생성', result !== null && shape(result.root) === 'H(s1 s2)', result ? shape(result.root) : 'null')
    check('P17-1 새 pane id 반환', result !== null && result.newPaneId !== root.id)
  }

  // ── P17-1: 같은 방향으로 또 나누면 형제로 붙는다 (트리가 깊어지지 않는다)
  {
    const root = createLeaf('s1')
    const a = splitPane(root, root.id, 'row', 's2')
    if (!a) {
      check('P17-1 같은 방향 재분할', false, '1차 분할 실패')
    } else {
      const target = a.newPaneId
      const b = splitPane(a.root, target, 'row', 's3')
      check(
        'P17-1 같은 방향 재분할 → 형제로 추가',
        b !== null && shape(b.root) === 'H(s1 s2 s3)',
        b ? shape(b.root) : 'null'
      )
      check('P17-1 트리 깊이 유지 (2단)', b !== null && depth(b.root) === 2, b ? String(depth(b.root)) : '-')
      // 형제로 붙을 때 대상의 몫을 반으로 쪼갠다
      if (b && b.root.kind === 'split') {
        const sum = b.root.sizes.reduce((x, y) => x + y, 0)
        check('P17-1 비율 합 = 1', Math.abs(sum - 1) < 1e-9, String(sum))
      }
    }
  }

  // ── P17-1: 다른 방향으로 나누면 그 자리에 중첩 split이 생긴다
  {
    const root = createLeaf('s1')
    const a = splitPane(root, root.id, 'row', 's2')
    if (!a) {
      check('P17-1 다른 방향 분할', false, '1차 분할 실패')
    } else {
      const b = splitPane(a.root, a.newPaneId, 'column', 's3')
      check(
        'P17-1 다른 방향 분할 → 중첩',
        b !== null && shape(b.root) === 'H(s1 V(s2 s3))',
        b ? shape(b.root) : 'null'
      )
    }
  }

  // ── P17-4: 자식이 하나 남은 split은 평탄화된다
  {
    const root = createLeaf('s1')
    const a = splitPane(root, root.id, 'row', 's2')
    if (!a) {
      check('P17-4 평탄화', false, '분할 실패')
    } else {
      const next = closePane(a.root, a.newPaneId)
      check(
        'P17-4 자식 하나 남은 split 평탄화',
        next !== null && next.kind === 'leaf' && shape(next) === 's1',
        next ? shape(next) : 'null'
      )
    }
  }

  // ── P17-4: 3분할에서 하나 닫으면 split은 유지되고 비율이 재정규화된다
  {
    let root: PaneNode = createLeaf('s1')
    const a = splitPane(root, root.id, 'row', 's2')
    const b = a ? splitPane(a.root, a.newPaneId, 'row', 's3') : null
    if (!b) {
      check('P17-4 3분할 축소', false, '분할 실패')
    } else {
      root = b.root
      const leafS2 = root.kind === 'split' ? root.children[1] : null
      const next = leafS2 ? closePane(root, leafS2.id) : null
      check(
        'P17-4 3분할 중 하나 닫기',
        next !== null && shape(next) === 'H(s1 s3)',
        next ? shape(next) : 'null'
      )
      if (next && next.kind === 'split') {
        const sum = next.sizes.reduce((x, y) => x + y, 0)
        check('P17-4 닫은 뒤 비율 재정규화', Math.abs(sum - 1) < 1e-9, String(sum))
      }
    }
  }

  // ── P17-3: 마지막 잎을 닫으면 워크스페이스가 끝난다
  {
    const root = createLeaf('s1')
    const next = closePane(root, root.id)
    check('P17-3 마지막 pane 닫기 → null', next === null, String(next))
  }

  // ── P17-5: 비율 조정은 인접한 두 칸 사이에서만 오간다
  {
    const root = createLeaf('s1')
    const a = splitPane(root, root.id, 'row', 's2')
    if (!a || a.root.kind !== 'split') {
      check('P17-5 리사이즈', false, '분할 실패')
    } else {
      const resized = resizeSplit(a.root, a.root.id, 0, 0.2)
      if (resized.kind !== 'split') {
        check('P17-5 리사이즈 결과가 split', false)
      } else {
        check('P17-5 비율 이동', Math.abs(resized.sizes[0] - 0.7) < 1e-9, String(resized.sizes[0]))
        check(
          'P17-5 합 보존',
          Math.abs(resized.sizes[0] + resized.sizes[1] - 1) < 1e-9,
          String(resized.sizes[0] + resized.sizes[1])
        )
      }
      // 한쪽을 0으로 밀어도 최소 몫이 남는다
      const extreme = resizeSplit(a.root, a.root.id, 0, -10)
      if (extreme.kind === 'split') {
        check('P17-5 최소 몫 보장', extreme.sizes[0] >= 0.05, String(extreme.sizes[0]))
      }
    }
  }

  // ── 순회 유틸
  {
    const root = createLeaf('s1')
    const a = splitPane(root, root.id, 'row', 's2')
    const b = a ? splitPane(a.root, a.newPaneId, 'column', 's3') : null
    if (!b) {
      check('순회 유틸', false, '분할 실패')
    } else {
      check('collectSessionIds', collectSessionIds(b.root).join(',') === 's1,s2,s3', collectSessionIds(b.root).join(','))
      check('paneCount', paneCount(b.root) === 3, String(paneCount(b.root)))
      check('firstLeafId는 첫 잎', firstLeafId(b.root) !== '')
    }
  }

  // ── 없는 pane을 나누려 하면 아무 일도 없다
  {
    const root = createLeaf('s1')
    const result = splitPane(root, 'no-such-pane', 'row', 's2')
    check('없는 pane 분할 → null', result === null, String(result))
    const closed = closePane(root, 'no-such-pane')
    check('없는 pane 닫기 → 원본 유지', closed !== null && shape(closed) === 's1', closed ? shape(closed) : 'null')
  }

  /*
   * ── P19-8: 사이드바 줄 순서 바꾸기
   *
   * 배열 위치가 곧 화면의 자리이자 Ctrl+Alt+숫자의 번호다. 드래그가 목록 밖에서
   * 끝나거나 그 사이 세션이 닫히면 범위를 벗어난 자리가 들어올 수 있는데,
   * 그때 순서가 흐트러지면 안 된다.
   */
  {
    const list = ['a', 'b', 'c', 'd']

    check('P19-8 아래로 이동', reorder(list, 0, 2).join('') === 'bcad', reorder(list, 0, 2).join(''))
    check('P19-8 위로 이동', reorder(list, 3, 1).join('') === 'adbc', reorder(list, 3, 1).join(''))
    check(
      'P19-8 맨 끝으로 이동',
      reorder(list, 0, 3).join('') === 'bcda',
      reorder(list, 0, 3).join('')
    )
    check('P19-8 제자리는 원본 그대로', reorder(list, 1, 1) === list)
    check('P19-8 원본을 건드리지 않는다', list.join('') === 'abcd', list.join(''))

    // 범위를 벗어난 자리는 아무 일도 일으키지 않는다
    check('P19-8 범위 밖 출발', reorder(list, -1, 2) === list)
    check('P19-8 범위 밖 도착', reorder(list, 0, 9) === list)
    check('P19-8 빈 목록', reorder([], 0, 1).length === 0)
  }

  // ── P24-1: pane 안의 가로 탭
  {
    const root = createLeaf('s1')
    const one = addSurface(root, root.id, 's2')
    check('P24-1 탭 추가', one !== null && shape(one) === '[s1|*s2]', one ? shape(one) : 'null')

    /*
     * 새 탭은 지금 탭의 바로 오른쪽에 들어간다.
     *
     * 맨 끝에 붙이면 탭이 많을 때 방금 연 것이 화면 밖에 생긴다.
     */
    const two = one ? addSurface(one, root.id, 's3') : null
    check('P24-1 현재 탭 오른쪽에 낀다', two !== null && shape(two) === '[s1|s2|*s3]', two ? shape(two) : 'null')

    const back = two ? selectSurface(two, root.id, 0) : null
    const middle = back ? addSurface(back, root.id, 's4') : null
    check(
      'P24-1 앞으로 돌아가 열면 그 옆',
      middle !== null && shape(middle) === '[s1|*s4|s2|s3]',
      middle ? shape(middle) : 'null'
    )
  }

  // ── P24-2: 탭 닫기
  {
    const start = createLeaf('a')
    const withB = addSurface(start, start.id, 'b')
    const withC = withB ? addSurface(withB, start.id, 'c') : null
    check('세 탭 준비', withC !== null && shape(withC) === '[a|b|*c]', withC ? shape(withC) : 'null')

    /*
     * 활성 탭을 닫으면 왼쪽으로 간다.
     *
     * 오른쪽으로 가면 연달아 닫을 때 커서가 목록 끝까지 밀려가고, 방금 보던
     * 자리에서 점점 멀어진다.
     */
    const afterActive = withC ? closeSurface(withC, 'c') : null
    check(
      'P24-2 활성 탭을 닫으면 왼쪽으로',
      afterActive !== null && shape(afterActive) === '[a|*b]',
      afterActive ? shape(afterActive) : 'null'
    )

    // 왼쪽 탭을 닫아도 보고 있던 것은 그대로 보인다
    const afterLeft = afterActive ? closeSurface(afterActive, 'a') : null
    check(
      'P24-2 왼쪽을 닫아도 보던 탭 유지',
      afterLeft !== null && shape(afterLeft) === 'b',
      afterLeft ? shape(afterLeft) : 'null'
    )

    // 마지막 탭을 닫으면 pane이, 마지막 pane이면 워크스페이스가 사라진다
    check('P24-2 마지막 탭을 닫으면 null', afterLeft !== null && closeSurface(afterLeft, 'b') === null)
  }

  // 분할된 트리에서 탭 하나를 닫으면 그 pane만 사라진다
  {
    const root = createLeaf('s1')
    const split = splitPane(root, root.id, 'row', 's2')
    const withTab = split ? addSurface(split.root, split.newPaneId, 's3') : null
    check(
      '분할 + 탭',
      withTab !== null && shape(withTab) === 'H(s1 [s2|*s3])',
      withTab ? shape(withTab) : 'null'
    )

    const closed = withTab ? closeSurface(withTab, 's3') : null
    check(
      'P24-2 탭만 닫으면 pane은 남는다',
      closed !== null && shape(closed) === 'H(s1 s2)',
      closed ? shape(closed) : 'null'
    )

    const paneGone = closed ? closeSurface(closed, 's2') : null
    check(
      'P24-2 마지막 탭이면 pane이 사라진다',
      paneGone !== null && shape(paneGone) === 's1',
      paneGone ? shape(paneGone) : 'null'
    )
  }

  // ── P24-3: 탭 순환은 끝에서 돌아간다
  {
    const base = createLeaf('a')
    const paneId = base.id
    const withB = addSurface(base, paneId, 'b') ?? base
    const tree = selectSurface(addSurface(withB, paneId, 'c') ?? withB, paneId, 2)

    check('P24-3 다음은 처음으로 돌아간다', shape(cycleSurface(tree, paneId, 1)) === '[*a|b|c]')
    const first = selectSurface(tree, paneId, 0)
    check('P24-3 이전은 끝으로 돌아간다', shape(cycleSurface(first, paneId, -1)) === '[a|b|*c]')

    // 탭이 하나면 순환할 것이 없다
    const single = createLeaf('only')
    check('P24-3 탭 하나는 그대로', shape(cycleSurface(single, single.id, 1)) === 'only')
  }

  // ── P24-4: 숨은 탭도 세어야 한다
  {
    const base = createLeaf('a')
    const tree = addSurface(base, base.id, 'b') ?? base

    check('보이는 것만', collectSessionIds(tree).join(',') === 'b', collectSessionIds(tree).join(','))
    /*
     * 탭 뒤에 숨은 세션까지 세지 않으면 워크스페이스를 닫을 때 프로세스만 남는다.
     */
    check('P24-4 숨은 것까지', collectAllSurfaces(tree).join(',') === 'a,b', collectAllSurfaces(tree).join(','))
    check('P24-4 숨은 탭으로도 잎을 찾는다', findLeafBySession(tree, 'a') !== null)
  }

  // ── 탭 순서 바꾸기 (P24-3)
  {
    const base = createLeaf('a')
    const paneId = base.id
    const withB = addSurface(base, paneId, 'b') ?? base
    const tree = selectSurface(addSurface(withB, paneId, 'c') ?? withB, paneId, 0)

    const moved = moveSurface(tree, paneId, 0, 2)
    check('탭을 끝으로 옮긴다', shape(moved) === '[b|c|*a]', shape(moved))

    const other = moveSurface(selectSurface(tree, paneId, 1), paneId, 0, 2)
    check('다른 탭을 옮기면 자리만 보정', shape(other) === '[*b|c|a]', shape(other))
    check('범위 밖이면 그대로', shape(moveSurface(tree, paneId, 0, 9)) === shape(tree))
    check('제자리면 그대로', shape(moveSurface(tree, paneId, 1, 1)) === shape(tree))
  }

  // ── P30: 키보드로 pane 다루기
  {
    /*
     * 모양:  a | b
     *        --+
     *        c | b      → 왼쪽은 a 위·c 아래, 오른쪽은 b 하나
     */
    const a = createLeaf('a')
    const ab = splitPane(a, a.id, 'row', 'b')
    const abc = ab ? splitPane(ab.root, a.id, 'column', 'c') : null
    if (!ab || !abc) {
      check('P30 준비', false, '분할 실패')
    } else {
      const tree = abc.root
      const paneOf = (s: string): string => findLeafBySession(tree, s)!.id
      const pa = paneOf('a')
      const pb = paneOf('b')
      const pc = paneOf('c')

      const ra = leafRects(tree).get(pa)!
      check('P30-1 자리 계산', ra.x === 0 && ra.y === 0 && ra.w === 0.5 && ra.h === 0.5, JSON.stringify(ra))

      check('P30-1 오른쪽 이웃', neighborPane(tree, pa, 'right') === pb)
      check('P30-1 아래 이웃', neighborPane(tree, pa, 'down') === pc)
      check(
        'P30-1 그 방향에 없으면 null',
        neighborPane(tree, pa, 'left') === null && neighborPane(tree, pa, 'up') === null
      )
      check('P30-1 아래쪽 pane에서 오른쪽', neighborPane(tree, pc, 'right') === pb)
      check('P30-1 없는 pane', neighborPane(tree, 'nope', 'right') === null)
      // b에서 왼쪽으로 가면 a와 c가 둘 다 맞닿는다 — 한가운데(0.5)를 덮는 쪽은 c다
      check('P30-1 둘이 맞닿으면 가운데를 마주 보는 쪽', neighborPane(tree, pb, 'left') === pc)

      // 오른쪽 이웃이 있으면 오른쪽 경계를 밀어 a가 커진다
      const grown = resizeToward(tree, pa, 'right', 0.1)
      const grownLeft = grown.kind === 'split' ? grown.sizes[0] : -1
      check('P30-3 화살표 쪽 경계를 민다', Math.abs(grownLeft - 0.6) < 1e-9, String(grownLeft))

      // b는 오른쪽 끝이다 — 왼쪽 경계를 오른쪽으로 밀어 b가 작아진다
      const shrunk = resizeToward(tree, pb, 'right', 0.1)
      const shrunkRight = shrunk.kind === 'split' ? shrunk.sizes[1] : -1
      check(
        'P30-3 끝에 붙은 pane은 반대쪽 경계를 같은 방향으로',
        Math.abs(shrunkRight - 0.4) < 1e-9,
        String(shrunkRight)
      )

      // a의 아래 경계 — 안쪽(세로) 분할이 움직인다
      const taller = resizeToward(tree, pa, 'down', 0.1)
      const inner =
        taller.kind === 'split' && taller.children[0].kind === 'split' ? taller.children[0].sizes[0] : -1
      check('P30-3 세로 방향은 안쪽 분할', Math.abs(inner - 0.6) < 1e-9, String(inner))

      const single = createLeaf('x')
      check('P30-3 분할이 없으면 그대로', resizeToward(single, single.id, 'left') === single)

      const even = equalizeSplits(resizeToward(tree, pa, 'right', 0.2))
      const evenSizes = even.kind === 'split' ? even.sizes.join(',') : ''
      check('P30-5 고르게', evenSizes === '0.5,0.5', evenSizes)
      check('P30-5 모양은 그대로', shape(even) === shape(tree), shape(even))

      const taken = extractPane(tree, pb)
      check('P30-6 빼낸 잎', taken !== null && taken.leaf.surfaces.join(',') === 'b')
      check(
        'P30-6 남은 트리',
        taken !== null && taken.rest !== null && shape(taken.rest) === 'V(a c)',
        taken?.rest ? shape(taken.rest) : 'null'
      )
      const last = createLeaf('only')
      const lastTaken = extractPane(last, last.id)
      check('P30-6 마지막 잎이면 남은 트리 없음', lastTaken !== null && lastTaken.rest === null)
      check('P30-6 없는 pane', extractPane(tree, 'nope') === null)
    }
  }

  // ── P30-7: 동시 입력은 보이는 터미널에만, 키만
  {
    const a = createLeaf('a')
    const ab = splitPane(a, a.id, 'row', 'b')!
    // b pane에 탭 c를 더하고 b를 보이게 둔다 — c는 숨은 탭이다
    const bPane = findLeafBySession(ab.root, 'b')!.id
    const withTab = selectSurface(addSurface(ab.root, bPane, 'c')!, bPane, 0)
    const ws: Workspace = { id: 'w', title: null, root: withTab, focusedPaneId: a.id, syncInput: true }
    const meta = (id: string, status: SessionMeta['status'] = 'idle'): SessionMeta =>
      ({ id, status }) as SessionMeta
    const sessions = [meta('a'), meta('b'), meta('c')]

    check('P30-7 보이는 터미널 모두', inputTargets('a', 'ls\r', [ws], sessions).join(',') === 'a,b')
    check('P30-7 마우스는 친 곳만', inputTargets('a', '\x1b[<0;3;4M', [ws], sessions).join(',') === 'a')
    check(
      'P30-7 끄면 친 곳만',
      inputTargets('a', 'x', [{ ...ws, syncInput: false }], sessions).join(',') === 'a'
    )
    check(
      'P30-7 끝난 셸에는 보내지 않는다',
      inputTargets('a', 'x', [ws], [meta('a'), meta('b', 'exited')]).join(',') === 'a'
    )
  }

  // ── P30 / P31: 소켓 요청
  {
    const a = createLeaf('a')
    const ab = splitPane(a, a.id, 'row', 'b')!
    const ws: Workspace = { id: 'w1', title: null, root: ab.root, focusedPaneId: a.id }
    const calls: string[] = []
    const ctx = {
      workspaces: () => [ws],
      sessions: () => new Map(),
      browsers: () => new Map(),
      activeId: () => 'w1',
      rightSidebarOpen: () => false,
      select: () => {},
      focusPane: () => {},
      focusToward: (_w: string, dir: string, from: string) => {
        calls.push(`focus:${dir}:${from === a.id}`)
        return dir === 'right' ? ab.newPaneId : null
      },
      resizePane: (_w: string, dir: string, step: number) => {
        calls.push(`resize:${dir}:${step}`)
        return dir !== 'up'
      },
      setZoom: (_w: string, state?: boolean) => {
        calls.push(`zoom:${String(state)}`)
        return state ?? true
      },
      setSync: (_w: string, state?: boolean) => {
        calls.push(`sync:${String(state)}`)
        return state ?? true
      },
      equalize: () => calls.push('equalize'),
      breakPane: () => 'w2',
      createWorktree: async (branch: string, options: { base?: string }) => {
        calls.push(`worktree:${branch}:${options.base ?? ''}`)
        return 'w3'
      },
      create: async () => 'w4',
      removeWorktree: async (_w: string, confirm: boolean) => {
        calls.push(`remove:${confirm}`)
        return { removed: false, message: '커밋하지 않은 변경이 있어 지우지 않습니다' }
      }
    } as unknown as ControlContext

    const focus = (await handleControl(M.PANE_FOCUS, { direction: 'right' }, ctx)) as { pane_id: string }
    check('P30-1 소켓 방향 이동', focus.pane_id === ab.newPaneId && calls.includes('focus:right:true'))
    const noNeighbor = await handleControl(M.PANE_FOCUS, { direction: 'l' }, ctx).catch((e: ControlRequestError) => e.code)
    check('P30-1 이웃이 없으면 not_found', noNeighbor === 'not_found', String(noNeighbor))
    const badDir = await handleControl(M.PANE_RESIZE, { direction: 'sideways' }, ctx).catch((e: ControlRequestError) => e.code)
    check('P30-3 모르는 방향은 invalid_params', badDir === 'invalid_params', String(badDir))
    await handleControl(M.PANE_RESIZE, { direction: 'right', amount: 10 }, ctx)
    check('P30-3 백분율을 비율로', calls.includes('resize:right:0.1'))
    const stuck = await handleControl(M.PANE_RESIZE, { direction: 'up' }, ctx).catch((e: ControlRequestError) => e.code)
    check('P30-3 옮길 경계가 없으면 invalid_state', stuck === 'invalid_state', String(stuck))

    await handleControl(M.PANE_ZOOM, {}, ctx)
    await handleControl(M.PANE_ZOOM, { state: 'off' }, ctx)
    check('P30-4 생략하면 뒤집고 off는 끈다', calls.includes('zoom:undefined') && calls.includes('zoom:false'))
    await handleControl(M.WORKSPACE_SYNC, { state: 'on' }, ctx)
    check('P30-7 동시 입력 켜기', calls.includes('sync:true'))

    const created = (await handleControl(
      M.WORKSPACE_CREATE,
      { worktree: 'feat/x', base: 'main' },
      ctx
    )) as { id: string }
    check('P31-1 --worktree는 작업 트리로', created.id === 'w3' && calls.includes('worktree:feat/x:main'))
    const refused = await handleControl(M.WORKTREE_REMOVE, {}, ctx).catch((e: ControlRequestError) => e.message)
    check('P31-3 소켓은 묻지 않는다', calls.includes('remove:false'))
    check('P31-3 거절 사유를 그대로', String(refused).includes('변경'), String(refused))
  }

  console.log(results.join('\n'))
  console.log(`\n${results.length - failed}/${results.length} passed`)
  process.exit(failed === 0 ? 0 : 1)
}

void main()

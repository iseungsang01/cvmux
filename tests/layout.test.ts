/*
 * pane 트리 조작(POLICY.md P17)의 회귀 테스트.
 *
 * 분할·닫기는 순수 함수라 UI 없이 검증할 수 있다. 트리가 깊어지거나
 * 껍데기 split이 남는 것은 눈으로 보기 전에 여기서 걸린다.
 *
 * 실행: npm test
 */
import type { PaneNode } from '../src/shared/types'
import {
  closePane,
  collectSessionIds,
  createLeaf,
  firstLeafId,
  paneCount,
  resizeSplit,
  splitPane
} from '../src/renderer/lib/layout'
import { reorder } from '../src/renderer/lib/workspace'

const results: string[] = []
let failed = 0

function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failed++
  results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `  ← ${detail}` : ''}`)
}

/** 트리 모양을 문자열로 — 비교하기 쉽게 */
function shape(node: PaneNode): string {
  if (node.kind === 'leaf') return node.sessionId
  return `${node.direction === 'row' ? 'H' : 'V'}(${node.children.map(shape).join(' ')})`
}

function depth(node: PaneNode): number {
  return node.kind === 'leaf' ? 1 : 1 + Math.max(...node.children.map(depth))
}

function main(): void {
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

  console.log(results.join('\n'))
  console.log(`\n${results.length - failed}/${results.length} passed`)
  process.exit(failed === 0 ? 0 : 1)
}

main()

import type { PaneNode } from '@shared/types'

/**
 * pane 트리를 다루는 순수 함수들 (POLICY.md P17).
 *
 * 트리는 절대 제자리에서 고치지 않는다. 모든 함수가 새 트리를 돌려주므로
 * React가 변경을 알아채고, 실패한 연산은 원본을 그대로 남긴다.
 */

let counter = 0
function nextId(prefix: string): string {
  counter += 1
  return `${prefix}-${counter}-${Math.floor(performance.now())}`
}

export function createLeaf(sessionId: string): PaneNode {
  return { kind: 'leaf', id: nextId('pane'), sessionId }
}

export function collectLeaves(node: PaneNode): Array<{ id: string; sessionId: string }> {
  if (node.kind === 'leaf') return [{ id: node.id, sessionId: node.sessionId }]
  return node.children.flatMap(collectLeaves)
}

export function collectSessionIds(node: PaneNode): string[] {
  return collectLeaves(node).map((leaf) => leaf.sessionId)
}

export function findLeaf(node: PaneNode, paneId: string): PaneNode | null {
  if (node.kind === 'leaf') return node.id === paneId ? node : null
  for (const child of node.children) {
    const found = findLeaf(child, paneId)
    if (found) return found
  }
  return null
}

export function firstLeafId(node: PaneNode): string {
  return node.kind === 'leaf' ? node.id : firstLeafId(node.children[0])
}

/** 세션 id로 잎을 찾는다 — 세션이 죽어 정리할 때 쓴다 */
export function findLeafBySession(node: PaneNode, sessionId: string): PaneNode | null {
  if (node.kind === 'leaf') return node.sessionId === sessionId ? node : null
  for (const child of node.children) {
    const found = findLeafBySession(child, sessionId)
    if (found) return found
  }
  return null
}

/**
 * 잎을 둘로 나눈다 (P17-1).
 *
 * 부모가 이미 같은 방향으로 나뉘어 있으면 새 잎을 형제로 끼워 넣는다. 그러지
 * 않으면 오른쪽으로 세 번 나눌 때 트리가 3단으로 깊어지고, 비율 조정이 칸마다
 * 다른 의미를 갖게 된다.
 *
 * @returns 새 트리와 새로 생긴 pane의 id. 대상을 찾지 못하면 null
 */
export function splitPane(
  root: PaneNode,
  paneId: string,
  direction: 'row' | 'column',
  newSessionId: string
): { root: PaneNode; newPaneId: string } | null {
  if (!findLeaf(root, paneId)) return null

  const newLeaf = createLeaf(newSessionId)

  // root 자체가 대상 잎이면 새 split으로 감싼다
  if (root.kind === 'leaf' && root.id === paneId) {
    return {
      root: { kind: 'split', id: nextId('split'), direction, children: [root, newLeaf], sizes: [0.5, 0.5] },
      newPaneId: newLeaf.id
    }
  }

  const replace = (node: PaneNode): PaneNode => {
    if (node.kind === 'leaf') return node

    const index = node.children.findIndex((c) => c.kind === 'leaf' && c.id === paneId)
    if (index !== -1) {
      if (node.direction === direction) {
        // 같은 방향 — 형제로 끼워 넣고 대상의 몫을 반으로 쪼갠다
        const children = [...node.children]
        const sizes = [...node.sizes]
        const half = sizes[index] / 2
        sizes[index] = half
        children.splice(index + 1, 0, newLeaf)
        sizes.splice(index + 1, 0, half)
        return { ...node, children, sizes }
      }
      // 다른 방향 — 그 자리에서만 새 split을 만든다
      const children = [...node.children]
      children[index] = {
        kind: 'split',
        id: nextId('split'),
        direction,
        children: [node.children[index], newLeaf],
        sizes: [0.5, 0.5]
      }
      return { ...node, children }
    }

    return { ...node, children: node.children.map(replace) }
  }

  return { root: replace(root), newPaneId: newLeaf.id }
}

/**
 * 잎을 닫는다 (P17-3 / P17-4).
 *
 * @returns 남은 트리. 마지막 잎이었으면 null — 호출자가 워크스페이스를 닫는다
 */
export function closePane(root: PaneNode, paneId: string): PaneNode | null {
  if (root.kind === 'leaf') return root.id === paneId ? null : root

  const prune = (node: PaneNode): PaneNode | null => {
    if (node.kind === 'leaf') return node.id === paneId ? null : node

    const kept: PaneNode[] = []
    const sizes: number[] = []
    node.children.forEach((child, i) => {
      const result = prune(child)
      if (result === null) return
      kept.push(result)
      sizes.push(node.sizes[i])
    })

    if (kept.length === 0) return null
    // 자식이 하나만 남은 split은 껍데기다 — 자식으로 대체해 트리를 평탄하게 유지한다. P17-4
    if (kept.length === 1) return kept[0]
    return { ...node, children: kept, sizes: normalize(sizes) }
  }

  return prune(root)
}

/** 분할 비율을 조정한다. 인접한 두 칸 사이에서만 주고받는다. P17-5 */
export function resizeSplit(
  root: PaneNode,
  splitId: string,
  dividerIndex: number,
  ratioDelta: number,
  /** 각 칸이 지켜야 할 최소 비율. 호출자가 120px를 비율로 환산해 넘긴다 */
  minRatio = 0.08
): PaneNode {
  const apply = (node: PaneNode): PaneNode => {
    if (node.kind === 'leaf') return node
    if (node.id !== splitId) return { ...node, children: node.children.map(apply) }

    const sizes = [...node.sizes]
    const a = dividerIndex
    const b = dividerIndex + 1
    if (b >= sizes.length) return node

    // 어느 칸도 사라지지 않게 최소 몫을 남긴다. P17-5
    const total = sizes[a] + sizes[b]
    const MIN = Math.min(minRatio, total / 2)
    let next = sizes[a] + ratioDelta
    next = Math.max(MIN, Math.min(total - MIN, next))
    sizes[a] = next
    sizes[b] = total - next
    return { ...node, sizes }
  }
  return apply(root)
}

function normalize(sizes: number[]): number[] {
  const sum = sizes.reduce((a, b) => a + b, 0)
  if (sum <= 0) return sizes.map(() => 1 / sizes.length)
  return sizes.map((s) => s / sum)
}

/** 트리에 잎이 몇 개인가 — 세션 상한을 pane 단위로 세기 위해. P17-10 */
export function paneCount(node: PaneNode): number {
  return node.kind === 'leaf' ? 1 : node.children.reduce((n, c) => n + paneCount(c), 0)
}

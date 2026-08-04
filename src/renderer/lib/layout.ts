import type { PaneNode } from '@shared/types'

/**
 * pane 트리를 다루는 순수 함수들 (POLICY.md P17 / P24).
 *
 * 트리는 절대 제자리에서 고치지 않는다. 모든 함수가 새 트리를 돌려주므로
 * React가 변경을 알아채고, 실패한 연산은 원본을 그대로 남긴다.
 *
 * 잎(pane) 하나는 **가로 탭(surface)을 여럿** 담는다(P24). 탭이 하나뿐이면
 * 탭 바를 그리지 않으므로, 나누어 쓰지 않는 사용자에게는 이 구조가 보이지 않는다.
 */

let counter = 0
function nextId(prefix: string): string {
  counter += 1
  return `${prefix}-${counter}-${Math.floor(performance.now())}`
}

export interface LeafInfo {
  id: string
  surfaces: string[]
  active: number
  /** 지금 보이는 surface. 탭이 없는 잎은 트리에 남지 않으므로 항상 있다 */
  surfaceId: string
}

export function createLeaf(surfaceId: string): PaneNode {
  return { kind: 'leaf', id: nextId('pane'), surfaces: [surfaceId], active: 0 }
}

/** 잎의 지금 보이는 surface */
export function activeSurface(leaf: Extract<PaneNode, { kind: 'leaf' }>): string {
  return leaf.surfaces[clampIndex(leaf.active, leaf.surfaces.length)]
}

export function collectLeaves(node: PaneNode): LeafInfo[] {
  if (node.kind === 'leaf') {
    return [
      {
        id: node.id,
        surfaces: node.surfaces,
        active: clampIndex(node.active, node.surfaces.length),
        surfaceId: activeSurface(node)
      }
    ]
  }
  return node.children.flatMap(collectLeaves)
}

/** 보이는 것만 — 지금 화면에 그려지는 surface들 */
export function collectSessionIds(node: PaneNode): string[] {
  return collectLeaves(node).map((leaf) => leaf.surfaceId)
}

/**
 * 탭 뒤에 숨은 것까지 전부 (P24-4).
 *
 * 워크스페이스를 닫을 때, 상한을 셀 때, 저장할 때는 보이지 않는 탭도 세야 한다.
 * 이걸 빠뜨리면 탭 뒤의 세션이 조용히 남아 프로세스만 살아 있게 된다.
 */
export function collectAllSurfaces(node: PaneNode): string[] {
  if (node.kind === 'leaf') return [...node.surfaces]
  return node.children.flatMap(collectAllSurfaces)
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

/** surface id로 잎을 찾는다 — 세션이 죽어 정리할 때 쓴다. 숨은 탭도 본다 */
export function findLeafBySession(node: PaneNode, surfaceId: string): PaneNode | null {
  if (node.kind === 'leaf') return node.surfaces.includes(surfaceId) ? node : null
  for (const child of node.children) {
    const found = findLeafBySession(child, surfaceId)
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
  newSurfaceId: string
): { root: PaneNode; newPaneId: string } | null {
  if (!findLeaf(root, paneId)) return null

  const newLeaf = createLeaf(newSurfaceId)

  // root 자체가 대상 잎이면 새 split으로 감싼다
  if (root.kind === 'leaf' && root.id === paneId) {
    return {
      root: {
        kind: 'split',
        id: nextId('split'),
        direction,
        children: [root, newLeaf],
        sizes: [0.5, 0.5]
      },
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
 * 잎 안의 탭까지 통째로 사라진다. 탭 하나만 닫는 것은 `closeSurface`다.
 *
 * @returns 남은 트리. 마지막 잎이었으면 null — 호출자가 워크스페이스를 닫는다
 */
export function closePane(root: PaneNode, paneId: string): PaneNode | null {
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

// ── 가로 탭 (P24) ──────────────────────────────────────────────

/**
 * 잎에 탭을 하나 더한다 (P24-1).
 *
 * 새 탭은 **지금 탭의 바로 오른쪽**에 들어가고 곧바로 활성이 된다. 맨 끝에
 * 붙이면 탭이 많을 때 방금 연 것이 화면 밖에 생긴다.
 */
export function addSurface(
  root: PaneNode,
  paneId: string,
  surfaceId: string
): PaneNode | null {
  if (!findLeaf(root, paneId)) return null

  const apply = (node: PaneNode): PaneNode => {
    if (node.kind === 'leaf') {
      if (node.id !== paneId) return node
      const at = clampIndex(node.active, node.surfaces.length) + 1
      const surfaces = [...node.surfaces]
      surfaces.splice(at, 0, surfaceId)
      return { ...node, surfaces, active: at }
    }
    return { ...node, children: node.children.map(apply) }
  }

  return apply(root)
}

/**
 * 탭 하나를 닫는다 (P24-2).
 *
 * 마지막 탭이었으면 pane 자체가 사라진다 — 빈 pane은 아무것도 답하지 못한다.
 * 활성 탭을 닫으면 **왼쪽**으로 옮겨간다. 오른쪽으로 가면 탭을 연달아 닫을 때
 * 커서가 목록 끝까지 밀려가고, 방금 보던 자리에서 점점 멀어진다.
 *
 * @returns 남은 트리. 워크스페이스의 마지막 것이었으면 null
 */
export function closeSurface(root: PaneNode, surfaceId: string): PaneNode | null {
  const leaf = findLeafBySession(root, surfaceId)
  if (!leaf || leaf.kind !== 'leaf') return root

  // 그 잎의 마지막 탭이면 잎을 통째로 걷어낸다
  if (leaf.surfaces.length <= 1) return closePane(root, leaf.id)

  const apply = (node: PaneNode): PaneNode => {
    if (node.kind === 'leaf') {
      if (node.id !== leaf.id) return node
      const at = node.surfaces.indexOf(surfaceId)
      const surfaces = node.surfaces.filter((s) => s !== surfaceId)
      const active = clampIndex(node.active, node.surfaces.length)
      const next = at < active ? active - 1 : at === active ? Math.max(0, at - 1) : active
      return { ...node, surfaces, active: clampIndex(next, surfaces.length) }
    }
    return { ...node, children: node.children.map(apply) }
  }

  return apply(root)
}

/** 탭을 고른다. 범위를 벗어난 자리는 아무 일도 일으키지 않는다 */
export function selectSurface(root: PaneNode, paneId: string, index: number): PaneNode {
  const apply = (node: PaneNode): PaneNode => {
    if (node.kind === 'leaf') {
      if (node.id !== paneId) return node
      if (index < 0 || index >= node.surfaces.length) return node
      return { ...node, active: index }
    }
    return { ...node, children: node.children.map(apply) }
  }
  return apply(root)
}

/**
 * 다음/이전 탭 (P24-3).
 *
 * 끝에서 반대쪽으로 돌아간다 — 탭이 둘일 때 `Ctrl+Tab`이 토글처럼 동작해야
 * 한다는 기대가 강하고, 세 개 이상일 때도 끝에서 막히는 것보다 자연스럽다.
 */
export function cycleSurface(root: PaneNode, paneId: string, delta: number): PaneNode {
  const leaf = findLeaf(root, paneId)
  if (!leaf || leaf.kind !== 'leaf' || leaf.surfaces.length < 2) return root
  const count = leaf.surfaces.length
  const from = clampIndex(leaf.active, count)
  return selectSurface(root, paneId, (((from + delta) % count) + count) % count)
}

/** 탭 순서 바꾸기 — 드래그로 옮긴다 */
export function moveSurface(root: PaneNode, paneId: string, from: number, to: number): PaneNode {
  const apply = (node: PaneNode): PaneNode => {
    if (node.kind === 'leaf') {
      if (node.id !== paneId) return node
      const count = node.surfaces.length
      if (from < 0 || from >= count || to < 0 || to >= count || from === to) return node
      const surfaces = [...node.surfaces]
      const [moved] = surfaces.splice(from, 1)
      surfaces.splice(to, 0, moved)
      const active = clampIndex(node.active, count)
      // 옮긴 탭을 보고 있었다면 따라간다. 아니면 자리 이동만큼 보정한다
      const next =
        active === from
          ? to
          : active > from && active <= to
            ? active - 1
            : active < from && active >= to
              ? active + 1
              : active
      return { ...node, surfaces, active: next }
    }
    return { ...node, children: node.children.map(apply) }
  }
  return apply(root)
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

/**
 * 활성 자리를 범위 안으로 (P24-2).
 *
 * 저장된 배치나 탭 삭제 때문에 자리가 범위를 벗어날 수 있다. 그때 빈 화면을
 * 그리는 대신 가장 가까운 탭을 보여준다.
 */
function clampIndex(index: number, count: number): number {
  if (count <= 0) return 0
  if (!Number.isInteger(index) || index < 0) return 0
  return Math.min(index, count - 1)
}

/** 트리에 잎이 몇 개인가 — 세션 상한을 pane 단위로 세기 위해. P17-10 */
export function paneCount(node: PaneNode): number {
  return node.kind === 'leaf' ? 1 : node.children.reduce((n, c) => n + paneCount(c), 0)
}

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

/**
 * 탭 순서 바꾸기 — 드래그로 옮긴다 (P24-3).
 *
 * 보고 있던 탭은 자리가 밀려도 계속 보고 있어야 한다. 옮긴 것이 그 탭이면
 * 따라가고, 아니면 밀린 만큼만 보정한다.
 */
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

// ── 키보드로 pane 다루기 (P30) ─────────────────────────────────

export type PaneDirection = 'left' | 'right' | 'up' | 'down'

/** 워크스페이스를 1×1로 볼 때 잎 하나가 차지하는 자리 */
export interface PaneRect {
  x: number
  y: number
  w: number
  h: number
}

/**
 * 잎마다의 자리를 트리의 비율만으로 계산한다 (P30-1).
 *
 * DOM을 재지 않는다 — 숨은 워크스페이스나 확대(P30-4)로 가려진 pane도 자리를
 * 알아야 이웃을 고를 수 있고, 순수 함수여야 테스트로 붙잡을 수 있다.
 * 분할선 두께는 무시한다. 이웃을 고르는 데는 상대 위치만 있으면 된다.
 */
export function leafRects(root: PaneNode): Map<string, PaneRect> {
  const out = new Map<string, PaneRect>()
  const walk = (node: PaneNode, rect: PaneRect): void => {
    if (node.kind === 'leaf') {
      out.set(node.id, rect)
      return
    }
    const total = node.sizes.reduce((a, b) => a + b, 0) || 1
    let offset = 0
    node.children.forEach((child, i) => {
      const share = (node.sizes[i] ?? 0) / total
      walk(
        child,
        node.direction === 'row'
          ? { x: rect.x + rect.w * offset, y: rect.y, w: rect.w * share, h: rect.h }
          : { x: rect.x, y: rect.y + rect.h * offset, w: rect.w, h: rect.h * share }
      )
      offset += share
    })
  }
  walk(root, { x: 0, y: 0, w: 1, h: 1 })
  return out
}

/** 부동소수점 비율이 맞닿았다고 볼 오차 */
const EDGE_EPS = 1e-6

/**
 * 그 방향의 이웃 pane (P30-1).
 *
 * 맞닿은 것 중에서 고른다. 여럿이면 지금 pane의 **한가운데를 마주 보는** 것이
 * 먼저다 — 오른쪽에 위아래로 둘이 있을 때 눈이 가는 쪽이 거기다. 그 방향에
 * 아무것도 없으면 null이고, 그때 키는 셸로 흘려보낸다(P30-2).
 */
export function neighborPane(root: PaneNode, paneId: string, direction: PaneDirection): string | null {
  const rects = leafRects(root)
  const from = rects.get(paneId)
  if (!from) return null

  const horizontal = direction === 'left' || direction === 'right'
  const center = horizontal ? from.y + from.h / 2 : from.x + from.w / 2

  let best: string | null = null
  let bestGap = Number.POSITIVE_INFINITY
  let bestFacing = false
  let bestOverlap = 0

  for (const [id, r] of rects) {
    if (id === paneId) continue
    const gap =
      direction === 'right'
        ? r.x - (from.x + from.w)
        : direction === 'left'
          ? from.x - (r.x + r.w)
          : direction === 'down'
            ? r.y - (from.y + from.h)
            : from.y - (r.y + r.h)
    if (gap < -EDGE_EPS) continue

    const [lo, hi, rLo, rHi] = horizontal
      ? [from.y, from.y + from.h, r.y, r.y + r.h]
      : [from.x, from.x + from.w, r.x, r.x + r.w]
    const overlap = Math.min(hi, rHi) - Math.max(lo, rLo)
    if (overlap <= EDGE_EPS) continue

    const facing = rLo <= center + EDGE_EPS && center < rHi - EDGE_EPS
    const closer = gap < bestGap - EDGE_EPS
    const sameGap = Math.abs(gap - bestGap) <= EDGE_EPS
    if (
      closer ||
      (sameGap && facing && !bestFacing) ||
      (sameGap && facing === bestFacing && overlap > bestOverlap + EDGE_EPS)
    ) {
      best = id
      bestGap = gap
      bestFacing = facing
      bestOverlap = overlap
    }
  }
  return best
}

/** 뿌리에서 잎까지 거쳐 가는 split과 그 안의 자리 */
function pathTo(root: PaneNode, paneId: string): Array<{ split: Extract<PaneNode, { kind: 'split' }>; index: number }> | null {
  if (root.kind === 'leaf') return root.id === paneId ? [] : null
  for (let i = 0; i < root.children.length; i++) {
    const rest = pathTo(root.children[i], paneId)
    if (rest) return [{ split: root, index: i }, ...rest]
  }
  return null
}

/**
 * 키보드로 경계를 옮긴다 (P30-3).
 *
 * 화살표 쪽의 경계를 화살표 방향으로 민다 — 그쪽에 이웃이 있으면 pane이 커진다.
 * 그쪽 끝에 붙어 있어 경계가 없으면 반대쪽 경계를 같은 방향으로 민다(pane이
 * 작아진다). 어느 쪽이든 경계는 누른 화살표를 따라 움직이므로 손이 헷갈리지
 * 않는다. Windows Terminal의 `Alt+Shift+화살표`와 같다.
 *
 * 가장 안쪽의 같은 방향 분할부터 본다 — 바로 옆 경계가 손에 잡히는 경계다.
 */
export function resizeToward(
  root: PaneNode,
  paneId: string,
  direction: PaneDirection,
  step = 0.05,
  /** 분할마다 지킬 최소 비율. 화면 크기를 아는 호출자가 120px를 환산해 준다(P17-5) */
  minRatio: number | ((splitId: string, direction: 'row' | 'column') => number) = 0.08
): PaneNode {
  const minOf = (split: Extract<PaneNode, { kind: 'split' }>): number =>
    typeof minRatio === 'function' ? minRatio(split.id, split.direction) : minRatio
  const path = pathTo(root, paneId)
  if (!path) return root
  const axis = direction === 'left' || direction === 'right' ? 'row' : 'column'
  const forward = direction === 'right' || direction === 'down'
  const delta = forward ? step : -step
  const candidates = path.filter((p) => p.split.direction === axis).reverse()

  for (const { split, index } of candidates) {
    const divider = forward ? index : index - 1
    if (divider >= 0 && divider < split.children.length - 1) {
      return resizeSplit(root, split.id, divider, delta, minOf(split))
    }
  }
  for (const { split, index } of candidates) {
    const divider = forward ? index - 1 : index
    if (divider >= 0 && divider < split.children.length - 1) {
      return resizeSplit(root, split.id, divider, delta, minOf(split))
    }
  }
  return root
}

/**
 * 모든 분할을 고르게 (P30-5).
 *
 * tmux의 `select-layout even-*`에 해당한다. 끌어서 맞추다 엉킨 비율을 한 번에
 * 되돌린다. 같은 분할 안의 칸끼리만 고르게 한다 — 트리 모양은 그대로다.
 */
export function equalizeSplits(root: PaneNode): PaneNode {
  if (root.kind === 'leaf') return root
  return {
    ...root,
    children: root.children.map(equalizeSplits),
    sizes: root.children.map(() => 1 / root.children.length)
  }
}

/**
 * pane 하나를 트리에서 빼낸다 — 세션은 죽이지 않는다 (P30-6).
 *
 * tmux의 `break-pane`. 빠져나간 잎은 탭까지 그대로 들고 새 워크스페이스가 된다.
 *
 * @returns 남은 트리(마지막 잎이었으면 null)와 빼낸 잎. 대상이 없으면 null
 */
export function extractPane(
  root: PaneNode,
  paneId: string
): { rest: PaneNode | null; leaf: Extract<PaneNode, { kind: 'leaf' }> } | null {
  const leaf = findLeaf(root, paneId)
  if (!leaf || leaf.kind !== 'leaf') return null
  return { rest: closePane(root, paneId), leaf }
}

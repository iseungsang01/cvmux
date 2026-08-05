/*
 * 창 레지스트리(POLICY.md P27)의 단위 테스트.
 *
 * 여기서 확인하는 것은 "무엇이 어느 창에 있는가"다. 창이 하나뿐이던 시절에는
 * 물을 필요조차 없던 질문이고, 답이 틀려도 타입 검사에는 걸리지 않는다 —
 * 화면에서야 "저 창을 조작했는데 다른 창이 움직인다"로 나타난다.
 *
 * Electron이 필요 없다. 레지스트리는 BrowserWindow를 타입으로만 알고 있으므로
 * 여기서는 부르는 것만 흉내 낸 객체를 넣는다.
 *
 * 실행: npm test
 */
import type { BrowserWindow } from 'electron'

import { WindowRegistry } from '../src/main/windows'
import type { Workspace } from '../src/shared/types'

const results: string[] = []
let failed = 0

function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failed++
  results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `  ← ${detail}` : ''}`)
}

/** 레지스트리가 실제로 부르는 것만 갖춘 가짜 창 */
class FakeWindow {
  private readonly handlers = new Map<string, (() => void)[]>()
  readonly webContents = { id: 0 }

  constructor(webContentsId: number) {
    this.webContents.id = webContentsId
  }

  on(event: string, handler: () => void): this {
    const list = this.handlers.get(event) ?? []
    list.push(handler)
    this.handlers.set(event, list)
    return this
  }

  /** 창에서 실제로 일어난 일을 흉내 낸다 */
  emit(event: string): void {
    for (const handler of this.handlers.get(event) ?? []) handler()
  }
}

function fake(webContentsId: number): BrowserWindow {
  return new FakeWindow(webContentsId) as unknown as BrowserWindow
}

function workspace(id: string, surfaces: string[]): Workspace {
  return {
    id,
    title: null,
    root: { kind: 'leaf', id: `pane-${id}`, surfaces, active: 0 },
    focusedPaneId: `pane-${id}`
  }
}

function main(): void {
  // ── 창마다 다른 이름을 얻는다 (P27-2)
  {
    const registry = new WindowRegistry()
    check('빈 레지스트리', registry.size === 0 && registry.current() === null)

    const a = registry.add(fake(1))
    const b = registry.add(fake(2))
    check('등록된다', registry.get(a.id) !== null && registry.size === 2)
    check('id는 겹치지 않는다', a.id !== b.id)
    check('모르는 id는 null', registry.get('win-nope') === null)
  }

  // ── 어느 렌더러가 보냈는지 되짚는다 (P27-2)
  {
    const registry = new WindowRegistry()
    const a = registry.add(fake(11))
    const b = registry.add(fake(22))

    check('webContents로 창을 찾는다', registry.ofWebContents(22)?.id === b.id)
    check('모르는 webContents는 null', registry.ofWebContents(99) === null)
    check('창이 둘', registry.size === 2 && registry.first()?.id === a.id)
  }

  /*
   * 기준이 되는 창은 **마지막으로 포커스된 창**이다 (P27-3).
   *
   * 첫 창을 쓰면 창을 여럿 띄운 사람이 방금 보고 있던 창이 아니라 처음 만든
   * 창을 조작하게 된다 — 소켓으로 부를 때 특히 티가 난다.
   */
  {
    const registry = new WindowRegistry()
    const first = fake(1)
    const second = fake(2)
    const a = registry.add(first)
    const b = registry.add(second)

    check('마지막으로 만든 창이 기준', registry.current()?.id === b.id)
    ;(first as unknown as FakeWindow).emit('focus')
    check('포커스가 옮겨가면 기준도 옮겨간다', registry.current()?.id === a.id)

    ;(first as unknown as FakeWindow).emit('closed')
    check('닫힌 창은 빠진다', registry.get(a.id) === null && registry.size === 1)
    check('기준은 남은 창으로 물러난다', registry.current()?.id === b.id)

    ;(second as unknown as FakeWindow).emit('closed')
    check('전부 닫히면 기준도 없다', registry.current() === null)
  }

  // ── 배치는 창마다 따로다 (P27-5)
  {
    const registry = new WindowRegistry()
    const a = registry.add(fake(1), [workspace('ws-1', ['sess-a'])])
    const b = registry.add(fake(2), [workspace('ws-2', ['sess-b'])])

    check('워크스페이스가 어느 창에', registry.ofWorkspace('ws-2')?.id === b.id)
    check('세션이 어느 창에', registry.ofSession('sess-a')?.id === a.id)
    check('모르는 세션은 null', registry.ofSession('sess-zzz') === null)
    check('전부 이어 붙인다', registry.allWorkspaces().length === 2)

    registry.setLayout(a.id, [])
    check('배치를 바꾸면 그 창만', registry.allWorkspaces().length === 1)
    check('비운 창의 세션은 더 이상 없다', registry.ofSession('sess-a') === null)
  }

  /*
   * 숨은 탭도 찾는다 (P24-4 / P27-1).
   *
   * pane 하나가 탭을 여럿 담으므로, 보이는 탭만 훑으면 알림이 "어느 창을
   * 깨울지"를 못 정한다.
   */
  {
    const registry = new WindowRegistry()
    const split: Workspace = {
      id: 'ws-split',
      title: null,
      root: {
        kind: 'split',
        id: 'pane-root',
        direction: 'row',
        children: [
          { kind: 'leaf', id: 'pane-l', surfaces: ['sess-1', 'sess-2'], active: 0 },
          { kind: 'leaf', id: 'pane-r', surfaces: ['sess-3'], active: 0 }
        ],
        sizes: [0.5, 0.5]
      },
      focusedPaneId: 'pane-l'
    }
    const entry = registry.add(fake(1), [split])
    check('분할 안쪽도 찾는다', registry.ofSession('sess-3')?.id === entry.id)
    check('숨은 탭도 찾는다', registry.ofSession('sess-2')?.id === entry.id)
  }

  /*
   * 창을 만드는 법은 밖에서 빌려 온다 (P27-3).
   *
   * 레지스트리는 이미 만들어진 창을 들고 있을 뿐이다. 그래도 화면과 소켓
   * 양쪽이 "창 하나 더"를 부를 수 있어야 해서 그 방법만 맡아 둔다.
   */
  {
    const registry = new WindowRegistry()
    let threw = false
    try {
      registry.spawn()
    } catch {
      threw = true
    }
    check('만드는 법을 모르면 거부한다', threw)

    registry.setFactory(() => 'win-made')
    check('맡겨 두면 그대로 부른다', registry.spawn() === 'win-made')
  }

  console.log(results.join('\n'))
  console.log(`\n${results.length - failed}/${results.length} passed`)
  process.exit(failed === 0 ? 0 : 1)
}

main()

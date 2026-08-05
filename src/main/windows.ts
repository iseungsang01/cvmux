import { randomUUID } from 'node:crypto'
import type { BrowserWindow } from 'electron'

import type { Workspace } from '@shared/types'

/**
 * 창 레지스트리 (POLICY.md P27).
 *
 * cmux는 창을 여럿 띄우고 각 창이 자기 워크스페이스를 갖는다. 모니터가 둘일 때
 * 한쪽에 에이전트를, 다른 쪽에 빌드를 두는 식이다.
 *
 * **세션은 창에 속하지 않는다.** PTY는 앱 전체가 하나로 들고 있고(`PtyManager`),
 * 창은 그중 일부를 들여다보는 유리창이다 — 창을 닫아도 세션이 죽지 않는 것과
 * 같은 이치다(P18-1). 창이 갖는 것은 **배치**뿐이다.
 */

export interface WindowEntry {
  id: string
  win: BrowserWindow
  /** 이 창이 보여주는 워크스페이스들. 창마다 다르다 */
  layout: Workspace[]
}

export class WindowRegistry {
  private readonly windows = new Map<string, WindowEntry>()
  /** 마지막으로 포커스된 창. 트레이와 토스트가 어디를 깨울지 정할 때 쓴다 */
  private lastFocused: string | null = null

  /**
   * 새 창을 만드는 법 (P27-3).
   *
   * 창을 **만드는** 것은 main/index.ts가 안다 — 레지스트리는 이미 만들어진
   * 창을 들고 있을 뿐이다. 그래도 화면과 소켓 양쪽이 "창 하나 더"를 부를 수
   * 있어야 해서, 그 방법만 여기에 맡겨 둔다.
   */
  private factory: (() => string) | null = null

  setFactory(fn: () => string): void {
    this.factory = fn
  }

  spawn(): string {
    if (!this.factory) throw new Error('창을 만들 준비가 되지 않았습니다')
    return this.factory()
  }

  add(win: BrowserWindow, layout: Workspace[] = []): WindowEntry {
    const id = `win-${randomUUID().slice(0, 8)}`
    const entry: WindowEntry = { id, win, layout }
    this.windows.set(id, entry)
    this.lastFocused = id

    win.on('focus', () => {
      this.lastFocused = id
    })
    win.on('closed', () => {
      this.windows.delete(id)
      if (this.lastFocused === id) this.lastFocused = this.first()?.id ?? null
    })

    return entry
  }

  get(id: string): WindowEntry | null {
    return this.windows.get(id) ?? null
  }

  /** 창을 보낸 렌더러가 어느 창인지 — IPC 핸들러가 이걸로 되짚는다 */
  ofWebContents(webContentsId: number): WindowEntry | null {
    for (const entry of this.windows.values()) {
      if (entry.win.webContents.id === webContentsId) return entry
    }
    return null
  }

  list(): WindowEntry[] {
    return [...this.windows.values()]
  }

  first(): WindowEntry | null {
    return this.windows.values().next().value ?? null
  }

  /**
   * 지금 기준이 되는 창 (P27-3).
   *
   * 소켓이 `--window` 없이 부르면 **마지막으로 포커스된 창**이다. 첫 번째 창을
   * 쓰면 창을 여럿 띄운 사람이 방금 보고 있던 창이 아니라 처음 만든 창을 조작하게
   * 된다.
   */
  current(): WindowEntry | null {
    if (this.lastFocused !== null) {
      const found = this.windows.get(this.lastFocused)
      if (found) return found
    }
    return this.first()
  }

  /** 워크스페이스가 어느 창에 있는가 — 알림을 띄울 창을 고를 때 쓴다 */
  ofWorkspace(workspaceId: string): WindowEntry | null {
    for (const entry of this.windows.values()) {
      if (entry.layout.some((w) => w.id === workspaceId)) return entry
    }
    return null
  }

  /** 세션이 어느 창에 있는가. 숨은 탭까지 본다(P24-4) */
  ofSession(sessionId: string): WindowEntry | null {
    for (const entry of this.windows.values()) {
      for (const workspace of entry.layout) {
        if (surfacesOf(workspace).includes(sessionId)) return entry
      }
    }
    return null
  }

  /** 모든 창의 배치를 이어 붙인다 — 저장과 세션 정리에 쓴다 */
  allWorkspaces(): Workspace[] {
    return this.list().flatMap((entry) => entry.layout)
  }

  setLayout(id: string, layout: Workspace[]): void {
    const entry = this.windows.get(id)
    if (entry) entry.layout = layout
  }

  get size(): number {
    return this.windows.size
  }
}

function surfacesOf(workspace: Workspace): string[] {
  const out: string[] = []
  const walk = (node: Workspace['root']): void => {
    if (node.kind === 'leaf') {
      out.push(...node.surfaces)
      return
    }
    node.children.forEach(walk)
  }
  walk(workspace.root)
  return out
}

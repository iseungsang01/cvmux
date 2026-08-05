import { randomUUID } from 'node:crypto'
import { BrowserWindow, WebContentsView, shell } from 'electron'

import type { BrowserMeta, BrowserRect } from '@shared/types'
import { normalizeUrl } from '@shared/url'

/**
 * 내장 브라우저 (POLICY.md P23).
 *
 * cmux는 터미널 옆에 진짜 브라우저를 띄우고, 에이전트가 그것을 조종해 자기가
 * 고친 웹을 직접 확인하게 한다. 그것이 이 기능의 존재 이유다 — 사람이 브라우저를
 * 대신 눌러 주지 않아도 되는 것.
 *
 * Electron에서는 `WebContentsView`가 그 자리에 온다. 페이지는 렌더러의 DOM이
 * 아니라 **창에 직접 얹힌 네이티브 뷰**이므로, 렌더러가 알려준 사각형에 맞춰
 * 우리가 자리를 잡아 준다(P23-2).
 */

export interface BrowserHost {
  /** 이 화면이 얹힐 창. 창 id를 모르면 지금 보고 있는 창. P27-4 */
  window(windowId: string | null): BrowserWindow | null
  /** 페이지 상태가 바뀌었다 — 주소창과 사이드바가 따라와야 한다 */
  onChange(meta: BrowserMeta): void
}

interface Surface {
  id: string
  /** 어느 창에 얹혔는가. 창이 여럿이면 다른 창 위에 그리면 안 된다. P27-4 */
  windowId: string | null
  view: WebContentsView
  /** 렌더러가 알려준 자리. 보이지 않으면 null */
  rect: BrowserRect | null
  attached: boolean
}

export class BrowserManager {
  private readonly surfaces = new Map<string, Surface>()

  constructor(private readonly host: BrowserHost) {}

  create(url: string, windowId: string | null = null): BrowserMeta {
    const id = `br-${randomUUID()}`
    const view = new WebContentsView({
      webPreferences: {
        // 페이지는 신뢰 경계 밖이다. 우리 preload를 얹지 않는다. P23-6
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        /*
         * 창이 가려져도 페이지를 계속 그린다 (P23-8).
         *
         * 기본값은 가려진 창의 타이머와 렌더링을 늦춘다. 사람이 보는 브라우저에는
         * 맞는 절약이지만, 이 화면을 실제로 조종하는 것은 **뒤에서 도는 에이전트**다.
         * `document.visibilityState`가 hidden이 되면 애니메이션과 타이머를 멈추는
         * 화면이 많고, 그러면 에이전트가 자기가 고친 결과를 못 본다.
         */
        backgroundThrottling: false
      }
    })

    const surface: Surface = { id, windowId, view, rect: null, attached: false }
    this.surfaces.set(id, surface)

    const contents = view.webContents
    const report = (): void => this.host.onChange(this.metaOf(surface))

    contents.on('did-start-loading', report)
    contents.on('did-stop-loading', report)
    contents.on('did-navigate', report)
    contents.on('did-navigate-in-page', report)
    contents.on('page-title-updated', report)

    /*
     * 새 창 요청은 같은 pane에서 연다 (P23-5).
     *
     * 팝업을 진짜 창으로 띄우면 cvmux 바깥에 브라우저 창이 하나 뜬다 — 터미널
     * 옆에 두려고 만든 기능인데 그러면 자리를 벗어난다. 다만 외부 스킴은
     * 기본 브라우저로 넘긴다.
     */
    contents.setWindowOpenHandler(({ url: target }) => {
      if (/^https?:\/\//.test(target)) void contents.loadURL(target)
      else void shell.openExternal(target)
      return { action: 'deny' }
    })

    void contents.loadURL(normalizeUrl(url)).catch(() => undefined)
    return this.metaOf(surface)
  }

  /**
   * 자리를 잡는다 (P23-2).
   *
   * 네이티브 뷰는 렌더러의 레이아웃을 모른다. 렌더러가 자리표시 div의 사각형을
   * 알려 주면 여기서 그대로 얹는다. 사각형이 없으면(다른 워크스페이스에 있거나
   * 접혀 있으면) 창에서 떼어 낸다 — 떼지 않으면 다른 화면 위에 그대로 떠 있다.
   */
  place(id: string, rect: BrowserRect | null, windowId: string | null = null): void {
    const surface = this.surfaces.get(id)
    if (!surface) return
    surface.rect = rect

    /*
     * 창이 바뀌었으면 먼저 떼어 낸다 (P27-4).
     *
     * 워크스페이스가 다른 창으로 건너간 경우다. 옛 창에서 떼지 않으면 그쪽에
     * 그대로 떠 있는 채로 새 창에도 하나 더 뜬다.
     */
    if (windowId !== null && windowId !== surface.windowId) {
      const old = this.host.window(surface.windowId)
      if (surface.attached && old && !old.isDestroyed()) {
        old.contentView.removeChildView(surface.view)
      }
      surface.attached = false
      surface.windowId = windowId
    }

    const win = this.host.window(surface.windowId)
    if (!win || win.isDestroyed()) return

    if (rect === null || rect.width <= 0 || rect.height <= 0) {
      if (surface.attached) {
        win.contentView.removeChildView(surface.view)
        surface.attached = false
      }
      return
    }

    if (!surface.attached) {
      win.contentView.addChildView(surface.view)
      surface.attached = true
    }
    surface.view.setBounds({
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height)
    })
  }

  close(id: string): boolean {
    const surface = this.surfaces.get(id)
    if (!surface) return false
    this.surfaces.delete(id)

    const win = this.host.window(surface.windowId)
    if (surface.attached && win && !win.isDestroyed()) {
      win.contentView.removeChildView(surface.view)
    }
    surface.view.webContents.close()
    return true
  }

  closeAll(): void {
    for (const id of [...this.surfaces.keys()]) this.close(id)
  }

  list(): BrowserMeta[] {
    return [...this.surfaces.values()].map((s) => this.metaOf(s))
  }

  // ── 조작 ─────────────────────────────────────────────────────

  navigate(id: string, url: string): boolean {
    const contents = this.contents(id)
    if (!contents) return false
    void contents.loadURL(normalizeUrl(url)).catch(() => undefined)
    return true
  }

  back(id: string): boolean {
    const contents = this.contents(id)
    if (!contents?.navigationHistory.canGoBack()) return false
    contents.navigationHistory.goBack()
    return true
  }

  forward(id: string): boolean {
    const contents = this.contents(id)
    if (!contents?.navigationHistory.canGoForward()) return false
    contents.navigationHistory.goForward()
    return true
  }

  reload(id: string): boolean {
    const contents = this.contents(id)
    if (!contents) return false
    contents.reload()
    return true
  }

  toggleDevTools(id: string): boolean {
    const contents = this.contents(id)
    if (!contents) return false
    if (contents.isDevToolsOpened()) contents.closeDevTools()
    else contents.openDevTools({ mode: 'detach' })
    return true
  }

  focus(id: string): boolean {
    const contents = this.contents(id)
    if (!contents) return false
    contents.focus()
    return true
  }

  /**
   * 페이지 안에서 자바스크립트를 돈다 (P23-3).
   *
   * 에이전트가 쓰는 모든 조작(스냅샷·클릭·입력)이 결국 이 위에 얹힌다.
   * 사용자 제스처가 필요한 API가 있으므로 `userGesture`를 켠다.
   */
  async evaluate(id: string, code: string): Promise<unknown> {
    const contents = this.contents(id)
    if (!contents) throw new Error('브라우저 화면을 찾을 수 없습니다')
    return contents.executeJavaScript(code, true)
  }

  async screenshot(id: string): Promise<string> {
    const contents = this.contents(id)
    if (!contents) throw new Error('브라우저 화면을 찾을 수 없습니다')
    const image = await contents.capturePage()
    return image.toPNG().toString('base64')
  }

  private contents(id: string) {
    return this.surfaces.get(id)?.view.webContents ?? null
  }

  private metaOf(surface: Surface): BrowserMeta {
    const contents = surface.view.webContents
    return {
      id: surface.id,
      url: contents.getURL(),
      title: contents.getTitle(),
      loading: contents.isLoading(),
      canGoBack: contents.navigationHistory.canGoBack(),
      canGoForward: contents.navigationHistory.canGoForward()
    }
  }
}

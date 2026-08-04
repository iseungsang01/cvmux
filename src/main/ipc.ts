import { BrowserWindow, clipboard, dialog, ipcMain } from 'electron'

import type { NotificationStore } from '@core/notifications'
import type { WorkspaceMetaStore } from '@core/workspace-meta'
import type { PtyManager } from '@core/pty-manager'
import { POLICY } from '@shared/policy'
import { CONTROL_BRIDGE_TIMEOUT_MS } from '@shared/protocol'
import {
  IPC,
  type BrowserAction,
  type BrowserRect,
  type CreateSessionOptions,
  type CvmuxConfig,
  type TodoItem,
  type Workspace
} from '@shared/types'
import type { BrowserManager } from './browser'
import { BridgeError, type ControlBridge } from './control-socket'
import type { Notifier } from './notifier'

/** pane 배치를 어디서 읽고 어디에 저장할지는 호출자(main/index.ts)가 결정한다. P17 */
export interface LayoutStore {
  load(): Workspace[]
  save(workspaces: Workspace[]): void
}

/**
 * main ↔ 렌더러 왕복 다리 (P20-7).
 *
 * 워크스페이스와 pane 배치는 렌더러가 들고 있다. 제어 소켓이 그것을 물으면
 * 여기를 거쳐 렌더러에 묻고 답을 받아 온다. 창이 없거나 렌더러가 제한 시간
 * 안에 답하지 않으면 거부한다 — 소켓 클라이언트를 무한정 기다리게 두지 않는다.
 */
class RendererBridge implements ControlBridge {
  private nextId = 1
  private readonly waiting = new Map<
    number,
    { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }
  >()

  call(method: string, params: Record<string, unknown>): Promise<unknown> {
    const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed())
    if (!win || win.webContents.isDestroyed()) {
      return Promise.reject(new Error('창이 없습니다. cvmux 창을 먼저 여세요'))
    }

    const id = this.nextId++
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id)
        reject(new Error('렌더러가 응답하지 않습니다'))
      }, CONTROL_BRIDGE_TIMEOUT_MS)
      this.waiting.set(id, { resolve, reject, timer })
      win.webContents.send(IPC.EVT_CTL_REQUEST, { id, method, params })
    })
  }

  settle(id: number, ok: boolean, payload: unknown): void {
    const pending = this.waiting.get(id)
    if (!pending) return
    this.waiting.delete(id)
    clearTimeout(pending.timer)
    if (ok) {
      pending.resolve(payload)
      return
    }

    /*
     * 렌더러가 붙인 오류 코드를 살려 보낸다 (P20-8).
     *
     * 전부 `internal_error`로 뭉개지면 스크립트는 "내가 잘못 불렀는가"와
     * "앱이 고장났는가"를 구분하지 못한다.
     */
    const fault = payload as { code?: unknown; message?: unknown } | string | null
    if (typeof fault === 'object' && fault !== null && typeof fault.message === 'string') {
      pending.reject(new BridgeError(String(fault.code ?? 'internal_error'), fault.message))
      return
    }
    pending.reject(new Error(typeof fault === 'string' ? fault : '요청을 처리하지 못했습니다'))
  }
}

/**
 * IPC 배선 (P9).
 *
 * 렌더러의 요청은 여기서 PtyManager 호출로 바뀌고, PtyManager의 이벤트는
 * 여기서 렌더러로 내려간다.
 */
export function registerIpc(
  manager: PtyManager,
  notifier: Notifier,
  layout: LayoutStore,
  inbox: NotificationStore,
  config: () => CvmuxConfig,
  browsers: BrowserManager,
  meta: WorkspaceMetaStore
): ControlBridge {
  const bridge = new RendererBridge()

  ipcMain.handle(IPC.CONFIG, () => config())

  // ── 사이드바 메타데이터 (P25) ────────────────────────────────
  ipcMain.handle(IPC.WORKSPACE_META, () => meta.all())

  ipcMain.handle(IPC.TODO_ADD, (_event, workspaceId: unknown, text: unknown) => {
    if (typeof workspaceId !== 'string' || typeof text !== 'string' || !text.trim()) return false
    try {
      // 사람이 화면에서 적은 것은 origin이 user다 — 에이전트가 지우지 못하는 근거
      meta.addTodo(workspaceId, text, 'pending', 'user')
      return true
    } catch {
      return false
    }
  })

  ipcMain.handle(
    IPC.TODO_SET_STATE,
    (_event, workspaceId: unknown, ref: unknown, state: unknown) => {
      if (typeof workspaceId !== 'string' || typeof ref !== 'string') return false
      const known = ['pending', 'in-progress', 'completed']
      if (typeof state !== 'string' || !known.includes(state)) return false
      return meta.setTodoState(workspaceId, ref, state as TodoItem['state']) !== null
    }
  )

  ipcMain.handle(IPC.TODO_REMOVE, (_event, workspaceId: unknown, ref: unknown) =>
    typeof workspaceId === 'string' && typeof ref === 'string'
      ? meta.removeTodo(workspaceId, ref)
      : false
  )

  // ── 내장 브라우저 (P23) ──────────────────────────────────────
  ipcMain.handle(IPC.BROWSER_CREATE, (_event, url: unknown) =>
    browsers.create(typeof url === 'string' ? url : 'about:blank')
  )

  ipcMain.handle(IPC.BROWSER_PLACE, (_event, id: unknown, rect: unknown) => {
    if (typeof id !== 'string') return false
    browsers.place(id, rect === null ? null : (rect as BrowserRect))
    return true
  })

  ipcMain.handle(IPC.BROWSER_CLOSE, (_event, id: unknown) =>
    typeof id === 'string' ? browsers.close(id) : false
  )

  ipcMain.handle(IPC.BROWSER_LIST, () => browsers.list())

  ipcMain.handle(IPC.BROWSER_ACTION, (_event, id: unknown, action: unknown) => {
    if (typeof id !== 'string' || typeof action !== 'object' || action === null) return false
    const a = action as BrowserAction
    switch (a.kind) {
      case 'navigate':
        return browsers.navigate(id, a.url)
      case 'back':
        return browsers.back(id)
      case 'forward':
        return browsers.forward(id)
      case 'reload':
        return browsers.reload(id)
      case 'devtools':
        return browsers.toggleDevTools(id)
      case 'focus':
        return browsers.focus(id)
      default:
        return false
    }
  })

  /** 사용자가 지금 보고 있는 세션. 토스트를 띄울지 판단에 쓴다. P15-2 */
  let activeSessionId: string | null = null

  const broadcast = (channel: string, ...args: unknown[]): void => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed() || win.webContents.isDestroyed()) continue
      win.webContents.send(channel, ...args)
    }
  }

  manager.on('data', (id, chunk) => broadcast(IPC.EVT_DATA, id, chunk))
  manager.on('meta', (meta) => broadcast(IPC.EVT_META, meta))
  manager.on('exit', (info) => broadcast(IPC.EVT_EXIT, info))
  manager.on('created', (meta) => broadcast(IPC.EVT_CREATED, meta))

  manager.on('closed', (id) => {
    notifier.forget(id)
    broadcast(IPC.EVT_CLOSED, id)
  })

  // 명시적 알림(OSC 9/777/99/BEL)을 받으면 알림함에 쌓고 토스트도 띄운다. P15-1 / P21-1
  manager.on('notify', (id, text) => {
    const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed())
    const title = manager.metaOf(id)?.title ?? ''
    inbox.add(id, title || '세션', text)
    notifier.notify({
      sessionId: id,
      sessionTitle: title || '세션',
      text,
      isActiveSession: id === activeSessionId,
      // 창이 없거나 숨겨져 있으면 포커스된 것이 아니다 — 트레이에 있을 때도 알려야 한다. P18-2
      windowFocused: win?.isVisible() === true && win.isFocused()
    })
  })

  ipcMain.handle(IPC.SET_ACTIVE, (_event, id: unknown) => {
    activeSessionId = typeof id === 'string' ? id : null
    return true
  })

  // 렌더러가 제어 요청에 답했다. P20-7
  ipcMain.handle(IPC.CTL_REPLY, (_event, id: unknown, ok: unknown, payload: unknown) => {
    if (typeof id !== 'number') return false
    bridge.settle(id, ok === true, payload)
    return true
  })

  ipcMain.handle(IPC.LOAD_LAYOUT, () => layout.load())

  ipcMain.handle(IPC.SAVE_LAYOUT, (_event, workspaces: unknown) => {
    if (!Array.isArray(workspaces)) return false
    layout.save(workspaces as Workspace[])
    return true
  })

  ipcMain.handle(IPC.LIST, () => manager.list())

  // 렌더러가 새로 붙었을 때 화면을 되살리기 위한 재생 데이터. P9-1
  ipcMain.handle(IPC.SNAPSHOT, (_event, id: unknown) =>
    typeof id === 'string' ? manager.snapshot(id) : null
  )

  ipcMain.handle(IPC.CREATE, (_event, options: unknown) => {
    const opts = (options ?? {}) as CreateSessionOptions
    return manager.create({
      cwd: typeof opts.cwd === 'string' ? opts.cwd : undefined,
      shell: typeof opts.shell === 'string' ? opts.shell : undefined,
      title: typeof opts.title === 'string' ? opts.title : undefined,
      cols: typeof opts.cols === 'number' ? opts.cols : undefined,
      rows: typeof opts.rows === 'number' ? opts.rows : undefined
    })
  })

  ipcMain.handle(IPC.CLOSE, (_event, id: unknown) =>
    typeof id === 'string' ? manager.close(id) : false
  )

  ipcMain.handle(IPC.RESTART, (_event, id: unknown) =>
    typeof id === 'string' ? manager.restart(id) : false
  )

  ipcMain.handle(IPC.WRITE, (_event, id: unknown, data: unknown) =>
    typeof id === 'string' && typeof data === 'string' ? manager.write(id, data) : false
  )

  ipcMain.handle(IPC.RESIZE, (_event, id: unknown, cols: unknown, rows: unknown) =>
    typeof id === 'string' && typeof cols === 'number' && typeof rows === 'number'
      ? manager.resize(id, cols, rows)
      : false
  )

  ipcMain.handle(IPC.SET_TITLE, (_event, id: unknown, title: unknown) =>
    typeof id === 'string' && (typeof title === 'string' || title === null)
      ? manager.setTitle(id, title)
      : false
  )

  /*
   * 세션을 보면 그 세션의 알림도 함께 읽음이 된다 (P21-5).
   *
   * 사이드바의 링과 알림함 배지가 따로 놀면 둘 중 하나는 거짓말이 된다.
   */
  ipcMain.handle(IPC.MARK_READ, (_event, id: unknown) => {
    if (typeof id !== 'string') return false
    inbox.markSessionRead(id)
    return manager.markRead(id)
  })

  ipcMain.handle(IPC.NOTIFICATIONS, () => inbox.list())

  ipcMain.handle(IPC.NOTIFICATION_READ, (_event, id: unknown) =>
    typeof id === 'string' ? inbox.markRead(id) : false
  )

  ipcMain.handle(IPC.NOTIFICATION_UNREAD, (_event, id: unknown) =>
    typeof id === 'string' ? inbox.setUnread(id) : false
  )

  ipcMain.handle(IPC.NOTIFICATION_DISMISS, (_event, id: unknown) =>
    typeof id === 'string' ? inbox.dismiss(id) : false
  )

  ipcMain.handle(IPC.NOTIFICATIONS_CLEAR, (_event, scope: unknown) => {
    if (scope === 'all') inbox.clear()
    else inbox.dismissRead()
    return true
  })

  /*
   * 클립보드 조회 (P7-4).
   *
   * 렌더러는 샌드박스 안이라 클립보드를 직접 읽지 못한다. 붙여넣기를 xterm의
   * 기본 동작에 맡기지 않고 여기까지 오는 이유는 P7-5에 있다 — 텍스트가 없는
   * 클립보드를 구분해야 하기 때문이다.
   */
  ipcMain.handle(IPC.READ_CLIPBOARD, () => {
    const text = clipboard.readText()
    // 이미지 여부는 텍스트가 없을 때만 따진다. readImage는 싸지 않다
    return { text, hasImage: text ? false : !clipboard.readImage().isEmpty() }
  })

  // 선택 영역 복사. 빈 문자열로 클립보드를 지우지는 않는다. P6-1
  ipcMain.handle(IPC.WRITE_CLIPBOARD, (_event, text: unknown) => {
    if (typeof text !== 'string' || !text) return false
    clipboard.writeText(text)
    return true
  })

  // 대용량 붙여넣기 확인. P7-3
  ipcMain.handle(IPC.CONFIRM_PASTE, async (event, bytes: unknown) => {
    if (typeof bytes !== 'number' || bytes < POLICY.PASTE_CONFIRM_BYTES) return true
    const win = BrowserWindow.fromWebContents(event.sender)
    const options = {
      type: 'question' as const,
      buttons: ['붙여넣기', '취소'],
      defaultId: 1,
      cancelId: 1,
      title: 'cvmux',
      message: `${Math.round(bytes / 1024)}KB를 붙여넣습니다.`,
      detail: '큰 내용을 터미널에 붙여넣으면 셸이 오래 멈출 수 있습니다. 계속할까요?'
    }
    const result = win
      ? await dialog.showMessageBox(win, options)
      : await dialog.showMessageBox(options)
    return result.response === 0
  })

  return bridge
}

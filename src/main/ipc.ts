import { BrowserWindow, clipboard, dialog, ipcMain } from 'electron'

import type { PtyManager } from '@core/pty-manager'
import { POLICY } from '@shared/policy'
import { CONTROL_BRIDGE_TIMEOUT_MS } from '@shared/protocol'
import { IPC, type CreateSessionOptions, type Workspace } from '@shared/types'
import type { ControlBridge } from './control-socket'
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
    if (ok) pending.resolve(payload)
    else pending.reject(new Error(typeof payload === 'string' ? payload : '요청을 처리하지 못했습니다'))
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
  layout: LayoutStore
): ControlBridge {
  const bridge = new RendererBridge()

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

  // 명시적 알림(OSC 9/777/99/BEL)을 받으면 데스크톱 토스트도 띄운다. P15-1
  manager.on('notify', (id, text) => {
    const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed())
    const title = manager.metaOf(id)?.title ?? ''
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

  ipcMain.handle(IPC.MARK_READ, (_event, id: unknown) =>
    typeof id === 'string' ? manager.markRead(id) : false
  )

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

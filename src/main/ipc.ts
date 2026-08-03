import { BrowserWindow, clipboard, dialog, ipcMain } from 'electron'

import type { PtyManager } from '@core/pty-manager'
import { POLICY } from '@shared/policy'
import { IPC, type CreateSessionOptions, type Workspace } from '@shared/types'
import type { Notifier } from './notifier'

/** pane 배치를 어디서 읽고 어디에 저장할지는 호출자(main/index.ts)가 결정한다. P17 */
export interface LayoutStore {
  load(): Workspace[]
  save(workspaces: Workspace[]): void
}

/**
 * IPC 배선 (P9).
 *
 * 렌더러의 요청은 여기서 PtyManager 호출로 바뀌고, PtyManager의 이벤트는
 * 여기서 렌더러로 내려간다.
 */
export function registerIpc(manager: PtyManager, notifier: Notifier, layout: LayoutStore): void {
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
}

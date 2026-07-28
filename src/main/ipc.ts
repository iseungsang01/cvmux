import { BrowserWindow, dialog, ipcMain } from 'electron'

import { POLICY } from '@shared/policy'
import { IPC, type CreateSessionOptions, type Workspace } from '@shared/types'
import type { Notifier } from './notifier'
import type { PtyManager } from './pty-manager'

/** 레이아웃은 렌더러가 소유하고 main은 저장만 한다. P17 */
export interface LayoutBridge {
  load(): Workspace[]
  save(workspaces: Workspace[]): void
}

/**
 * IPC 배선 (P9).
 *
 * 모든 핸들러는 예외를 던지지 않는다. 알 수 없는 세션 id, 죽은 PTY, 잘못된
 * 인자는 모두 `false`/`null`로 응답한다 — 렌더러를 죽이는 것보다 낫다(P1-9).
 */
export function registerIpc(manager: PtyManager, notifier: Notifier, layout: LayoutBridge): void {
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
    const meta = manager.metaOf(id)
    if (!meta) return
    const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed())
    notifier.notify({
      sessionId: id,
      sessionTitle: meta.title,
      text,
      isActiveSession: id === activeSessionId,
      windowFocused: win?.isFocused() ?? false
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

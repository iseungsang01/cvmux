import { BrowserWindow, clipboard, dialog, ipcMain } from 'electron'

import { RPC, RPC_EVENT } from '@core/protocol'
import { POLICY } from '@shared/policy'
import { IPC, type CreateSessionOptions } from '@shared/types'
import type { DaemonClient } from './daemon-client'
import type { Notifier } from './notifier'

/**
 * IPC 배선 (P9 / P20).
 *
 * 렌더러의 요청은 여기서 데몬으로 넘어가고, 데몬의 이벤트는 여기서 렌더러로
 * 내려간다. 앱은 세션을 소유하지 않으므로 이 파일이 하는 일은 중계와 검증뿐이다.
 *
 * 모든 핸들러는 예외를 던지지 않는다. 알 수 없는 세션 id, 죽은 PTY, 잘못된
 * 인자, 그리고 **데몬과의 연결이 끊긴 상황**까지 모두 `false`/`null`로
 * 응답한다 — 렌더러를 죽이는 것보다 낫다(P1-9 / P20-10).
 */
export function registerIpc(daemon: DaemonClient, notifier: Notifier): void {
  /** 사용자가 지금 보고 있는 세션. 토스트를 띄울지 판단에 쓴다. P15-2 */
  let activeSessionId: string | null = null

  const broadcast = (channel: string, ...args: unknown[]): void => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed() || win.webContents.isDestroyed()) continue
      win.webContents.send(channel, ...args)
    }
  }

  daemon.on(RPC_EVENT.DATA, (id: string, chunk: string) => broadcast(IPC.EVT_DATA, id, chunk))
  daemon.on(RPC_EVENT.META, (meta: unknown) => broadcast(IPC.EVT_META, meta))
  daemon.on(RPC_EVENT.EXIT, (info: unknown) => broadcast(IPC.EVT_EXIT, info))
  daemon.on(RPC_EVENT.CREATED, (meta: unknown) => broadcast(IPC.EVT_CREATED, meta))

  daemon.on(RPC_EVENT.CLOSED, (id: string) => {
    notifier.forget(id)
    broadcast(IPC.EVT_CLOSED, id)
  })

  // 명시적 알림(OSC 9/777/99/BEL)을 받으면 데스크톱 토스트도 띄운다. P15-1
  daemon.on(RPC_EVENT.NOTIFY, (id: string, text: string, title: string) => {
    const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed())
    notifier.notify({
      sessionId: id,
      sessionTitle: title || '세션',
      text,
      isActiveSession: id === activeSessionId,
      // 창이 없거나 숨겨져 있으면 포커스된 것이 아니다 — 트레이에 있을 때도 알려야 한다. P18-2
      windowFocused: win?.isVisible() === true && win.isFocused()
    })
  })

  /** 데몬 호출을 감싼다. 연결이 끊겨도 렌더러에는 조용한 실패로 보인다. P20-10 */
  const call = async <T>(method: string, fallback: T, ...params: unknown[]): Promise<T> => {
    try {
      return (await daemon.call(method, ...params)) as T
    } catch (error) {
      console.warn(`[cvmux] 데몬 호출 실패 (${method}):`, error)
      return fallback
    }
  }

  ipcMain.handle(IPC.SET_ACTIVE, (_event, id: unknown) => {
    activeSessionId = typeof id === 'string' ? id : null
    return true
  })

  ipcMain.handle(IPC.LOAD_LAYOUT, () => call(RPC.LOAD_LAYOUT, []))

  ipcMain.handle(IPC.SAVE_LAYOUT, (_event, workspaces: unknown) => {
    if (!Array.isArray(workspaces)) return false
    return call(RPC.SAVE_LAYOUT, false, workspaces)
  })

  ipcMain.handle(IPC.LIST, () => call(RPC.LIST, []))

  // 렌더러가 새로 붙었을 때 화면을 되살리기 위한 재생 데이터. P9-1
  ipcMain.handle(IPC.SNAPSHOT, (_event, id: unknown) =>
    typeof id === 'string' ? call(RPC.SNAPSHOT, null, id) : null
  )

  ipcMain.handle(IPC.CREATE, (_event, options: unknown) => {
    const opts = (options ?? {}) as CreateSessionOptions
    return call(
      RPC.CREATE,
      { ok: false, error: '세션을 만들지 못했습니다. 데몬에 연결되어 있지 않습니다.' },
      {
        cwd: typeof opts.cwd === 'string' ? opts.cwd : undefined,
        shell: typeof opts.shell === 'string' ? opts.shell : undefined,
        title: typeof opts.title === 'string' ? opts.title : undefined,
        cols: typeof opts.cols === 'number' ? opts.cols : undefined,
        rows: typeof opts.rows === 'number' ? opts.rows : undefined
      }
    )
  })

  ipcMain.handle(IPC.CLOSE, (_event, id: unknown) =>
    typeof id === 'string' ? call(RPC.CLOSE, false, id) : false
  )

  ipcMain.handle(IPC.RESTART, (_event, id: unknown) =>
    typeof id === 'string' ? call(RPC.RESTART, false, id) : false
  )

  ipcMain.handle(IPC.WRITE, (_event, id: unknown, data: unknown) =>
    typeof id === 'string' && typeof data === 'string' ? call(RPC.WRITE, false, id, data) : false
  )

  ipcMain.handle(IPC.RESIZE, (_event, id: unknown, cols: unknown, rows: unknown) =>
    typeof id === 'string' && typeof cols === 'number' && typeof rows === 'number'
      ? call(RPC.RESIZE, false, id, cols, rows)
      : false
  )

  ipcMain.handle(IPC.SET_TITLE, (_event, id: unknown, title: unknown) =>
    typeof id === 'string' && (typeof title === 'string' || title === null)
      ? call(RPC.SET_TITLE, false, id, title)
      : false
  )

  ipcMain.handle(IPC.MARK_READ, (_event, id: unknown) =>
    typeof id === 'string' ? call(RPC.MARK_READ, false, id) : false
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

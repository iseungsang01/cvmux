import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'

import {
  IPC,
  type CreateSessionOptions,
  type CreateSessionResult,
  type CvmuxApi,
  type SessionExitInfo,
  type SessionMeta,
  type SessionSnapshot
} from '@shared/types'

/**
 * 렌더러에 노출하는 유일한 통로 (P9-2).
 *
 * contextIsolation + sandbox 아래에서 동작하며, 여기 적힌 함수 외에는
 * 렌더러가 main에 닿을 방법이 없다. 채널명을 문자열로 받는 범용
 * `invoke(channel, ...)` 같은 것은 절대 노출하지 않는다.
 */
function subscribe<A extends unknown[]>(
  channel: string,
  cb: (...args: A) => void
): () => void {
  const listener = (_event: IpcRendererEvent, ...args: unknown[]): void => {
    cb(...(args as A))
  }
  ipcRenderer.on(channel, listener)
  return () => {
    ipcRenderer.off(channel, listener)
  }
}

const api: CvmuxApi = {
  list: () => ipcRenderer.invoke(IPC.LIST) as Promise<SessionMeta[]>,
  snapshot: (id) => ipcRenderer.invoke(IPC.SNAPSHOT, id) as Promise<SessionSnapshot | null>,
  create: (options?: CreateSessionOptions) =>
    ipcRenderer.invoke(IPC.CREATE, options ?? {}) as Promise<CreateSessionResult>,
  close: (id) => ipcRenderer.invoke(IPC.CLOSE, id) as Promise<boolean>,
  restart: (id) => ipcRenderer.invoke(IPC.RESTART, id) as Promise<boolean>,
  write: (id, data) => ipcRenderer.invoke(IPC.WRITE, id, data) as Promise<boolean>,
  resize: (id, cols, rows) => ipcRenderer.invoke(IPC.RESIZE, id, cols, rows) as Promise<boolean>,
  setTitle: (id, title) => ipcRenderer.invoke(IPC.SET_TITLE, id, title) as Promise<boolean>,
  markRead: (id) => ipcRenderer.invoke(IPC.MARK_READ, id) as Promise<boolean>,
  confirmPaste: (bytes) => ipcRenderer.invoke(IPC.CONFIRM_PASTE, bytes) as Promise<boolean>,
  setActive: (id) => ipcRenderer.invoke(IPC.SET_ACTIVE, id) as Promise<boolean>,

  onData: (cb) => subscribe<[string, string]>(IPC.EVT_DATA, cb),
  onMeta: (cb) => subscribe<[SessionMeta]>(IPC.EVT_META, cb),
  onExit: (cb) => subscribe<[SessionExitInfo]>(IPC.EVT_EXIT, cb),
  onClosed: (cb) => subscribe<[string]>(IPC.EVT_CLOSED, cb),
  onCreated: (cb) => subscribe<[SessionMeta]>(IPC.EVT_CREATED, cb),
  onActivate: (cb) => subscribe<[string]>(IPC.EVT_ACTIVATE, cb)
}

contextBridge.exposeInMainWorld('cvmux', api)

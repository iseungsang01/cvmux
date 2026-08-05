import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'

import {
  IPC,
  type BrowserMeta,
  type ClipboardContent,
  type ControlAsk,
  type CreateSessionOptions,
  type CvmuxConfig,
  type CreateSessionResult,
  type CvmuxApi,
  type Notification,
  type RestoredLayout,
  type SessionExitInfo,
  type SessionMeta,
  type SessionSnapshot,
  type UpdateState,
  type WorkspaceMeta
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
  newWindow: () => ipcRenderer.invoke(IPC.NEW_WINDOW) as Promise<string>,
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
  readClipboard: () => ipcRenderer.invoke(IPC.READ_CLIPBOARD) as Promise<ClipboardContent>,
  writeClipboard: (text) => ipcRenderer.invoke(IPC.WRITE_CLIPBOARD, text) as Promise<boolean>,
  setActive: (id) => ipcRenderer.invoke(IPC.SET_ACTIVE, id) as Promise<boolean>,
  loadLayout: () => ipcRenderer.invoke(IPC.LOAD_LAYOUT) as Promise<RestoredLayout>,
  saveLayout: (workspaces) => ipcRenderer.invoke(IPC.SAVE_LAYOUT, workspaces) as Promise<boolean>,
  controlReply: (id, ok, payload) =>
    ipcRenderer.invoke(IPC.CTL_REPLY, id, ok, payload) as Promise<boolean>,
  config: () => ipcRenderer.invoke(IPC.CONFIG) as Promise<CvmuxConfig>,
  updateState: () => ipcRenderer.invoke(IPC.UPDATE_STATE) as Promise<UpdateState>,
  updateCheck: () => ipcRenderer.invoke(IPC.UPDATE_CHECK) as Promise<UpdateState>,
  updateInstall: () => ipcRenderer.invoke(IPC.UPDATE_INSTALL) as Promise<boolean>,
  workspaceMeta: () =>
    ipcRenderer.invoke(IPC.WORKSPACE_META) as Promise<Record<string, WorkspaceMeta>>,
  todoAdd: (workspaceId, text) =>
    ipcRenderer.invoke(IPC.TODO_ADD, workspaceId, text) as Promise<boolean>,
  todoSetState: (workspaceId, ref, state) =>
    ipcRenderer.invoke(IPC.TODO_SET_STATE, workspaceId, ref, state) as Promise<boolean>,
  todoRemove: (workspaceId, ref) =>
    ipcRenderer.invoke(IPC.TODO_REMOVE, workspaceId, ref) as Promise<boolean>,
  browserCreate: (url) => ipcRenderer.invoke(IPC.BROWSER_CREATE, url) as Promise<BrowserMeta>,
  browserPlace: (id, rect) => ipcRenderer.invoke(IPC.BROWSER_PLACE, id, rect) as Promise<boolean>,
  browserClose: (id) => ipcRenderer.invoke(IPC.BROWSER_CLOSE, id) as Promise<boolean>,
  browserAction: (id, action) =>
    ipcRenderer.invoke(IPC.BROWSER_ACTION, id, action) as Promise<boolean>,
  browserList: () => ipcRenderer.invoke(IPC.BROWSER_LIST) as Promise<BrowserMeta[]>,
  notifications: () => ipcRenderer.invoke(IPC.NOTIFICATIONS) as Promise<Notification[]>,
  notificationRead: (id) => ipcRenderer.invoke(IPC.NOTIFICATION_READ, id) as Promise<boolean>,
  notificationUnread: (id) => ipcRenderer.invoke(IPC.NOTIFICATION_UNREAD, id) as Promise<boolean>,
  notificationDismiss: (id) => ipcRenderer.invoke(IPC.NOTIFICATION_DISMISS, id) as Promise<boolean>,
  notificationsClear: (scope) =>
    ipcRenderer.invoke(IPC.NOTIFICATIONS_CLEAR, scope) as Promise<boolean>,

  onData: (cb) => subscribe<[string, string]>(IPC.EVT_DATA, cb),
  onMeta: (cb) => subscribe<[SessionMeta]>(IPC.EVT_META, cb),
  onExit: (cb) => subscribe<[SessionExitInfo]>(IPC.EVT_EXIT, cb),
  onClosed: (cb) => subscribe<[string]>(IPC.EVT_CLOSED, cb),
  onCreated: (cb) => subscribe<[SessionMeta]>(IPC.EVT_CREATED, cb),
  onActivate: (cb) => subscribe<[string]>(IPC.EVT_ACTIVATE, cb),
  onControlRequest: (cb) => subscribe<[ControlAsk]>(IPC.EVT_CTL_REQUEST, cb),
  onNotifications: (cb) => subscribe<[Notification[]]>(IPC.EVT_NOTIFICATIONS, cb),
  onConfig: (cb) => subscribe<[CvmuxConfig]>(IPC.EVT_CONFIG, cb),
  onBrowser: (cb) => subscribe<[BrowserMeta]>(IPC.EVT_BROWSER, cb),
  onWorkspaceMeta: (cb) =>
    subscribe<[Record<string, WorkspaceMeta>]>(IPC.EVT_WORKSPACE_META, cb),
  onUpdate: (cb) => subscribe<[UpdateState]>(IPC.EVT_UPDATE, cb)
}

contextBridge.exposeInMainWorld('cvmux', api)

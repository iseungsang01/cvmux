import { homedir, release } from 'node:os'
import { join } from 'node:path'
import { BrowserWindow, app, dialog, shell } from 'electron'

import { POLICY } from '@shared/policy'
import { IPC } from '@shared/types'
import { registerIpc } from './ipc'
import { Notifier } from './notifier'
import { PtyManager } from './pty-manager'
import { SessionStore } from './store'

/**
 * 개발 중에는 앱을 띄운 디렉토리에서 첫 세션을 시작한다 — 터미널 앱의 관례이고,
 * git 정보도 바로 보인다. 패키징된 앱의 cwd는 설치 경로라 의미가 없으므로 홈을 쓴다.
 */
const manager = new PtyManager({
  defaultCwd: app.isPackaged ? homedir() : process.cwd()
})

/** 토스트를 클릭하면 창을 깨우고 그 세션으로 전환한다. P15-5 */
const notifier = new Notifier((sessionId) => {
  const win = mainWindow
  if (!win || win.isDestroyed()) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
  win.webContents.send(IPC.EVT_ACTIVATE, sessionId)
})

let mainWindow: BrowserWindow | null = null
let store: SessionStore | null = null
let persistTimer: NodeJS.Timeout | null = null
let persistDebounce: NodeJS.Timeout | null = null

/** 지금 즉시 저장. P16-1 */
function persistNow(): void {
  if (!store) return
  store.save({ version: 1, savedAt: Date.now(), sessions: manager.serialize() })
}

/** 세션을 여러 개 연달아 만들 때 매번 쓰지 않도록 묶는다 */
function schedulePersist(): void {
  if (persistDebounce !== null) return
  persistDebounce = setTimeout(() => {
    persistDebounce = null
    persistNow()
  }, 1000)
}
/** 종료 확인을 통과했는가 — close 핸들러의 재진입을 막는다. P10-1 */
let allowClose = false
let cleaningUp = false

/**
 * 처리되지 않은 예외로 앱 전체가 죽지 않게 한다 (P9-3).
 * 세션 하나가 잘못돼도 나머지 세션은 계속 돌아야 한다(P0-5).
 */
process.on('uncaughtException', (error) => {
  console.error('[cvmux] uncaught exception:', error)
})
process.on('unhandledRejection', (reason) => {
  console.error('[cvmux] unhandled rejection:', reason)
})

/** ConPTY는 Windows 10 1809(빌드 17763) 이상이 필요하다. P2-6 */
function conPtySupported(): boolean {
  if (process.platform !== 'win32') return true
  const build = Number.parseInt(release().split('.')[2] ?? '0', 10)
  return Number.isFinite(build) && build >= POLICY.MIN_WINDOWS_BUILD
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 760,
    minHeight: 440,
    show: false,
    backgroundColor: '#0d1016',
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#0d1016',
      symbolColor: '#7d8698',
      height: 36
    },
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      // 렌더러는 신뢰 경계 밖이다. P9-2
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      webviewTag: false
    }
  })

  mainWindow = win

  win.once('ready-to-show', () => win.show())

  // 외부 링크는 기본 브라우저로. 앱 내 내비게이션은 차단한다. P9-4
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => {
    if (url === win.webContents.getURL()) return
    event.preventDefault()
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
  })

  // 실행 중인 세션이 있으면 확인을 받는다. P10-1
  win.on('close', (event) => {
    if (allowClose) return
    const busy = manager.busyCount()
    if (busy === 0) return

    event.preventDefault()
    void dialog
      .showMessageBox(win, {
        type: 'question',
        buttons: ['그래도 종료', '취소'],
        defaultId: 1,
        cancelId: 1,
        title: 'cvmux',
        message: `${busy}개 세션이 실행 중입니다.`,
        detail: '종료하면 실행 중인 명령과 그 하위 프로세스가 모두 종료됩니다.'
      })
      .then(({ response }) => {
        if (response !== 0) return
        allowClose = true
        win.close()
      })
  })

  win.on('closed', () => {
    mainWindow = null
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// 두 번째 인스턴스는 기존 창을 깨우고 스스로 종료한다. P10-4
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })

  void app.whenReady().then(() => {
    if (!conPtySupported()) {
      dialog.showErrorBox(
        'cvmux를 실행할 수 없습니다',
        `이 앱은 ConPTY가 필요합니다 (Windows 10 1809 / 빌드 ${POLICY.MIN_WINDOWS_BUILD} 이상).\n` +
          `현재 시스템: ${release()}`
      )
      app.quit()
      return
    }

    // 이걸 설정하지 않으면 Windows가 토스트를 조용히 무시한다. P15-8
    app.setAppUserModelId('com.cvmux.app')

    store = new SessionStore(join(app.getPath('userData'), 'sessions.json'))
    const saved = store.load()

    registerIpc(manager, notifier)
    createWindow()

    /*
     * 창을 만든 직후, 렌더러가 로드되기 전에 복원한다. restore는 동기적이라
     * 렌더러의 첫 list() 호출에는 이미 복원된 세션이 담긴다. P16
     */
    if (saved !== null && saved.sessions.length > 0) {
      const restored = manager.restore(saved.sessions)
      console.log(`[cvmux] 세션 ${restored}개를 복원했습니다`)
    }

    // 주기 저장 + 세션이 생기거나 사라질 때 저장. P16-1
    persistTimer = setInterval(persistNow, POLICY.PERSIST_INTERVAL_MS)
    manager.on('created', schedulePersist)
    manager.on('closed', schedulePersist)

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })
}

app.on('window-all-closed', () => {
  app.quit()
})

/** 앱이 죽기 전에 모든 PTY 프로세스 트리를 정리한다. 고아 금지. P10-2 */
app.on('before-quit', (event) => {
  if (cleaningUp) return
  cleaningUp = true
  allowClose = true
  event.preventDefault()

  if (persistTimer !== null) {
    clearInterval(persistTimer)
    persistTimer = null
  }
  if (persistDebounce !== null) {
    clearTimeout(persistDebounce)
    persistDebounce = null
  }
  // 세션을 정리하기 전에 마지막으로 남긴다 — disposeAll이 목록을 비운다. P16-1
  persistNow()

  void manager.disposeAll().finally(() => {
    app.exit(0)
  })
})

import { writeFileSync } from 'node:fs'
import { release } from 'node:os'
import { join } from 'node:path'
import { BrowserWindow, app, dialog, shell } from 'electron'

import { RPC, RPC_EVENT } from '@core/protocol'
import { POLICY } from '@shared/policy'
import { IPC, type SessionMeta } from '@shared/types'
import { DaemonClient } from './daemon-client'
import { registerIpc } from './ipc'
import { Notifier } from './notifier'
import { createTray, type TrayController } from './tray'

/**
 * cvmux 앱 — 세션을 들여다보는 창 (POLICY.md P20).
 *
 * 세션은 여기 살지 않는다. 별도 프로세스인 데몬이 PTY를 들고 있고, 이 앱은
 * 붙었다 떨어지는 뷰어다. 그래서 앱을 완전히 종료해도 돌던 작업은 계속된다.
 */

/**
 * 로그인 직후 조용히 데몬만 세우는 모드 (P20-11).
 *
 * 창도 트레이도 만들지 않고, 데몬이 떴는지만 확인한 뒤 물러난다. 사용자가
 * 나중에 cvmux를 열면 세션이 이미 제자리에 있다.
 */
const daemonOnly = process.argv.includes('--daemon-only')

/** 토스트를 클릭하면 창을 깨우고 그 세션으로 전환한다. P15-5 / P18-2 */
const notifier = new Notifier((sessionId) => {
  showWindow()
  const win = mainWindow
  if (!win || win.isDestroyed()) return
  win.webContents.send(IPC.EVT_ACTIVATE, sessionId)
})

let mainWindow: BrowserWindow | null = null
let tray: TrayController | null = null
let daemon: DaemonClient | null = null

/** 트레이에 표시할 세션 수. 데몬 이벤트로만 갱신한다 */
let sessionCount = 0

/** 진짜로 끝내는 중인가 — close 핸들러가 창을 숨기지 않고 통과시킨다. P10-1 / P18-1 */
let quitting = false
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

/**
 * 창을 되살린다 (P18-3).
 *
 * 트레이 클릭, 토스트 클릭, 두 번째 인스턴스 실행이 모두 이 길로 온다 —
 * 창을 깨우는 방법이 세 군데로 갈라지면 하나가 조용히 어긋난다.
 */
function showWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow()
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

/** 실행 중인 세션을 죽여도 되는지 묻는다. P10-1 */
async function confirmQuit(busy: number, parent: BrowserWindow | null): Promise<boolean> {
  const options = {
    type: 'question' as const,
    buttons: ['그래도 종료', '취소'],
    defaultId: 1,
    cancelId: 1,
    title: 'cvmux',
    message: `${busy}개 세션이 실행 중입니다.`,
    detail: '종료하면 실행 중인 명령과 그 하위 프로세스가 모두 종료됩니다.'
  }
  const { response } =
    parent && !parent.isDestroyed()
      ? await dialog.showMessageBox(parent, options)
      : await dialog.showMessageBox(options)
  return response === 0
}

/**
 * 앱만 닫는다 (P20-6).
 *
 * 세션은 데몬에 남아 계속 돈다. 아무것도 죽지 않으므로 묻지 않는다 —
 * 다시 열면 있던 그대로다.
 */
function closeApp(): void {
  quitting = true
  app.quit()
}

/** 세션까지 전부 정리하고 끝낸다. 여기서만 돌던 작업이 사라진다. P18-4 / P20-6 */
function quitAll(): void {
  const finish = (): void => {
    quitting = true
    // 데몬에게 정리를 맡긴다. 응답을 기다리지 않는다 — 앱이 먼저 죽어도
    // 데몬은 자기 몫(프로세스 트리 정리)을 마치고 나간다. P10-2
    void daemon?.call(RPC.SHUTDOWN).catch(() => undefined)
    app.quit()
  }

  void daemon
    ?.call(RPC.BUSY_COUNT)
    .then((value) => {
      const busy = typeof value === 'number' ? value : 0
      if (busy === 0) {
        finish()
        return
      }
      // 무엇이 돌고 있는지 보여준 다음에 묻는다
      showWindow()
      void confirmQuit(busy, mainWindow).then((ok) => {
        if (ok) finish()
      })
    })
    .catch(finish)
}

// ── 로그인 자동 시작 (P20-11) ─────────────────────────────────

/**
 * 개발 중에는 손대지 않는다. `process.execPath`가 electron.exe라, 등록해두면
 * 로그인할 때마다 남의 프로젝트 폴더를 가리키는 항목이 뜬다.
 */
function autoStartAvailable(): boolean {
  return app.isPackaged && process.platform === 'win32'
}

function autoStartEnabled(): boolean {
  if (!autoStartAvailable()) return false
  return app.getLoginItemSettings({ path: process.execPath, args: ['--daemon-only'] }).openAtLogin
}

function setAutoStart(enabled: boolean): void {
  if (!autoStartAvailable()) return
  app.setLoginItemSettings({
    openAtLogin: enabled,
    path: process.execPath,
    // 창은 띄우지 않는다. 로그인하자마자 화면에 뭔가 튀어나오면 안 된다
    args: ['--daemon-only']
  })
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

  /*
   * 개발용 화면 캡처. CVMUX_CAPTURE에 파일 경로를 주면 창이 뜬 뒤 한 번 찍는다.
   *
   * Win32 PrintWindow로는 Chromium이 그린 내용을 잡지 못해 화면이 비어 보인다.
   * capturePage는 렌더러가 실제로 그린 픽셀을 주므로 검증에 쓸 수 있다.
   */
  const capturePath = process.env.CVMUX_CAPTURE
  if (capturePath) {
    setTimeout(() => {
      void win.webContents
        .capturePage()
        .then((image) => writeFileSync(capturePath, image.toPNG()))
        .catch((error: unknown) => console.error('[cvmux] 캡처 실패:', error))
    }, 9000)
  }

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

  win.on('close', (event) => {
    if (quitting) return

    /*
     * 창을 닫는 것은 앱을 끄는 것도, 세션을 끝내는 것도 아니다 (P18-1).
     *
     * 트레이로 물러날 뿐이다. 확인 대화상자를 띄우지 않는다 — 아무것도
     * 죽지 않으니 물을 것이 없다.
     */
    if (tray) {
      event.preventDefault()
      win.hide()
      return
    }

    // 트레이를 만들지 못한 환경에서는 창 닫기가 곧 앱 종료다. 그래도 세션은
    // 데몬에 남으므로 여기서도 묻지 않는다. P18-6 / P20-1
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

/** 데몬을 세우고 연결한다. 실패하면 사유를 보여주고 물러난다. P20-10 */
async function connectDaemon(): Promise<DaemonClient | null> {
  const client = new DaemonClient({
    // main/index.js 옆에 나란히 빌드된다
    entry: join(__dirname, 'daemon.js'),
    stateDir: app.getPath('userData')
  })

  try {
    await client.start()
    return client
  } catch (error) {
    console.error('[cvmux] 데몬에 연결하지 못했습니다:', error)
    return null
  }
}

// ── 기동 ─────────────────────────────────────────────────────

// 데몬만 세우는 실행은 락을 잡지 않는다. 곧 물러날 프로세스가 락을 쥐면
// 뒤이어 실행된 진짜 앱이 창을 띄우지 못한다
if (!daemonOnly && !app.requestSingleInstanceLock()) {
  // 두 번째 인스턴스는 기존 창을 깨우고 스스로 종료한다. P10-4
  app.quit()
} else {
  // 트레이에 숨어 있을 때 바로가기를 다시 눌러도 창이 돌아와야 한다. P10-4 / P18-5
  app.on('second-instance', showWindow)

  void app.whenReady().then(async () => {
    if (!conPtySupported()) {
      if (!daemonOnly) {
        dialog.showErrorBox(
          'cvmux를 실행할 수 없습니다',
          `이 앱은 ConPTY가 필요합니다 (Windows 10 1809 / 빌드 ${POLICY.MIN_WINDOWS_BUILD} 이상).\n` +
            `현재 시스템: ${release()}`
        )
      }
      app.exit(1)
      return
    }

    // 이걸 설정하지 않으면 Windows가 토스트를 조용히 무시한다. P15-8
    app.setAppUserModelId('com.cvmux.app')

    daemon = await connectDaemon()

    if (daemonOnly) {
      // 데몬이 섰으면 할 일은 끝났다. 데몬은 detached라 이 프로세스와 함께
      // 죽지 않는다(P20-2)
      console.log(daemon ? '[cvmux] 데몬을 세웠습니다' : '[cvmux] 데몬을 세우지 못했습니다')
      app.exit(daemon ? 0 : 1)
      return
    }

    if (!daemon) {
      dialog.showErrorBox(
        'cvmux를 실행할 수 없습니다',
        '세션을 관리하는 데몬에 연결하지 못했습니다.\n' +
          '잠시 후 다시 실행해 주세요. 문제가 계속되면 작업 관리자에서 남아 있는 cvmux 프로세스를 정리한 뒤 시도해 주세요.'
      )
      app.exit(1)
      return
    }

    // 트레이보다 먼저 세션 수를 맞춰둔다 — 첫 메뉴가 0개로 뜨지 않도록
    try {
      sessionCount = ((await daemon.call(RPC.LIST)) as SessionMeta[]).length
    } catch {
      sessionCount = 0
    }

    daemon.on(RPC_EVENT.CREATED, () => {
      sessionCount += 1
      tray?.refresh()
    })
    daemon.on(RPC_EVENT.CLOSED, () => {
      sessionCount = Math.max(0, sessionCount - 1)
      tray?.refresh()
    })

    /*
     * 데몬과의 연결이 끊겼다 (P20-10).
     *
     * 데몬이 죽었거나 파이프가 닫혔다. 세션은 이미 우리 손을 떠났으므로
     * 앱이 할 수 있는 일은 사용자에게 알리는 것뿐이다.
     */
    daemon.on('disconnect', () => {
      if (quitting) return
      console.error('[cvmux] 데몬과의 연결이 끊겼습니다')
      if (mainWindow && !mainWindow.isDestroyed()) {
        dialog.showMessageBox(mainWindow, {
          type: 'error',
          title: 'cvmux',
          message: '세션 데몬과의 연결이 끊겼습니다.',
          detail: 'cvmux를 다시 실행하면 남아 있는 세션에 다시 연결합니다.'
        })
      }
    })

    registerIpc(daemon, notifier)

    /*
     * 트레이는 창을 닫아도 앱이 살아있다는 유일한 표시다 (P18).
     *
     * 만들지 못하면 상주를 포기한다 — 트레이도 없고 창도 닫히지 않는 앱은
     * 작업 관리자로만 끌 수 있고, 그건 버그다(P18-6).
     */
    tray = createTray({
      show: showWindow,
      closeApp,
      quitAll,
      sessionCount: () => sessionCount,
      autoStart: autoStartAvailable() ? { enabled: autoStartEnabled, set: setAutoStart } : null
    })
    if (!tray) {
      console.warn('[cvmux] 트레이를 만들지 못했습니다. 창을 닫으면 앱이 종료됩니다. P18-6')
    }

    createWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })
}

app.on('window-all-closed', () => {
  // 트레이에 남아 있는 동안에는 창이 하나도 없어도 앱이 산다. P18-1
  if (tray) return
  app.quit()
})

/**
 * 앱이 나간다 (P20-1).
 *
 * 세션을 정리하지 않는다. 여기서 프로세스 트리를 죽이면 데몬을 둔 이유가
 * 사라진다 — 정리는 '세션까지 모두 종료'를 고른 경우에만, 데몬이 한다(P10-2).
 */
app.on('before-quit', () => {
  if (cleaningUp) return
  cleaningUp = true
  quitting = true

  tray?.destroy()
  tray = null
})

import { writeFileSync } from 'node:fs'
import { homedir, release } from 'node:os'
import { dirname, join } from 'node:path'
import { BrowserWindow, app, dialog, shell } from 'electron'

import { AgentSessionStore } from '@core/agent-sessions'
import { ConfigStore, type ConfigSnapshot } from '@core/config-store'
import { NotificationStore } from '@core/notifications'
import { WorkspaceMetaStore } from '@core/workspace-meta'
import { CLI_DIR_KEY, PtyManager } from '@core/pty-manager'
import { SessionStore, workspacesFromPersisted, workspacesToPersisted } from '@core/store'
import { POLICY } from '@shared/policy'
import { IPC, type Workspace } from '@shared/types'
import { BrowserManager } from './browser'
import { ControlSocketServer, type WindowControl, pipePathFor } from './control-socket'
import { WindowRegistry } from './windows'
import { UpdateManager } from './updater'
import { registerIpc } from './ipc'
import { Notifier } from './notifier'
import { createTray, type TrayController } from './tray'

/**
 * cvmux 앱 — 세션을 담고 있는 Electron 메인 프로세스.
 *
 * PTY는 이 프로세스 안에 산다. 창을 닫으면(X) 트레이로 물러날 뿐이지만, 앱이
 * 완전히 종료되면 세션도 함께 끝난다 — 앱의 수명이 곧 세션의 수명이다.
 */

/**
 * 개발 중에는 앱을 띄운 디렉토리에서 첫 세션을 시작한다 — 터미널 앱의 관례이고,
 * git 정보도 바로 보인다. 패키징된 앱의 cwd는 설치 경로라 의미가 없으므로 홈을 쓴다.
 */
const manager = new PtyManager({
  defaultCwd: app.isPackaged ? homedir() : process.cwd()
})

/** 토스트를 클릭하면 창을 깨우고 그 세션으로 전환한다. P15-5 / P18-2 */
const notifier = new Notifier((sessionId) => {
  // 그 세션이 있는 창을 깨운다 — 창이 여럿이면 아무 창이나 띄우면 안 된다. P27-4
  const target = windows.ofSession(sessionId) ?? windows.current()
  if (!target || target.win.isDestroyed()) {
    showWindow()
    return
  }
  reveal(target.win)
  target.win.webContents.send(IPC.EVT_ACTIVATE, sessionId)
})

/**
 * 창 레지스트리 (P27).
 *
 * `mainWindow` 하나로는 창을 여럿 띄울 수 없다. 세션은 여전히 앱 전체가 하나로
 * 들고 있고, 창이 갖는 것은 배치뿐이다.
 */
const windows = new WindowRegistry()
let tray: TrayController | null = null
let store: SessionStore | null = null
let control: ControlSocketServer | null = null
let persistTimer: NodeJS.Timeout | null = null
let persistDebounce: NodeJS.Timeout | null = null

/**
 * 앱 시작 시 복원한 창별 배치 (P27-5).
 *
 * 창이 뜨는 순서대로 하나씩 가져간다 — 렌더러는 자기가 몇 번째 창인지 모르고,
 * 알 필요도 없다.
 */
let restoredWindows: Workspace[][] = []

/**
 * 알림함 (P21).
 *
 * 바뀔 때마다 열려 있는 창에 통째로 내려보낸다. 200줄짜리 목록이라 부분
 * 갱신을 설계할 이유가 없고, 통째로 보내면 렌더러가 어긋난 상태를 들고 있을
 * 여지도 없다.
 */
const inbox = new NotificationStore(() => {
  const items = inbox.list()
  broadcast(IPC.EVT_NOTIFICATIONS, items)
  schedulePersist()
})

/**
 * 설정 (P22).
 *
 * 파일이 바뀌면 렌더러에 통째로 내려보낸다. 셸처럼 세션을 만들 때만 쓰이는
 * 값은 다음 세션부터 적용되고, 폰트·색·단축키는 그 자리에서 바뀐다(P22-4).
 */
const configStore = new ConfigStore((snapshot) => {
  broadcast(IPC.EVT_CONFIG, snapshot.config)
  for (const problem of snapshot.problems) {
    console.warn(`[cvmux] 설정 ${problem.path || '(최상위)'}: ${problem.message}`)
  }
})

/** 에이전트 대화 기록. 훅이 적고 복원이 읽는다. P22-8 */
const agentSessions = new AgentSessionStore()

/**
 * 사이드바 메타데이터 (P25).
 *
 * 에이전트가 소켓으로 적고 렌더러가 그린다. 저장하지 않는다 — 진행 중인 일에
 * 대한 기록이라, 앱을 껐다 켜면 그 일은 이미 끝났거나 처음부터 다시다.
 */
const workspaceMeta = new WorkspaceMetaStore(() => {
  broadcast(IPC.EVT_WORKSPACE_META, workspaceMeta.all())
})

/**
 * 자동 업데이트 (P26).
 *
 * 내려받기는 조용히, 설치는 다음에 끝낼 때. 터미널 워크스페이스에는 몇 시간짜리
 * 세션이 떠 있으므로 알아서 다시 켜는 앱은 그것을 전부 죽인다.
 */
const updater = new UpdateManager({
  onChange: (state) => {
    broadcast(IPC.EVT_UPDATE, state)
    tray?.refresh()
  },
  enabled: () => configStore.current.config.update.enabled
})

/**
 * 내장 브라우저 (P23).
 *
 * 화면은 창에 직접 얹히는 네이티브 뷰라 main이 들고 있다. 어디에 놓일지는
 * 렌더러가 알려 준다(P23-2).
 */
const browsers = new BrowserManager({
  // 브라우저 화면은 자기를 띄운 창에 얹힌다. P27-4
  window: (windowId) =>
    (windowId === null ? windows.current() : windows.get(windowId))?.win ?? null,
  onChange: (meta) => broadcast(IPC.EVT_BROWSER, meta)
})

function broadcast(channel: string, ...args: unknown[]): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed() || win.webContents.isDestroyed()) continue
    win.webContents.send(channel, ...args)
  }
}

/** 지금 즉시 저장. P16-1 / P17 / P21-8 */
function persistNow(): void {
  if (!store) return
  /*
   * 에이전트 대화를 세션에 붙여 저장한다 (P22-8).
   *
   * 세션 id는 복원 때 새로 발급되므로, 훅이 적어 둔 기록을 지금 세션 순서에
   * 맞춰 옮겨 적어야 다음에 짝을 지을 수 있다.
   */
  const order = manager.sessionOrder()
  const sessions = manager.serialize().map((session, i) => {
    const record = agentSessions.find(order[i])
    return record ? { ...session, agent: { name: record.agent, sessionId: record.agentSessionId } } : session
  })
  agentSessions.prune(order)

  store.save({
    version: 4,
    savedAt: Date.now(),
    sessions,
    // 세션을 순번으로 가리키므로 serialize()와 같은 순서를 넘겨야 한다
    windows: windows.list().map((entry) => ({
      workspaces: workspacesToPersisted(entry.layout, order)
    })),
    notifications: inbox.serialize()
  })
}

/** 세션을 여러 개 연달아 만들 때 매번 쓰지 않도록 묶는다 */
function schedulePersist(): void {
  if (persistDebounce !== null) return
  persistDebounce = setTimeout(() => {
    persistDebounce = null
    persistNow()
  }, 1000)
}

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
/**
 * 소켓이 보는 창 (P27-3).
 *
 * `WindowRegistry`를 그대로 넘기지 않고 좁혀서 넘긴다 — 소켓 서버는 Electron을
 * 모르는 채로 있어야 테스트가 그대로 불러 쓸 수 있다.
 */
function windowControl(): WindowControl {
  return {
    list: () =>
      windows.list().map((entry) => ({
        id: entry.id,
        current: windows.current()?.id === entry.id,
        focused: entry.win.isFocused(),
        minimized: entry.win.isMinimized(),
        visible: entry.win.isVisible(),
        workspaces: entry.layout.length,
        title: entry.win.getTitle()
      })),
    create: () => windows.spawn(),
    focus: (id) => {
      const entry = windows.get(id)
      if (!entry || entry.win.isDestroyed()) return false
      reveal(entry.win)
      return true
    },
    close: (id) => {
      const entry = windows.get(id)
      if (!entry || entry.win.isDestroyed()) return false
      entry.win.close()
      return true
    },
    current: () => windows.current()?.id ?? null,
    has: (id) => windows.get(id) !== null,
    ofWorkspace: (workspaceId) => windows.ofWorkspace(workspaceId)?.id ?? null
  }
}

function showWindow(): void {
  const entry = windows.current()
  if (!entry || entry.win.isDestroyed()) {
    createWindow()
    return
  }
  reveal(entry.win)
}

function reveal(win: BrowserWindow): void {
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
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
 * 트레이에서 앱을 완전히 끈다 (P18-4).
 *
 * 창이 숨겨진 채로 물을 수는 없다 — 무엇이 돌고 있는지 보여준 다음에 묻는다.
 */
function requestQuit(): void {
  const busy = manager.busyCount()
  if (busy === 0) {
    quitting = true
    app.quit()
    return
  }

  showWindow()
  void confirmQuit(busy, windows.current()?.win ?? null).then((ok) => {
    if (!ok) return
    quitting = true
    app.quit()
  })
}

/**
 * 업데이트를 지금 설치할지 묻는다 (P26-3).
 *
 * 설치는 앱을 끄고 설치 프로그램을 띄운다 — 실행 중인 세션이 전부 끝난다.
 * 종료와 같은 무게의 일이므로 종료와 같은 방식으로 묻는다(P10-1).
 */
async function confirmInstall(): Promise<void> {
  const state = updater.current
  if (state.status !== 'ready') return

  showWindow()
  const busy = manager.busyCount()
  const { response } = await dialog.showMessageBox({
    type: 'question',
    buttons: ['지금 설치', '나중에'],
    defaultId: 1,
    cancelId: 1,
    title: 'cvmux',
    message: `${state.version} 버전이 준비됐습니다.`,
    detail:
      busy > 0
        ? `설치하면 앱이 종료되고 실행 중인 세션 ${busy}개가 함께 끝납니다.`
        : '설치하면 앱이 종료되었다가 새 버전으로 다시 시작합니다.'
  })
  if (response !== 0) return

  quitting = true
  updater.install()
}

function createWindow(): BrowserWindow {
  const pending = restoredWindows.shift() ?? []

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

  /*
   * 창은 여기서 이름을 얻는다 (P27-2).
   *
   * 렌더러에게는 알려 주지 않는다 — 어느 창이 보낸 요청인지는 main이
   * `event.sender`로 되짚는다. 렌더러가 실어 보내게 하면 위조할 수 있는 값이
   * 하나 늘고, 그것으로 다른 창의 배치를 덮어쓸 수 있다.
   */
  windows.add(win, pending)

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
     * 여러 창 중 하나를 닫는 것은 그냥 닫는 것이다 (P27-8).
     *
     * 트레이로 물러나는 것은 **마지막 창**의 이야기다. 창이 둘 남았는데 하나를
     * 닫았다고 숨겨 버리면, 사람이 정리했다고 생각한 창이 보이지 않는 채로
     * 계속 살아 있게 된다.
     */
    if (windows.size > 1) return

    /*
     * 창을 닫는 것은 앱을 끄는 것이 아니다 (P18-1).
     *
     * 세션은 계속 돌고 앱은 트레이로 물러난다. 확인 대화상자도 여기서 띄우지
     * 않는다 — 아무것도 죽이지 않으니 물을 것이 없다. 종료 확인은 트레이의
     * '종료'로 옮겼다(P18-4).
     */
    if (tray) {
      event.preventDefault()
      win.hide()
      return
    }

    // 트레이를 만들지 못한 환경에서는 창 닫기가 곧 종료다. P10-1 / P18-6
    const busy = manager.busyCount()
    if (busy === 0) return
    event.preventDefault()
    void confirmQuit(busy, win).then((ok) => {
      if (!ok) return
      quitting = true
      win.close()
    })
  })

  /*
   * 창을 닫아도 세션은 살아 있다 (P18-1 / P27-1).
   *
   * 레지스트리에서 빠지는 것은 `closed` 이벤트가 알아서 한다. 다만 그 창이
   * 들고 있던 배치는 사라지므로, 마지막 창이 아니면 저장본에서도 빠진다 —
   * 그 워크스페이스의 세션은 여전히 살아 있고 `cvmux list-sessions`에 보인다.
   */
  win.on('closed', () => schedulePersist())

  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return win
}

// 두 번째 인스턴스는 기존 창을 깨우고 스스로 종료한다. P10-4
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  // 트레이에 숨어 있을 때 바로가기를 다시 눌러도 창이 돌아와야 한다. P10-4 / P18-5
  app.on('second-instance', showWindow)

  // 화면과 소켓이 "창 하나 더"를 부를 수 있게 만드는 법을 맡겨 둔다. P27-3
  windows.setFactory(() => {
    const win = createWindow()
    return windows.ofWebContents(win.webContents.id)?.id ?? ''
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

    /*
     * 설정을 가장 먼저 읽는다 (P22).
     *
     * 셸과 스크롤백 같은 값은 세션을 만들 때 필요하고, 세션 복원은 곧
     * 뒤따른다. 설정 파일이 없으면 주석이 달린 본보기를 만들어 둔다 —
     * 빈 파일을 주면 무엇을 쓸 수 있는지 알 길이 없다(P22-1).
     */
    configStore.load()
    configStore.ensureFile()
    configStore.watchFiles()
    manager.setDefaults(configStore.current.config)

    agentSessions.load()

    store = new SessionStore(join(app.getPath('userData'), 'sessions.json'))
    const saved = store.load()
    // 알림함은 세션보다 먼저 되살린다 — 복원한 세션의 알림이 이미 자리에 있어야 한다
    if (saved) inbox.restore(saved.notifications)

    const bridge = registerIpc(
      manager,
      notifier,
      {
        /*
         * 배치는 창마다 따로다 (P27-5).
         *
         * 어느 창이 묻는지는 IPC 핸들러가 `event.sender`로 되짚는다 — 렌더러가
         * 자기 id를 실어 보내게 하면 위조할 수 있는 값이 하나 늘어난다.
         */
        load: (windowId) => windows.get(windowId)?.layout ?? [],
        save: (windowId, workspaces) => {
          windows.setLayout(windowId, workspaces)
          // 사라진 워크스페이스의 메타데이터는 함께 치운다. P25
          workspaceMeta.prune(windows.allWorkspaces().map((w) => w.id))
          schedulePersist()
        }
      },
      inbox,
      () => configStore.current.config,
      browsers,
      workspaceMeta,
      updater,
      windows
    )

    /*
     * 제어 소켓을 세션보다 먼저 연다 (P20-3).
     *
     * 주소가 세션 환경에 실려야 하므로 복원보다 앞서야 한다. 소켓을 열지 못해도
     * 앱은 계속 뜬다 — CLI가 없다고 터미널까지 못 쓸 이유는 없다(P20-1).
     */
    const userData = app.getPath('userData')
    control = new ControlSocketServer(
      {
        manager,
        bridge,
        inbox,
        browsers,
        meta: workspaceMeta,
        layout: () => windows.allWorkspaces(),
        windows: windowControl(),
        updater,
        showWindow,
        reloadConfig: (): ConfigSnapshot => {
          const snapshot = configStore.reload()
          manager.setDefaults(snapshot.config)
          return snapshot
        },
        version: app.getVersion()
      },
      pipePathFor(userData),
      join(userData, 'control.json')
    )
    control.start()
    updater.start()

    /*
     * 세션 안에서 `cvmux`가 보이게 한다 (P20-1).
     *
     * 설치본에서는 셸이 실행 파일 옆에, 개발 중에는 저장소의 bin/ 에 있다.
     */
    const cliDir = app.isPackaged ? dirname(app.getPath('exe')) : join(app.getAppPath(), 'bin')
    manager.setSessionEnv({ ...control.env, [CLI_DIR_KEY]: cliDir })

    /*
     * 창을 만들기 **전에** 세션을 복원한다 (P16 / P27-5).
     *
     * restore는 동기적이라 렌더러의 첫 list() 호출에는 이미 복원된 세션이
     * 담긴다. 창이 여럿이면 배치도 창 수만큼 나눠 두었다가 하나씩 건넨다.
     */
    if (saved !== null && saved.sessions.length > 0) {
      const ids = manager.restore(saved.sessions)
      restoredWindows = saved.windows.map((entry) =>
        workspacesFromPersisted(entry.workspaces, ids)
      )
      const count = ids.filter((id) => id !== null).length
      const total = restoredWindows.reduce((n, list) => n + list.length, 0)
      console.log(
        `[cvmux] 세션 ${count}개, 워크스페이스 ${total}개를 창 ${restoredWindows.length}개에 복원했습니다`
      )
    }

    // 창을 하나도 복원하지 않았어도 앱은 창 하나로 시작한다
    const windowCount = Math.max(1, restoredWindows.length)
    for (let i = 0; i < windowCount; i++) createWindow()

    /*
     * 트레이는 창을 닫아도 앱이 살아있다는 유일한 표시다 (P18).
     *
     * 만들지 못하면 상주를 포기한다 — 트레이도 없고 창도 닫히지 않는 앱은
     * 작업 관리자로만 끌 수 있고, 그건 버그다(P18-6).
     */
    tray = createTray({
      show: showWindow,
      quit: requestQuit,
      sessionCount: () => manager.list().length,
      // 트레이는 창을 닫아 둔 사람에게 갱신을 알리는 유일한 자리다. P26-2
      updateState: () => updater.current,
      installUpdate: () => void confirmInstall()
    })
    if (!tray) {
      console.warn('[cvmux] 트레이를 만들지 못했습니다. 창을 닫으면 앱이 종료됩니다. P18-6')
    }

    // 주기 저장 + 세션이 생기거나 사라질 때 저장. P16-1
    persistTimer = setInterval(persistNow, POLICY.PERSIST_INTERVAL_MS)
    manager.on('created', () => {
      schedulePersist()
      tray?.refresh()
    })
    manager.on('closed', () => {
      schedulePersist()
      tray?.refresh()
    })

    app.on('activate', () => {
      if (windows.size === 0) createWindow()
    })
  })
}

app.on('window-all-closed', () => {
  // 트레이에 남아 있는 동안에는 창이 하나도 없어도 앱이 산다. P18-1
  if (tray) return
  app.quit()
})

/** 앱이 죽기 전에 모든 PTY 프로세스 트리를 정리한다. 고아 금지. P10-2 */
app.on('before-quit', (event) => {
  if (cleaningUp) return
  cleaningUp = true
  quitting = true
  event.preventDefault()

  tray?.destroy()
  tray = null

  // 파이프와 접속 정보를 남기지 않는다 — 꺼진 앱을 가리키는 주소는 거짓말이다. P20-2
  control?.stop()
  control = null

  // 네이티브 뷰는 창보다 오래 살 수 있다. 앱이 끝나기 전에 거둔다. P23-2
  browsers.closeAll()
  updater.dispose()

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

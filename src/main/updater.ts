import { app } from 'electron'
import electronUpdater, { type UpdateInfo } from 'electron-updater'

import type { UpdateState } from '@shared/types'

/**
 * 자동 업데이트 (POLICY.md P26).
 *
 * cmux는 Sparkle로 갱신하고 사용자는 한 번만 내려받으면 된다. cvmux는
 * `electron-updater`로 **GitHub 릴리스**를 본다 — 저장소가 공개라 별도 서버가
 * 필요 없고, 태그를 밀면 CI가 설치 파일과 `latest.yml`을 올린다(P26-6).
 *
 * 규칙 하나: **업데이트가 하던 일을 끊지 않는다.** 터미널 워크스페이스에는
 * 몇 시간짜리 세션이 떠 있다. 알아서 다시 켜는 앱은 그것을 전부 죽인다 —
 * 그래서 내려받기만 조용히 하고, 설치는 **다음에 끝낼 때** 한다(P26-3).
 */

/*
 * electron-updater는 CommonJS다.
 *
 * ESM으로 번들되는 main에서 이름 있는 import를 쓰면 런타임에 undefined가 된다.
 * 기본 내보내기에서 꺼내야 한다.
 */
const { autoUpdater } = electronUpdater

export interface UpdaterHost {
  /** 상태가 바뀌었다 — 트레이와 렌더러가 따라와야 한다 */
  onChange(state: UpdateState): void
  /** 지금 켜져 있는가. 설정에서 끌 수 있다. P26-5 */
  enabled(): boolean
}

/** 처음 확인까지의 여유. 앱이 뜨자마자 네트워크를 잡으면 시작이 느려 보인다 */
const FIRST_CHECK_MS = 20_000

/** 그 뒤로는 이 주기로 본다. 하루에 몇 번이면 충분하다 */
const INTERVAL_MS = 6 * 60 * 60 * 1000

export class UpdateManager {
  private state: UpdateState = { status: 'idle', version: null, notes: null, error: null, percent: 0 }
  private timer: NodeJS.Timeout | null = null
  private firstTimer: NodeJS.Timeout | null = null

  constructor(private readonly host: UpdaterHost) {
    /*
     * 내려받기만 자동, 설치는 수동 (P26-3).
     *
     * `autoInstallOnAppQuit`를 켜 두면 사용자가 트레이에서 끄는 순간 설치가
     * 시작된다. 그건 "끄기"를 누른 사람이 기대한 일이 아니다 — 설치는 우리가
     * 명시적으로 부를 때만 한다.
     */
    autoUpdater.autoDownload = true
    autoUpdater.autoInstallOnAppQuit = false
    // 로그는 앱 콘솔로. 갱신이 조용히 실패하면 원인을 찾을 길이 없다
    autoUpdater.logger = {
      info: (m: unknown) => console.log('[cvmux][update]', m),
      warn: (m: unknown) => console.warn('[cvmux][update]', m),
      error: (m: unknown) => console.error('[cvmux][update]', m),
      debug: () => {}
    }

    autoUpdater.on('checking-for-update', () => this.set({ status: 'checking', error: null }))
    autoUpdater.on('update-not-available', () => this.set({ status: 'current', error: null }))

    autoUpdater.on('update-available', (info: UpdateInfo) =>
      this.set({
        status: 'downloading',
        version: info.version,
        notes: typeof info.releaseNotes === 'string' ? info.releaseNotes : null,
        percent: 0,
        error: null
      })
    )

    autoUpdater.on('download-progress', (progress: { percent: number }) =>
      this.set({ status: 'downloading', percent: Math.round(progress.percent) })
    )

    autoUpdater.on('update-downloaded', (info: UpdateInfo) =>
      this.set({ status: 'ready', version: info.version, percent: 100, error: null })
    )

    autoUpdater.on('error', (error: Error) =>
      /*
       * 갱신 실패는 앱의 실패가 아니다 (P26-4).
       *
       * 오프라인이거나 GitHub이 잠깐 답하지 않는 것뿐일 때가 대부분이다.
       * 사유는 남기되 대화상자로 막아서지 않는다.
       */
      this.set({ status: 'error', error: error.message })
    )
  }

  get current(): UpdateState {
    return this.state
  }

  /**
   * 주기 확인을 시작한다 (P26-1).
   *
   * 개발 중에는 아무것도 하지 않는다 — 설치되지 않은 앱에는 갱신할 대상이 없고,
   * `latest.yml`을 찾다 실패하는 오류만 콘솔에 쌓인다.
   */
  start(): void {
    if (!app.isPackaged) {
      this.set({ status: 'disabled', error: '개발 빌드에서는 확인하지 않습니다' })
      return
    }

    this.firstTimer = setTimeout(() => {
      this.firstTimer = null
      void this.check()
    }, FIRST_CHECK_MS)

    this.timer = setInterval(() => void this.check(), INTERVAL_MS)
  }

  async check(manual = false): Promise<UpdateState> {
    if (!app.isPackaged) {
      this.set({ status: 'disabled', error: '개발 빌드에서는 확인하지 않습니다' })
      return this.state
    }
    if (!this.host.enabled() && !manual) {
      // 껐어도 사용자가 직접 부르면 본다 — 끈 것은 자동 확인이지 기능이 아니다
      this.set({ status: 'disabled', error: null })
      return this.state
    }

    try {
      await autoUpdater.checkForUpdates()
    } catch (error) {
      this.set({ status: 'error', error: error instanceof Error ? error.message : String(error) })
    }
    return this.state
  }

  /**
   * 지금 설치한다 (P26-3).
   *
   * 앱을 끄고 설치 프로그램을 띄운다. **실행 중인 세션이 전부 끝나므로**
   * 부르는 쪽이 먼저 사용자에게 물어야 한다 — 여기서는 묻지 않는다.
   */
  install(): boolean {
    if (this.state.status !== 'ready') return false
    setImmediate(() => autoUpdater.quitAndInstall(false, true))
    return true
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer)
    if (this.firstTimer) clearTimeout(this.firstTimer)
    this.timer = null
    this.firstTimer = null
  }

  private set(patch: Partial<UpdateState>): void {
    this.state = { ...this.state, ...patch }
    this.host.onChange(this.state)
  }
}

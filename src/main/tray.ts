import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Menu, Tray, app, nativeImage, type NativeImage } from 'electron'

/**
 * 트레이 상주 (P18).
 *
 * 창을 닫아도 앱이 계속 돌게 하려면 **나갈 길이 눈에 보여야 한다**. 트레이
 * 아이콘이 그 역할이다 — 앱이 아직 살아있다는 표시이자, 앱을 완전히 끄는
 * 유일한 곳이다(P18-1 / P18-4).
 *
 * 아이콘을 만들지 못하면 null을 돌려준다. 그때는 호출자가 상주를 포기하고
 * 예전처럼 "창 닫기 = 종료"로 되돌려야 한다. 끌 방법이 없는 앱을 남기지
 * 않는다(P18-6).
 */

export interface TrayHandlers {
  /** 창을 되살린다 */
  show(): void
  /** 앱만 닫는다. 세션은 데몬에 남아 계속 돈다. P20-1 */
  closeApp(): void
  /** 세션까지 모두 정리하고 끝낸다. 실행 중 세션 확인은 호출자가 한다. P18-4 */
  quitAll(): void
  /** 메뉴와 툴팁에 표시할 현재 세션 수 */
  sessionCount(): number
  /** 로그인 자동 시작 토글. 쓸 수 없는 환경(개발 중 등)이면 null. P20-11 */
  autoStart: { enabled(): boolean; set(value: boolean): void } | null
}

export interface TrayController {
  /** 세션 수가 바뀌었을 때 메뉴·툴팁을 다시 그린다 */
  refresh(): void
  destroy(): void
}

/**
 * 트레이 아이콘을 읽는다.
 *
 * `createFromPath`가 아니라 버퍼로 읽는 이유가 있다. 패키징된 앱에서 이
 * 파일은 asar 아카이브 안에 있는데, asar를 확실히 이해하는 것은 Node의
 * `readFileSync` 쪽이다.
 */
function loadIcon(): NativeImage | null {
  try {
    const buffer = readFileSync(join(app.getAppPath(), 'build', 'icon.png'))
    const image = nativeImage.createFromBuffer(buffer)
    if (image.isEmpty()) return null
    // Windows 트레이는 16px 기준이다. 원본을 그대로 주면 흐리게 뭉개진다
    return image.resize({ width: 16, height: 16 })
  } catch (error) {
    console.warn('[cvmux] 트레이 아이콘을 읽지 못했습니다:', error)
    return null
  }
}

export function createTray(handlers: TrayHandlers): TrayController | null {
  const icon = loadIcon()
  if (!icon) return null

  let tray: Tray
  try {
    tray = new Tray(icon)
  } catch (error) {
    // 셸 확장이 없는 환경 등 — 상주를 포기하고 호출자가 폴백한다. P18-6
    console.warn('[cvmux] 트레이 아이콘을 만들지 못했습니다:', error)
    return null
  }

  const refresh = (): void => {
    if (tray.isDestroyed()) return
    const count = handlers.sessionCount()
    const label = count === 0 ? '열려 있는 세션 없음' : `세션 ${count}개`

    const { autoStart } = handlers

    tray.setToolTip(`cvmux — ${label}`)
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: 'cvmux 열기', click: () => handlers.show() },
        { type: 'separator' },
        // 상태를 알리는 줄이지 누를 것이 아니다
        { label, enabled: false },
        { type: 'separator' },
        // 켜두면 로그인 직후 세션이 제자리를 잡아둔다. P20-11
        ...(autoStart
          ? ([
              {
                label: '로그인할 때 세션 미리 준비',
                type: 'checkbox' as const,
                checked: autoStart.enabled(),
                click: (item: { checked: boolean }) => {
                  autoStart.set(item.checked)
                  refresh()
                }
              },
              { type: 'separator' as const }
            ] as const)
          : []),
        /*
         * 끝내는 방법을 두 갈래로 나눈다 (P20-6).
         *
         * 창을 치우는 것과 작업을 끝내는 것은 다른 결정이다. 하나로 묶어두면
         * 잠깐 정리하려던 사람이 돌던 빌드까지 함께 날린다. 무엇이 사라지고
         * 무엇이 남는지 메뉴 문구에 그대로 적는다.
         */
        { label: '창 닫기 (세션은 계속 실행)', click: () => handlers.closeApp() },
        { label: '세션까지 모두 종료', click: () => handlers.quitAll() }
      ])
    )
  }

  // Windows에서 트레이 아이콘을 한 번 누르는 것은 "열어라"라는 뜻이다
  tray.on('click', () => handlers.show())
  tray.on('double-click', () => handlers.show())

  refresh()

  return {
    refresh,
    destroy: () => {
      if (!tray.isDestroyed()) tray.destroy()
    }
  }
}

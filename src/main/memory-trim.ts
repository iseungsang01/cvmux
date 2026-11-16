import { app, BrowserWindow } from 'electron'

/**
 * 아무도 보고 있지 않을 때 working set을 비운다 (P8-9).
 *
 * 작업 관리자의 "메모리"는 private working set — 지금 RAM에 올라 있는 몫이다.
 * cvmux는 창을 트레이로 숨겨 두고 몇 시간씩 세션만 돌리는 앱이라, 그동안 쥔
 * 페이지 대부분은 아무도 건드리지 않는다. 창에서 포커스가 떠나면 잠시 뒤
 * cvmux의 모든 프로세스(main·GPU·렌더러·유틸리티)에 `EmptyWorkingSet`을 부른다.
 * 페이지는 대기 목록으로 물러나 다른 프로그램이 쓸 수 있게 되고, 다시 건드리면
 * 디스크까지 가지 않고 곧바로 돌아온다(soft fault).
 *
 * 숨어 있는 동안에도 셸 출력은 렌더러의 스크롤백을 건드리므로 주기적으로 다시
 * 비운다. 할당(commit) 자체는 그대로다 — 줄어드는 것은 RAM 점유다.
 */

/** 포커스가 떠난 뒤 첫 비우기까지 — 알트탭으로 잠깐 다녀오는 데에는 손대지 않는다 */
const FIRST_TRIM_MS = 10_000

/** 그 뒤로는 이 주기로 다시 비운다 */
const REPEAT_TRIM_MS = 60_000

const PROCESS_SET_QUOTA = 0x0100
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000

type TrimFn = (pid: number) => void

/** koffi는 처음 비울 때 올린다. 못 올리면 비우기를 접는다 — 앱은 멀쩡하다 */
function loadTrimmer(): TrimFn | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const koffi = require('koffi') as typeof import('koffi')
    const kernel32 = koffi.load('kernel32.dll')
    const OpenProcess = kernel32.func('void* __stdcall OpenProcess(uint32 access, int inherit, uint32 pid)')
    const EmptyWorkingSet = kernel32.func('int __stdcall K32EmptyWorkingSet(void* process)')
    const CloseHandle = kernel32.func('int __stdcall CloseHandle(void* handle)')
    return (pid) => {
      const handle = OpenProcess(PROCESS_SET_QUOTA | PROCESS_QUERY_LIMITED_INFORMATION, 0, pid)
      if (!handle) return
      try {
        EmptyWorkingSet(handle)
      } finally {
        CloseHandle(handle)
      }
    }
  } catch (error) {
    console.warn('[cvmux] working set을 비울 수 없습니다:', error)
    return null
  }
}

export function startMemoryTrim(): void {
  if (process.platform !== 'win32') return

  let trimmer: TrimFn | null | undefined
  let timer: NodeJS.Timeout | null = null

  const trimAll = (): void => {
    if (trimmer === undefined) trimmer = loadTrimmer()
    if (!trimmer) return
    for (const metric of app.getAppMetrics()) trimmer(metric.pid)
  }

  const tick = (): void => {
    timer = null
    if (BrowserWindow.getFocusedWindow()) return
    trimAll()
    if (trimmer) timer = setTimeout(tick, REPEAT_TRIM_MS)
  }

  const cancel = (): void => {
    if (timer !== null) clearTimeout(timer)
    timer = null
  }

  // 포커스는 창 사이를 옮겨 다니며 잠깐 비므로, 판정은 타이머가 돌 때 한다
  app.on('browser-window-blur', () => {
    cancel()
    timer = setTimeout(tick, FIRST_TRIM_MS)
  })
  app.on('browser-window-focus', cancel)
  app.on('before-quit', cancel)

  // 창이 처음부터 숨은 채로(트레이) 뜨는 경우도 있다
  timer = setTimeout(tick, FIRST_TRIM_MS)
}

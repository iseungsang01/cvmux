import type { RelayMode, SessionStatus } from '@shared/types'

/**
 * 옆 pane의 에이전트에게 답을 넘긴다 (POLICY.md P29).
 *
 * 분할선의 ⇄를 켜 두면, 한쪽 에이전트가 턴을 끝낼 때 훅이 넘겨준 마지막 답변을
 * 옆 에이전트의 입력창에 붙여 넣고 보낸다. 화면을 긁지 않는다 — 에이전트가
 * 직접 말해 준 답이라 테두리도 스피너도 섞이지 않는다(P29-1).
 *
 * 연결 자체(누가 누구에게 보내는가)는 세션의 속성이라 PtyManager가 들고,
 * 여기서는 언제 어떻게 넣을지만 정한다.
 */

export interface RelayHost {
  /** 이 세션의 답을 받는 세션 */
  targetOf(id: string): string | null
  setTarget(id: string, target: string | null): void
  statusOf(id: string): SessionStatus | null
  /** 셸 통합이 알려 준 대로, 프롬프트가 아니라 명령이 돌고 있는가. P29-4 */
  inCommand(id: string): boolean
  write(id: string, data: string): void
  notify(id: string, text: string): void
}

/** 받는 쪽이 입력창에서 기다리는 상태 */
const READY: ReadonlySet<SessionStatus> = new Set(['idle', 'waiting'])

/** 붙여 넣은 뒤 Enter를 보내기까지. 붙여넣기를 다 받기 전에 Enter가 오면 줄바꿈으로 먹힌다 */
const SUBMIT_DELAY_MS = 150

/**
 * 넣어 준 턴이 끝났다는 소식이 끝내 오지 않을 때 (P29-5).
 *
 * 받는 쪽에 훅이 없으면 Stop이 오지 않는다. 그때는 상태가 풀린 것을 보고
 * 끝났다고 치는데, 넣자마자는 아직 일을 시작하기 전이라 상태가 한가해 보인다.
 * 이 시간이 지나기 전의 한가함은 믿지 않는다.
 */
const SETTLE_MS = 3000

/** 한 번에 넘기는 글자 수. 넘치면 뒤를 자르고 잘랐다고 적는다 */
const MAX_CHARS = 50_000

export function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`
}

/**
 * 사람이 친 키인가 (P29-6).
 *
 * 렌더러가 보내는 것에는 xterm이 스스로 답하는 제어 시퀀스(포커스 보고, 장치
 * 속성 응답)도 섞여 있다. 에이전트 TUI는 포커스 보고를 켜 두므로, 이것까지
 * 사람 입력으로 세면 pane을 클릭만 해도 핑퐁 횟수가 되돌려진다.
 */
export function isHumanInput(data: string): boolean {
  const stripped = TERMINAL_REPLIES.reduce((rest, pattern) => rest.replace(pattern, ''), data)
  return stripped.length > 0
}

/** 터미널이 스스로 보내는 응답. 방향키 같은 키 입력은 여기 들지 않는다 */
const TERMINAL_REPLIES: RegExp[] = [
  /\x1b\[[IO]/g, // 포커스 보고
  /\x1b\[[?>]?[\d;]*c/g, // 장치 속성 응답
  /\x1b\[\d+;\d+R/g, // 커서 위치 응답
  /\x1b\[\?[\d;]*\$y/g, // 모드 질의 응답
  /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g // OSC 응답 (색 질의 등)
]

export class Relay {
  /** 짝마다 사람 손 없이 이어진 자동 전달 수 */
  private readonly streaks = new Map<string, number>()
  /** 받는 쪽이 바빠 기다리는 것들 */
  private readonly queued = new Map<string, string[]>()
  /** 넣어 준 것을 아직 처리 중인 세션과 넣은 시각 */
  private readonly handling = new Map<string, number>()
  /**
   * 턴을 끝냈고 그 뒤로 새 턴이 시작되지 않은 세션 (P29-5).
   *
   * Stop 훅은 "응답을 마쳤습니다" 알림도 함께 보내 상태를 '확인 필요'로 올린다.
   * 권한을 묻느라 멈춘 '확인 필요'와 겉모습이 같으므로, 턴이 끝났다는 것을 따로
   * 기억해 둔다 — 권한 질문에 붙여 넣으면 엉뚱한 선택지를 고르게 된다.
   */
  private readonly finished = new Set<string>()

  constructor(
    private readonly host: RelayHost,
    private maxAutoTurns = 10,
    private readonly schedule: (fn: () => void, ms: number) => void = (fn, ms) => {
      setTimeout(fn, ms)
    },
    private readonly now: () => number = Date.now
  ) {}

  setMaxAutoTurns(value: number): void {
    this.maxAutoTurns = value
  }

  /** a가 왼쪽(위), b가 오른쪽(아래)일 때의 방향. P29-2 */
  modeOf(a: string, b: string): RelayMode {
    const forward = this.host.targetOf(a) === b
    const backward = this.host.targetOf(b) === a
    return forward && backward ? 'both' : forward ? 'forward' : backward ? 'backward' : 'off'
  }

  setMode(a: string, b: string, mode: RelayMode): void {
    if (a === b) return
    const forward = mode === 'forward' || mode === 'both'
    const backward = mode === 'backward' || mode === 'both'
    // 이 짝이 아닌 연결은 건드리지 않는다 — 다른 칸으로 보내던 것을 끊으면 안 된다
    if (forward) this.host.setTarget(a, b)
    else if (this.host.targetOf(a) === b) this.host.setTarget(a, null)
    if (backward) this.host.setTarget(b, a)
    else if (this.host.targetOf(b) === a) this.host.setTarget(b, null)
    // 사람이 손을 댔으니 처음부터 센다
    this.streaks.delete(pairKey(a, b))
    if (mode === 'off') {
      this.queued.delete(a)
      this.queued.delete(b)
    }
  }

  /**
   * 한 세션의 에이전트가 턴을 끝냈다 (P29-1).
   *
   * @param text 훅이 넘겨준 마지막 답변. 비었으면 넘길 것이 없다
   */
  turnComplete(from: string, text: string, agent: string | null): void {
    // 이 세션은 넣어 준 것을 다 처리했다 — 기다리던 것이 있으면 이제 넣는다
    this.handling.delete(from)
    this.finished.add(from)
    this.flush(from)

    const to = this.host.targetOf(from)
    const body = text.trim()
    if (!to || !body) return

    const key = pairKey(from, to)
    const count = (this.streaks.get(key) ?? 0) + 1
    if (count > this.maxAutoTurns) {
      // 두 방향 모두 끈다 — 한쪽만 끄면 남은 쪽이 다시 불을 붙인다. P29-6
      this.setMode(from, to, 'off')
      const message = `자동 전달이 사람 입력 없이 ${this.maxAutoTurns}번 이어져 멈췄습니다`
      this.host.notify(from, message)
      this.host.notify(to, message)
      return
    }
    this.streaks.set(key, count)
    this.deliver(to, format(agent, body))
  }

  /** 렌더러에서 온 입력. 사람이 끼어들었으면 핑퐁 횟수를 되돌린다. P29-6 */
  noteInput(id: string, data: string): void {
    if (!isHumanInput(data)) return
    // 사람이 새 턴을 열었을 수 있다 — 이제부터의 '확인 필요'는 권한 질문일 수 있다
    this.finished.delete(id)
    for (const key of [...this.streaks.keys()]) {
      if (key.split('|').includes(id)) this.streaks.delete(key)
    }
  }

  /** 상태가 바뀌었다 — 훅이 없는 받는 쪽은 이것으로 턴이 끝났다고 본다. P29-5 */
  statusChanged(id: string): void {
    const since = this.handling.get(id)
    if (since !== undefined) {
      const status = this.host.statusOf(id)
      if (this.now() - since < SETTLE_MS || !status || !READY.has(status)) return
      this.handling.delete(id)
    }
    this.flush(id)
  }

  /** 세션이 닫혔다 */
  forget(id: string): void {
    this.queued.delete(id)
    this.handling.delete(id)
    this.noteInput(id, 'x')
  }

  private deliver(to: string, text: string): void {
    /*
     * 셸에 붙여 넣지 않는다 (P29-4).
     *
     * 받는 쪽 에이전트가 끝나 프롬프트로 돌아와 있으면, 넘긴 답이 PowerShell
     * 명령으로 실행된다. 셸 통합이 없어 알 수 없을 때도 넣지 않는다.
     */
    if (!this.host.inCommand(to)) {
      this.host.notify(to, '옆 에이전트의 답을 받지 못했습니다 — 이 세션에서 에이전트가 돌고 있지 않습니다')
      return
    }
    if (this.handling.has(to) || this.busy(to)) {
      const list = this.queued.get(to) ?? []
      list.push(text)
      this.queued.set(to, list)
      return
    }
    this.paste(to, text)
  }

  private flush(id: string): void {
    const list = this.queued.get(id)
    if (!list?.length || this.handling.has(id) || this.busy(id)) return
    if (!this.host.inCommand(id)) {
      this.queued.delete(id)
      return
    }
    this.queued.delete(id)
    this.paste(id, list.join('\n\n'))
  }

  private busy(id: string): boolean {
    const status = this.host.statusOf(id)
    if (status && READY.has(status)) return false
    return !(status === 'attention' && this.finished.has(id))
  }

  /**
   * bracketed paste로 한 덩어리를 넣고 Enter는 따로 보낸다 (P29-3).
   *
   * 여러 줄을 그냥 흘리면 에이전트 입력창이 첫 줄바꿈에서 제출해 버린다.
   */
  private paste(to: string, text: string): void {
    this.handling.set(to, this.now())
    this.finished.delete(to)
    this.host.write(to, `\x1b[200~${text}\x1b[201~`)
    this.schedule(() => this.host.write(to, '\r'), SUBMIT_DELAY_MS)
  }
}

/** 받는 에이전트가 누가 보낸 것인지 알게 머리를 붙인다 */
function format(agent: string | null, text: string): string {
  const body = text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS)}\n\n(… 길어서 뒤를 잘랐습니다)` : text
  return `[cvmux] 옆 pane의 ${agent ?? '에이전트'}가 보낸 답변입니다:\n\n${body}`
}

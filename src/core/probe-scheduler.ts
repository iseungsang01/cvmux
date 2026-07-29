import { join } from 'node:path'
import { Worker } from 'node:worker_threads'

import { POLICY } from '@shared/policy'
import type { GitInfo } from '@shared/types'

/**
 * git·포트 조사의 주기를 관리한다 (P13-6 / P14-5 ~ P14-12).
 *
 * 두 조사 모두 외부 프로세스를 띄우므로 공짜가 아니다. 그래서
 *   - 세션이 하나도 없으면 타이머를 아예 걸지 않고(P14-6),
 *   - 전부 유휴면 주기를 15초로 늘리고(P14-11),
 *   - 조사 자체는 워커에게 맡긴다(P14-12).
 *
 * 마지막 항목이 핵심이다. 프로세스 생성은 부르는 스레드의 이벤트 루프를
 * 붙잡으므로, 데몬의 메인 루프에서 돌리면 그 동안 PTY 입출력이 멎는다.
 * 여기서는 타이머와 결과 반영만 맡고, 실제 조사는 `probe-worker`가 한다.
 */

export interface ProbeTarget {
  id: string
  pid: number | null
  cwd: string
  alive: boolean
  busy: boolean
}

export interface ProbePatch {
  git?: GitInfo | null
  ports?: number[]
}

/** 메인 → 워커 */
export type ProbeRequest =
  | { type: 'probe'; seq: number; targets: ProbeTarget[] }
  | { type: 'forget'; cwd: string }

/** 워커 → 메인 */
export interface ProbeResult {
  seq: number
  patches: Array<{ id: string; patch: ProbePatch }>
}

/** 데몬 진입점 옆에 나란히 빌드된다 */
const WORKER_ENTRY = join(__dirname, 'probe-worker.js')

/**
 * 워커 응답을 기다리는 한도.
 *
 * 한 주기가 쓸 수 있는 최악의 시간(netstat 5초 + 프로세스 트리 10초, git은
 * 저장소마다 3초)보다 넉넉해야 멀쩡한 조사를 오해하지 않는다.
 */
const RESPONSE_TIMEOUT_MS = 30_000

/** 이만큼 연달아 실패하면 조사를 접는다 — 터미널 기능 자체는 멀쩡하다 */
const MAX_WORKER_FAILURES = 3

export class ProbeScheduler {
  private timer: NodeJS.Timeout | null = null
  private stopped = false
  /** 조사가 진행 중인가 — 겹쳐 도는 tick이 서로의 요청을 덮어쓰지 않게 한다. P14-7 */
  private running = false
  /** 조사 중에 깨우라는 요청이 왔다 — 끝나는 대로 한 번 더 돈다 */
  private wakeAgain = false
  private worker: Worker | null = null
  private workerFailures = 0
  private seq = 0
  private pending: {
    seq: number
    resolve: (result: ProbeResult | null) => void
    timer: NodeJS.Timeout
  } | null = null

  constructor(
    private readonly listTargets: () => ProbeTarget[],
    private readonly apply: (id: string, patch: ProbePatch) => void
  ) {}

  /**
   * 세션이 생기거나 상태가 바뀌었을 때 호출 — 잠들어 있으면 깨운다.
   *
   * 조사 중에는 타이머가 비어 있다(tick이 스스로를 지웠으므로). 그 틈에 새
   * tick을 걸면 둘이 겹쳐 돌면서 서로의 요청을 덮어쓰고, 버려진 요청은 응답을
   * 영영 못 받아 워커가 죽은 것처럼 보인다. 그래서 진행 중이면 표시만 남긴다.
   */
  wake(delay = 0): void {
    if (this.stopped) return
    if (this.running) {
      this.wakeAgain = true
      return
    }
    if (this.timer !== null) return
    this.schedule(delay)
  }

  /** 작업 디렉토리가 바뀌었다 — 캐시를 버리고 즉시 다시 본다. P13-7 */
  invalidateCwd(cwd: string): void {
    this.worker?.postMessage({ type: 'forget', cwd } as ProbeRequest)
    this.wake(0)
  }

  stop(): void {
    this.stopped = true
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.settlePending(null)
    this.disposeWorker()
  }

  private schedule(delay: number): void {
    this.timer = setTimeout(() => {
      this.timer = null
      void this.tick()
    }, delay)
  }

  private async tick(): Promise<void> {
    if (this.stopped || this.running) return

    this.running = true
    try {
      const targets = this.listTargets().filter((t) => t.alive)
      // 볼 세션이 없으면 다음 타이머를 걸지 않는다. wake()가 다시 깨울 것이다. P14-6
      if (targets.length === 0) return

      const result = await this.request(targets)
      if (this.stopped) return

      // 워커를 띄우지 못했다면 타이머를 다시 걸지 않는다 — wake()가 재시도한다. P14-12
      if (result === null && this.worker === null) return
      if (result) {
        for (const { id, patch } of result.patches) this.apply(id, patch)
      }

      // 조사 중에 들어온 요청이 있으면 기다리지 않고 한 번 더 돈다
      if (this.wakeAgain) {
        this.schedule(0)
        return
      }
      // busy가 하나라도 있으면 자주, 전부 유휴면 뜸하게. P14-11
      const anyBusy = targets.some((t) => t.busy)
      this.schedule(anyBusy ? POLICY.PROBE_INTERVAL_BUSY_MS : POLICY.PROBE_INTERVAL_IDLE_MS)
    } finally {
      this.running = false
      this.wakeAgain = false
    }
  }

  private request(targets: ProbeTarget[]): Promise<ProbeResult | null> {
    const worker = this.ensureWorker()
    if (!worker) return Promise.resolve(null)

    // 앞선 요청이 남아 있으면 버린다 — 기다리는 응답은 언제나 하나뿐이다
    this.settlePending(null)

    const seq = ++this.seq
    return new Promise<ProbeResult | null>((resolve) => {
      const timer = setTimeout(() => {
        this.pending = null
        // 응답이 없는 워커는 버린다. 다음 주기에 새로 띄운다.
        this.failWorker('프로브 워커가 응답하지 않습니다')
        resolve(null)
      }, RESPONSE_TIMEOUT_MS)

      this.pending = { seq, resolve, timer }
      worker.postMessage({ type: 'probe', seq, targets } as ProbeRequest)
    })
  }

  private ensureWorker(): Worker | null {
    if (this.worker) return this.worker
    if (this.workerFailures >= MAX_WORKER_FAILURES) return null

    try {
      const worker = new Worker(WORKER_ENTRY)
      // 조사가 데몬의 수명을 붙잡지 않게 한다 — 세션이 주인이다
      worker.unref()
      worker.on('message', (result: ProbeResult) => this.settle(result))
      // 이미 교체된 워커의 뒤늦은 이벤트는 무시한다
      worker.on('error', (error: Error) => {
        if (this.worker === worker) this.failWorker(error.message)
      })
      worker.on('exit', () => {
        if (this.worker === worker) this.failWorker('프로브 워커가 종료되었습니다')
      })
      this.worker = worker
      return worker
    } catch (error) {
      this.workerFailures++
      console.warn(
        '[cvmux] 프로브 워커를 띄우지 못했습니다:',
        error instanceof Error ? error.message : String(error)
      )
      return null
    }
  }

  private settle(result: ProbeResult): void {
    const pending = this.pending
    // 버려진 주기의 뒤늦은 응답은 무시한다
    if (!pending || pending.seq !== result.seq) return
    this.pending = null
    clearTimeout(pending.timer)
    this.workerFailures = 0 // 멀쩡히 답했다
    pending.resolve(result)
  }

  private failWorker(reason: string): void {
    this.workerFailures++
    this.disposeWorker()
    this.settlePending(null)
    // 첫 실패부터 남긴다 — 조용히 삼키면 기능이 사라진 줄도 모른다
    console.warn(`[cvmux] 프로브 워커 실패 ${this.workerFailures}/${MAX_WORKER_FAILURES}: ${reason}`)
    if (this.workerFailures >= MAX_WORKER_FAILURES) {
      // 조사만 접는다. 터미널은 그대로 돈다. P14-4
      console.warn('[cvmux] 주변 정보 조사를 중단합니다')
    }
  }

  private disposeWorker(): void {
    const worker = this.worker
    this.worker = null
    if (worker) void worker.terminate()
  }

  private settlePending(result: ProbeResult | null): void {
    const pending = this.pending
    if (!pending) return
    this.pending = null
    clearTimeout(pending.timer)
    pending.resolve(result)
  }
}

/** 메타 변경 여부 판단용 — 같으면 IPC를 보내지 않는다 */
export function gitInfoEqual(a: GitInfo | null, b: GitInfo | null): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return (
    a.repo === b.repo &&
    a.root === b.root &&
    a.branch === b.branch &&
    a.detached === b.detached &&
    a.dirty === b.dirty &&
    a.ahead === b.ahead &&
    a.behind === b.behind &&
    a.operation === b.operation
  )
}

export function portsEqual(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

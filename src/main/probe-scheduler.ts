import { POLICY } from '@shared/policy'
import type { GitInfo } from '@shared/types'
import { GitProbe } from './git-probe'
import { PortProbe } from './port-probe'

/**
 * git·포트 조사의 주기를 관리한다 (P13-6 / P14-5 ~ P14-11).
 *
 * 두 조사 모두 외부 프로세스를 띄우므로 공짜가 아니다. 그래서
 *   - 세션이 하나도 없으면 타이머를 아예 걸지 않고(P14-6),
 *   - 전부 유휴면 주기를 15초로 늘리고(P14-11),
 *   - 같은 작업 디렉토리를 쓰는 세션은 git 조사를 한 번만 한다.
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

export class ProbeScheduler {
  private readonly git = new GitProbe()
  private readonly ports = new PortProbe()
  private timer: NodeJS.Timeout | null = null
  private stopped = false

  constructor(
    private readonly listTargets: () => ProbeTarget[],
    private readonly apply: (id: string, patch: ProbePatch) => void
  ) {}

  /** 세션이 생기거나 상태가 바뀌었을 때 호출 — 잠들어 있으면 깨운다 */
  wake(delay = 0): void {
    if (this.stopped || this.timer !== null) return
    this.schedule(delay)
  }

  /** 작업 디렉토리가 바뀌었다 — 캐시를 버리고 즉시 다시 본다. P13-7 */
  invalidateCwd(cwd: string): void {
    this.git.forget(cwd)
    this.wake(0)
  }

  stop(): void {
    this.stopped = true
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  private schedule(delay: number): void {
    this.timer = setTimeout(() => {
      this.timer = null
      void this.tick()
    }, delay)
  }

  private async tick(): Promise<void> {
    if (this.stopped) return

    const targets = this.listTargets().filter((t) => t.alive)
    // 볼 세션이 없으면 다음 타이머를 걸지 않는다. wake()가 다시 깨울 것이다. P14-6
    if (targets.length === 0) return

    await Promise.all([this.probePorts(targets), this.probeGit(targets)])

    if (this.stopped) return
    // busy가 하나라도 있으면 자주, 전부 유휴면 뜸하게. P14-11
    const anyBusy = targets.some((t) => t.busy)
    this.schedule(anyBusy ? POLICY.PROBE_INTERVAL_BUSY_MS : POLICY.PROBE_INTERVAL_IDLE_MS)
  }

  private async probePorts(targets: ProbeTarget[]): Promise<void> {
    if (!this.ports.enabled) return
    // 스냅샷은 한 번, 결과는 모든 세션이 나눠 쓴다. P14-5
    await this.ports.refresh()
    for (const target of targets) {
      if (target.pid === null) continue
      this.apply(target.id, { ports: this.ports.portsFor(target.pid) })
    }
  }

  private async probeGit(targets: ProbeTarget[]): Promise<void> {
    if (!this.git.enabled) return

    // 같은 디렉토리를 보는 세션들은 결과를 공유한다 — git status를 중복 실행할 이유가 없다
    const byCwd = new Map<string, ProbeTarget[]>()
    for (const target of targets) {
      const list = byCwd.get(target.cwd)
      if (list) list.push(target)
      else byCwd.set(target.cwd, [target])
    }

    await Promise.all(
      [...byCwd.entries()].map(async ([cwd, group]) => {
        const info = await this.git.probe(group[0].id, cwd)
        // null은 "저장소가 아님"과 "이번엔 실패"를 모두 뜻한다. 후자여도
        // 다음 주기에 복구되므로 그대로 반영한다. P13-1 / P13-5
        for (const target of group) this.apply(target.id, { git: info })
      })
    )
  }
}

/** 메타 변경 여부 판단용 — 같으면 IPC를 보내지 않는다 */
export function gitInfoEqual(a: GitInfo | null, b: GitInfo | null): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return (
    a.repo === b.repo &&
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

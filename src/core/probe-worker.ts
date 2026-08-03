import { parentPort } from 'node:worker_threads'

import { GitProbe } from './git-probe'
import { PortProbe } from './port-probe'
import type { ProbePatch, ProbeRequest, ProbeResult, ProbeTarget } from './probe-scheduler'

/**
 * 주변 정보 조사를 도맡는 워커 (POLICY.md P14-12).
 *
 * git·포트 조사는 외부 프로세스를 띄운다. `execFile`은 비동기 얼굴을 하고
 * 있지만 프로세스 생성 자체(`uv_spawn` → `CreateProcess`)는 부르는 스레드의
 * 이벤트 루프를 붙잡는다. 실측하면 git 하나가 88ms, 서로 다른 작업 디렉토리
 * 아홉 개를 한꺼번에 띄우면 1.7초가 통째로 멈춘다.
 *
 * 그 멈춤이 메인 프로세스의 이벤트 루프에서 일어나면 PTY 입출력도 함께 멎는다 —
 * 사용자가 친 키가 그 동안 셸에 닿지 못하고, 루프가 풀리는 순간 밀린 입력이
 * 한꺼번에 쏟아진다. "한 자리에서 타이핑되다 갑자기 밀려 나오는" 증상의 정체가 이것이다.
 *
 * 그래서 조사는 전부 여기서 돈다. 막히는 것은 이 워커의 루프뿐이고, 메인 프로세스는
 * 키 입력과 화면 출력에만 전념한다. 같은 실측에서 메인 스레드 정지는
 * 1659ms에서 14ms로 떨어졌다.
 */

/** 한 주기가 이보다 오래 걸리면 로그를 남긴다 */
const SLOW_CYCLE_MS = 8000

const port = parentPort
if (!port) throw new Error('probe-worker는 워커 스레드에서만 돌 수 있다')

const git = new GitProbe()
const ports = new PortProbe()

/** 한 세션에 git·포트 결과가 따로 도착하므로 한 장으로 합쳐 보낸다 */
function merge(patches: Map<string, ProbePatch>, id: string, patch: ProbePatch): void {
  const existing = patches.get(id)
  if (existing) Object.assign(existing, patch)
  else patches.set(id, { ...patch })
}

async function probePorts(
  targets: ProbeTarget[],
  patches: Map<string, ProbePatch>
): Promise<void> {
  if (!ports.enabled) return
  // 스냅샷은 한 번, 결과는 모든 세션이 나눠 쓴다. P14-5
  // 일이 돌아가는 중이면 프로세스 트리를 자주 다시 뜬다. P14-13
  await ports.refresh(targets.some((t) => t.busy))
  for (const target of targets) {
    if (target.pid === null) continue
    // 포트와 셸은 같은 스냅샷에서 나온다 — 조사를 두 번 하지 않는다. P14-13
    merge(patches, target.id, {
      ports: ports.portsFor(target.pid),
      shells: ports.shellsFor(target.pid)
    })
  }
}

async function probeGit(targets: ProbeTarget[], patches: Map<string, ProbePatch>): Promise<void> {
  if (!git.enabled) return

  // 같은 디렉토리를 보는 세션들은 결과를 공유한다 — git status를 중복 실행할 이유가 없다
  const byCwd = new Map<string, ProbeTarget[]>()
  for (const target of targets) {
    const list = byCwd.get(target.cwd)
    if (list) list.push(target)
    else byCwd.set(target.cwd, [target])
  }

  await Promise.all(
    [...byCwd.entries()].map(async ([cwd, group]) => {
      const info = await git.probe(group[0].id, cwd)
      // null은 "저장소가 아님"과 "이번엔 실패"를 모두 뜻한다. 후자여도
      // 다음 주기에 복구되므로 그대로 반영한다. P13-1 / P13-5
      for (const target of group) merge(patches, target.id, { git: info })
    })
  )
}

port.on('message', (message: ProbeRequest) => {
  if (message.type === 'forget') {
    git.forget(message.cwd) // P13-7
    return
  }

  void (async () => {
    const patches = new Map<string, ProbePatch>()
    const startedAt = Date.now()
    let portsMs = 0
    let gitMs = 0
    try {
      await Promise.all([
        (async () => {
          const t = Date.now()
          await probePorts(message.targets, patches)
          portsMs = Date.now() - t
        })(),
        (async () => {
          const t = Date.now()
          await probeGit(message.targets, patches)
          gitMs = Date.now() - t
        })()
      ])
    } catch {
      // 조사 실패는 이번 주기를 거르는 것으로 충분하다 — 다음 주기에 복구된다
    }
    // 한 주기가 유난히 길면 남긴다 — 조용히 느려지는 것이 가장 잡기 어렵다
    const elapsed = Date.now() - startedAt
    if (elapsed >= SLOW_CYCLE_MS) {
      console.warn(
        `[cvmux] 주변 정보 조사가 느립니다: 세션 ${message.targets.length}개, 포트 ${portsMs}ms, git ${gitMs}ms, 총 ${elapsed}ms`
      )
    }
    const result: ProbeResult = {
      seq: message.seq,
      patches: [...patches.entries()].map(([id, patch]) => ({ id, patch }))
    }
    port.postMessage(result)
  })()
})

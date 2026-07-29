import { execFile } from 'node:child_process'
import { join } from 'node:path'

import { POLICY } from '@shared/policy'

/**
 * 세션이 리슨 중인 포트 감지 (POLICY.md P14).
 *
 * 비용 실측이 설계를 정했다:
 *   netstat -ano             65ms
 *   WMI 프로세스 열거        292ms
 *   Get-NetTCPConnection    1288ms  ← 쓰지 않는다
 *
 * 그래서 포트 목록은 매 주기 netstat으로 갱신하고, 비싼 프로세스 트리는
 * LISTEN 중인 PID 집합이 바뀌었을 때만 다시 뜬다(P14-10).
 *
 * 이 프로세스 트리는 "따로 도는 셸"에도 그대로 쓰인다(P14-13). 열거에
 * 이름 한 칸을 더 얹는 비용은 실측상 0이었다 — 265ms로 같다.
 */

const POWERSHELL = join(
  process.env.SystemRoot ?? 'C:\\Windows',
  'System32',
  'WindowsPowerShell',
  'v1.0',
  'powershell.exe'
)

/** Windows FILETIME(1601년 기준 100ns) → epoch ms. 알 수 없으면 0 */
function fileTimeToMs(raw: string): number {
  const ticks = Number(raw)
  if (!Number.isFinite(ticks) || ticks <= 0) return 0
  return ticks / 10_000 - 11_644_473_600_000
}

function run(command: string, args: string[], timeout: number): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      { windowsHide: true, timeout, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' },
      (error, stdout) => resolve(error ? null : stdout)
    )
  })
}

interface PortMap {
  /** pid → 리슨 포트 집합 */
  byPid: Map<number, Set<number>>
  /** 리슨 중인 PID 전체 — 트리를 다시 뜰지 판단하는 서명에 쓴다 */
  pids: Set<number>
}

/**
 * `netstat -ano` 출력을 파싱한다.
 *
 * 상태 문자열("LISTENING")은 한글 Windows에서 번역되므로 신뢰하지 않는다.
 * 대신 외부 주소가 `0.0.0.0:0` / `[::]:0` 인 행이 곧 LISTEN이라는 사실을 쓴다 —
 * 이 판별은 로케일과 무관하다.
 */
function parseNetstat(output: string): PortMap {
  const byPid = new Map<number, Set<number>>()
  const pids = new Set<number>()

  for (const raw of output.split('\n')) {
    const parts = raw.trim().split(/\s+/)
    if (parts.length < 4) continue
    if (parts[0].toUpperCase() !== 'TCP') continue

    const remote = parts[2]
    if (remote !== '0.0.0.0:0' && remote !== '[::]:0') continue

    const pid = Number.parseInt(parts[parts.length - 1], 10)
    if (!Number.isFinite(pid) || pid <= 0) continue

    const local = parts[1]
    const colon = local.lastIndexOf(':')
    if (colon === -1) continue
    const port = Number.parseInt(local.slice(colon + 1), 10)
    if (!Number.isFinite(port) || port <= 0) continue

    let set = byPid.get(pid)
    if (!set) {
      set = new Set()
      byPid.set(pid, set)
    }
    // Set이 IPv4/IPv6 이중 바인딩의 중복을 자연히 제거한다. P14-2
    set.add(port)
    pids.add(pid)
  }

  return { byPid, pids }
}

/**
 * 셸로 볼 실행 파일 이름 (P14-13).
 *
 * 에이전트가 명령을 돌리려고 띄우는 것들이다. 세션 자신의 셸은 트리의 뿌리라
 * 여기 걸리지 않는다 — 뿌리는 순회에서 제외한다.
 */
const SHELL_NAMES = new Set([
  'powershell.exe',
  'pwsh.exe',
  'cmd.exe',
  'bash.exe',
  'sh.exe',
  'zsh.exe',
  'wsl.exe',
  'busybox.exe'
])

export interface ProcessInfo {
  name: string
  /** 뜬 시각(ms). 스냅샷이 알려주지 않으면 0 */
  startedAt: number
}

/** 한 번의 프로세스 열거로 얻는 것 전부. 포트와 셸이 이것을 나눠 쓴다. P14-5 / P14-13 */
export interface ProcessSnapshot {
  /** ppid → 자식 pid 목록 */
  children: Map<number, number[]>
  info: Map<number, ProcessInfo>
}

/**
 * 뿌리 아래에서 따로 도는 셸의 이름들 (P14-13).
 *
 * 순수 함수로 떼어 둔다 — 판정 규칙은 WMI 없이도 검증할 수 있어야 한다.
 *
 * 규칙이 둘 있고, 둘 다 실제 트리를 관찰해서 나왔다.
 *
 * 1. **바깥쪽 셸만 센다.** Git for Windows의 bash는 `bin/bash.exe`가
 *    `usr/bin/bash.exe`를 다시 띄우므로, 그대로 세면 명령 하나가 둘로 보인다.
 *    셸 안에서 다시 뜬 셸은 그 셸의 사정이지 세션의 사정이 아니다.
 *
 * 2. **잠깐 스쳐가는 것은 세지 않는다.** 에이전트의 상태줄 훅 같은 것이 몇 초마다
 *    셸을 띄웠다 지운다. 그것까지 세면 칩이 깜빡이고, 깜빡이는 표시는 P4-15에서
 *    이미 배운 대로 신호가 아니라 소음이다.
 */
export function shellNamesUnder(
  snapshot: ProcessSnapshot,
  rootPid: number,
  now = Date.now()
): string[] {
  if (!Number.isFinite(rootPid)) return []

  const found: string[] = []
  const seen = new Set<number>()
  const queue: Array<{ pid: number; insideShell: boolean }> = [
    { pid: rootPid, insideShell: false }
  ]

  while (queue.length > 0) {
    const node = queue.pop()
    if (node === undefined || seen.has(node.pid)) continue // 순환 차단. P14-8
    seen.add(node.pid)

    let insideShell = node.insideShell
    // 뿌리는 세션 자신의 셸이다. 그것까지 세면 모든 세션이 "셸 1"이 된다
    if (node.pid !== rootPid && !insideShell) {
      const info = snapshot.info.get(node.pid)
      if (info && SHELL_NAMES.has(info.name.toLowerCase())) {
        insideShell = true
        // 시작 시각을 모르면 세어 둔다 — 모른다고 감추면 진짜 셸을 놓친다
        const age = info.startedAt === 0 ? Number.POSITIVE_INFINITY : now - info.startedAt
        if (age >= POLICY.SHELL_MIN_AGE_MS) found.push(info.name.replace(/\.exe$/i, ''))
      }
    }

    const kids = snapshot.children.get(node.pid)
    if (kids) for (const kid of kids) queue.push({ pid: kid, insideShell })
  }

  return found.sort()
}

export class PortProbe {
  private ports: PortMap | null = null
  /** 프로세스 트리 + 이름/시작 시각. 포트와 셸이 같은 스냅샷을 쓴다. P14-5 / P14-13 */
  private tree: ProcessSnapshot = { children: new Map(), info: new Map() }
  private treeTakenAt = 0
  /** 직전 LISTEN PID 집합의 서명 — 바뀌었을 때만 트리를 다시 뜬다. P14-10 */
  private lastSignature = ''
  private failures = 0
  private available = true
  private running = false

  get enabled(): boolean {
    return this.available
  }

  /**
   * 이번 주기의 스냅샷을 갱신한다. 겹쳐 호출되면 조용히 건너뛴다. P14-7
   *
   * @param anyBusy 일이 돌아가는 세션이 하나라도 있는가. 그렇다면 트리를
   *                자주 다시 뜬다 — 따로 도는 셸을 60초 늦게 알리면 알리지
   *                않는 것과 같다(P14-13).
   */
  async refresh(anyBusy = false): Promise<void> {
    if (!this.available || this.running) return
    this.running = true
    try {
      const netstat = await run('netstat', ['-ano', '-p', 'TCP'], 5000)
      if (netstat === null) {
        this.noteFailure()
        return
      }
      this.failures = 0
      const ports = parseNetstat(netstat)
      this.ports = ports

      const maxAge = anyBusy ? POLICY.PROCESS_TREE_BUSY_AGE_MS : POLICY.PROCESS_TREE_MAX_AGE_MS
      const signature = [...ports.pids].sort((a, b) => a - b).join(',')
      const stale = Date.now() - this.treeTakenAt > maxAge
      // 리슨 PID가 그대로면 포트 계산에는 트리도 그대로면 충분하다 — 292ms를
      // 아낀다. 다만 셸은 포트를 열지 않으므로 수명이 따로 필요하다. P14-10 / P14-13
      if (signature !== this.lastSignature || stale) {
        const tree = await this.readProcessTree()
        if (tree) {
          this.tree = tree
          this.treeTakenAt = Date.now()
        }
        this.lastSignature = signature
      }
    } finally {
      this.running = false
    }
  }

  /** 이 세션 아래에서 따로 도는 셸들. 에이전트가 명령을 돌리는 중이라는 신호다. P14-13 */
  shellsFor(rootPid: number): string[] {
    return shellNamesUnder(this.tree, rootPid)
  }

  /** 루트 프로세스의 자손 전체가 리슨 중인 포트. P14-8 */
  portsFor(rootPid: number): number[] {
    if (!this.ports || !Number.isFinite(rootPid)) return []

    const found = new Set<number>()
    const seen = new Set<number>()
    const queue: number[] = [rootPid]

    while (queue.length > 0) {
      const pid = queue.pop()
      if (pid === undefined || seen.has(pid)) continue // 순환 차단. P14-8
      seen.add(pid)

      const owned = this.ports.byPid.get(pid)
      if (owned) for (const port of owned) found.add(port)

      const kids = this.tree.children.get(pid)
      if (kids) queue.push(...kids)
    }

    return [...found].sort((a, b) => a - b)
  }

  private noteFailure(): void {
    this.failures++
    // 계속 실패하는 환경(권한 제한 등)에서 무한히 재시도하지 않는다. P14-4
    if (this.failures >= POLICY.PORT_PROBE_MAX_FAILURES) {
      this.available = false
      console.warn('[cvmux] 포트 감지를 비활성화합니다 (연속 실패)')
    }
  }

  /**
   * pid/ppid/이름/시작 시각을 뽑는다. 속성을 제한해야 WMI가 그나마 빠르다.
   *
   * 이름과 시작 시각을 함께 받는 값은 실측상 없었다 — 같은 열거에 칸이 늘 뿐이다.
   * 반면 이름으로 **거르는** 질의(WQL WHERE)는 오히려 느려서 쓰지 않는다. P14-13
   */
  private async readProcessTree(): Promise<ProcessSnapshot | null> {
    const script =
      'Get-CimInstance -ClassName Win32_Process -Property ProcessId,ParentProcessId,Name,CreationDate | ' +
      'ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId) ' +
      // 시작 시각이 없는 프로세스(보호된 것들)에서 줄 전체를 잃지 않도록 0으로 채운다
      '$(if ($_.CreationDate) { $_.CreationDate.ToFileTimeUtc() } else { 0 }) $($_.Name)" }'

    const output = await run(
      POWERSHELL,
      ['-NoProfile', '-NonInteractive', '-Command', script],
      10_000
    )
    if (output === null) return null

    const children = new Map<number, number[]>()
    const info = new Map<number, ProcessInfo>()
    for (const line of output.split('\n')) {
      const parts = line.trim().split(' ')
      if (parts.length < 3) continue
      const pid = Number.parseInt(parts[0], 10)
      const ppid = Number.parseInt(parts[1], 10)
      if (!Number.isFinite(pid) || !Number.isFinite(ppid)) continue
      // 이름에 공백이 들어갈 수 있다 — 앞의 세 칸만 잘라내고 나머지를 통째로 쓴다
      const name = parts.slice(3).join(' ').trim()
      if (name) info.set(pid, { name, startedAt: fileTimeToMs(parts[2]) })
      const list = children.get(ppid)
      if (list) list.push(pid)
      else children.set(ppid, [pid])
    }
    return { children, info }
  }
}

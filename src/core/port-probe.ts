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
 */

const POWERSHELL = join(
  process.env.SystemRoot ?? 'C:\\Windows',
  'System32',
  'WindowsPowerShell',
  'v1.0',
  'powershell.exe'
)

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

export class PortProbe {
  private ports: PortMap | null = null
  /** ppid → 자식 pid 목록 */
  private children = new Map<number, number[]>()
  private treeTakenAt = 0
  /** 직전 LISTEN PID 집합의 서명 — 바뀌었을 때만 트리를 다시 뜬다. P14-10 */
  private lastSignature = ''
  private failures = 0
  private available = true
  private running = false

  get enabled(): boolean {
    return this.available
  }

  /** 이번 주기의 스냅샷을 갱신한다. 겹쳐 호출되면 조용히 건너뛴다. P14-7 */
  async refresh(): Promise<void> {
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

      const signature = [...ports.pids].sort((a, b) => a - b).join(',')
      const stale = Date.now() - this.treeTakenAt > POLICY.PROCESS_TREE_MAX_AGE_MS
      // 리슨 PID가 그대로면 트리도 그대로일 가능성이 높다 — 292ms를 아낀다. P14-10 / P14-11
      if (signature !== this.lastSignature || stale) {
        const tree = await this.readProcessTree()
        if (tree) {
          this.children = tree
          this.treeTakenAt = Date.now()
        }
        this.lastSignature = signature
      }
    } finally {
      this.running = false
    }
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

      const kids = this.children.get(pid)
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

  /** pid/ppid 쌍만 뽑는다. 속성을 제한해야 WMI가 그나마 빠르다 */
  private async readProcessTree(): Promise<Map<number, number[]> | null> {
    const script =
      'Get-CimInstance -ClassName Win32_Process -Property ProcessId,ParentProcessId | ' +
      'ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }'

    const output = await run(
      POWERSHELL,
      ['-NoProfile', '-NonInteractive', '-Command', script],
      10_000
    )
    if (output === null) return null

    const children = new Map<number, number[]>()
    for (const line of output.split('\n')) {
      const space = line.indexOf(' ')
      if (space === -1) continue
      const pid = Number.parseInt(line.slice(0, space), 10)
      const ppid = Number.parseInt(line.slice(space + 1), 10)
      if (!Number.isFinite(pid) || !Number.isFinite(ppid)) continue
      const list = children.get(ppid)
      if (list) list.push(pid)
      else children.set(ppid, [pid])
    }
    return children
  }
}

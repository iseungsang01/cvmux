import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/**
 * 에이전트 세션 기록 (POLICY.md P22-8).
 *
 * 에이전트 CLI는 대화를 자기 쪽에 저장하고 세션 id로 되살릴 수 있다
 * (`claude --resume <id>`). cvmux가 아는 것은 "어느 세션에서 어느 에이전트가
 * 돌았는가"뿐이므로, 훅이 그 대응을 여기에 적어 둔다.
 *
 * 앱을 다시 켜면 셸이 새로 뜨는데(P16-6), 그때 이 기록이 있으면 그 셸에서
 * 에이전트의 resume 명령을 이어서 띄운다. 없으면 그냥 셸이다.
 *
 * cmux는 `~/.cmuxterm/<agent>-hook-sessions.json`에 같은 것을 적는다. cvmux는
 * 파일 하나에 모은다 — 지원하는 에이전트가 적고, 하나면 검사도 한 번이면 된다.
 */

export interface AgentSessionRecord {
  /** cvmux 세션 id (`CVMUX_SESSION_ID`) */
  sessionId: string
  /** `claude` · `codex` 같은 에이전트 이름 */
  agent: string
  /** 에이전트가 발급한 대화 id */
  agentSessionId: string
  cwd: string
  updatedAt: number
}

export function agentSessionsPath(): string {
  const appData = process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming')
  return join(appData, 'cvmux', 'agent-sessions.json')
}

/**
 * 이 에이전트를 어떻게 이어서 띄우는가 (P22-8).
 *
 * 표에 없는 에이전트는 기록만 남고 resume은 하지 않는다 — 명령을 지어내면
 * 새 대화를 시작하거나 오류를 뿜을 뿐이다.
 */
const RESUME: Record<string, (id: string) => string> = {
  claude: (id) => `claude --resume ${id}`,
  codex: (id) => `codex resume ${id}`,
  gemini: (id) => `gemini --resume ${id}`,
  copilot: (id) => `copilot --resume ${id}`,
  cursor: (id) => `cursor-agent --resume ${id}`,
  codebuddy: (id) => `codebuddy --resume ${id}`,
  factory: (id) => `droid --resume ${id}`,
  qoder: (id) => `qodercli --resume ${id}`
}

export function resumeCommand(record: AgentSessionRecord): string | null {
  const build = RESUME[record.agent]
  return build ? build(record.agentSessionId) : null
}

export function supportedAgents(): string[] {
  return Object.keys(RESUME)
}

export class AgentSessionStore {
  private records = new Map<string, AgentSessionRecord>()

  constructor(private readonly filePath: string = agentSessionsPath()) {}

  load(): void {
    if (!existsSync(this.filePath)) return
    try {
      const raw: unknown = JSON.parse(readFileSync(this.filePath, 'utf8'))
      if (!Array.isArray(raw)) return
      for (const entry of raw) {
        const record = parse(entry)
        if (record) this.records.set(record.sessionId, record)
      }
    } catch {
      // 기록이 깨졌으면 없는 것과 같다. 에이전트는 새로 시작한다
    }
  }

  /**
   * 훅이 알려 온 대응을 적는다.
   *
   * 한 세션에는 마지막 것만 남긴다 — 같은 터미널에서 에이전트를 다시 띄웠다면
   * 이어야 할 것은 방금 그 대화다.
   */
  record(record: AgentSessionRecord): void {
    this.records.set(record.sessionId, record)
    this.save()
  }

  find(sessionId: string): AgentSessionRecord | null {
    return this.records.get(sessionId) ?? null
  }

  forget(sessionId: string): void {
    if (!this.records.delete(sessionId)) return
    this.save()
  }

  list(): AgentSessionRecord[] {
    return [...this.records.values()]
  }

  /**
   * 살아 있는 세션의 것만 남긴다.
   *
   * 세션은 사라져도 기록은 남는다. 치우지 않으면 파일이 한없이 자라고,
   * 복원할 때 이미 없는 세션의 대화를 되살리려 든다.
   */
  prune(aliveSessionIds: Iterable<string>): void {
    const alive = new Set(aliveSessionIds)
    let changed = false
    for (const id of [...this.records.keys()]) {
      if (alive.has(id)) continue
      this.records.delete(id)
      changed = true
    }
    if (changed) this.save()
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.filePath), { recursive: true })
      const temp = `${this.filePath}.tmp`
      writeFileSync(temp, JSON.stringify([...this.records.values()], null, 2), 'utf8')
      renameSync(temp, this.filePath)
    } catch {
      // 기록에 실패해도 세션은 계속 돈다. 다음 훅 호출이 다시 시도한다
    }
  }
}

function parse(value: unknown): AgentSessionRecord | null {
  if (typeof value !== 'object' || value === null) return null
  const r = value as Partial<AgentSessionRecord>
  if (typeof r.sessionId !== 'string' || !r.sessionId) return null
  if (typeof r.agent !== 'string' || !r.agent) return null
  if (typeof r.agentSessionId !== 'string' || !r.agentSessionId) return null
  return {
    sessionId: r.sessionId,
    agent: r.agent,
    agentSessionId: r.agentSessionId,
    cwd: typeof r.cwd === 'string' ? r.cwd : '',
    updatedAt: typeof r.updatedAt === 'number' ? r.updatedAt : 0
  }
}

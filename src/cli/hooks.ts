import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { AgentSessionStore, supportedAgents } from '@core/agent-sessions'
import { parseJsonc } from '@shared/config'
import { CliError } from './client'

/**
 * 에이전트 훅 (POLICY.md P22-7).
 *
 * 훅이 하는 일은 두 가지다. 에이전트가 대화를 시작하면 **세션 id를 적어 두고**
 * (그래야 다음에 이어서 띄운다, P22-8), 확인을 기다리면 **cvmux에 알린다**.
 *
 * 알림을 OSC 대신 이 길로 보내는 이유가 있다. 훅의 stdout은 에이전트가
 * 가져가므로 터미널까지 닿지 않을 때가 있는데, 소켓은 그 영향을 받지 않는다.
 *
 * **자동 설치는 Claude Code와 Codex만 한다.** 둘은 훅 파일 형식을 문서로 확인했다.
 * 다른 에이전트의 형식을 확인 없이 짐작해서 쓰면 남의 설정을 망가뜨린다. 대신
 * `cvmux hooks record`는 어느 에이전트든 받으므로, 훅 한 줄만 직접 걸면 된다.
 */

interface HookEntry {
  matcher?: string
  hooks?: Array<{ type?: string; command?: unknown; timeout?: number }>
  [key: string]: unknown
}

export type HookAgent = 'claude' | 'codex'

/**
 * 에이전트마다 훅 파일 자리와 걸 명령 (P22-7 / P29-8).
 *
 * 둘 다 `{ "hooks": { 이벤트: [{ matcher?, hooks: [{ type, command }] }] } }` 모양이다.
 * 훅은 세션 안에서 돌므로 `cvmux`가 PATH에 있다. Stop 훅이 에이전트의 마지막
 * 답을 싣고 오고, 그것이 옆 pane으로 넘기는 재료다(P29-1).
 *
 * Codex에는 Notification이 없다. 권한을 묻는 자리(PermissionRequest)는 답을
 * 표준 출력으로 기대하므로 걸지 않는다 — 잘못 답하면 에이전트가 멈춘다.
 */
const AGENT_HOOKS: Record<HookAgent, { path(): string; events: Record<string, string>; matcher: boolean }> = {
  claude: {
    path: () => join(homedir(), '.claude', 'settings.json'),
    events: {
      SessionStart: 'cvmux hooks record --agent claude',
      Notification: 'cvmux hooks notify --agent claude',
      Stop: 'cvmux hooks notify --agent claude --stop'
    },
    matcher: true
  },
  codex: {
    path: () => join(homedir(), '.codex', 'hooks.json'),
    events: {
      SessionStart: 'cvmux hooks record --agent codex',
      Stop: 'cvmux hooks notify --agent codex --stop'
    },
    matcher: false
  }
}

export function isHookAgent(agent: string): agent is HookAgent {
  return agent === 'claude' || agent === 'codex'
}

/**
 * 우리가 건 훅인가.
 *
 * 표시용 키를 따로 두지 않고 명령으로 알아본다. Codex가 모르는 키를 받아 줄지
 * 확인할 길이 없고, 사용자가 손으로 건 `cvmux hooks …`도 결국 같은 것이다.
 */
function isOurs(command: unknown): boolean {
  return typeof command === 'string' && command.trim().startsWith('cvmux hooks ')
}

/** 우리 훅만 걷어낸다. 한 항목에 사용자의 훅이 섞여 있으면 그것은 남긴다 */
function withoutOurs(list: unknown): { kept: unknown[]; removed: number } {
  if (!Array.isArray(list)) return { kept: [], removed: 0 }
  const kept: unknown[] = []
  let removed = 0
  for (const entry of list) {
    const hooks = (entry as HookEntry | null)?.hooks
    if (!Array.isArray(hooks)) {
      kept.push(entry)
      continue
    }
    const others = hooks.filter((hook) => !isOurs(hook?.command))
    removed += hooks.length - others.length
    // 옛 설치가 남긴 표시도 함께 걷는다
    const { _cvmux: _legacy, ...rest } = entry as HookEntry
    if (others.length > 0) kept.push({ ...rest, hooks: others })
  }
  return { kept, removed }
}

export interface HookResult {
  agent: string
  file: string
  action: 'installed' | 'removed' | 'unchanged'
  note?: string
}

export function installHooks(agent: HookAgent): HookResult {
  const spec = AGENT_HOOKS[agent]
  const path = spec.path()
  const file = readJson(path)
  const hooks = (file.hooks ?? {}) as Record<string, unknown>

  for (const [event, command] of Object.entries(spec.events)) {
    // 우리 것만 걷어내고 다시 넣는다 — 사용자가 직접 건 훅은 그대로 둔다
    const hook = { type: 'command', command }
    const entry = spec.matcher ? { matcher: '', hooks: [hook] } : { hooks: [hook] }
    hooks[event] = [...withoutOurs(hooks[event]).kept, entry]
  }

  file.hooks = hooks
  writeJson(path, file)
  return {
    agent,
    file: path,
    action: 'installed',
    // Codex는 새로 생긴 훅을 사람이 한 번 승인해야 돌린다
    note: agent === 'codex' ? 'Codex 안에서 /hooks를 열어 한 번 승인해야 돕니다' : undefined
  }
}

export function uninstallHooks(agent: HookAgent): HookResult {
  const path = AGENT_HOOKS[agent].path()
  if (!existsSync(path)) return { agent, file: path, action: 'unchanged', note: '파일 없음' }

  const file = readJson(path)
  const hooks = (file.hooks ?? {}) as Record<string, unknown>
  let removed = 0

  for (const event of Object.keys(hooks)) {
    const result = withoutOurs(hooks[event])
    if (result.removed === 0) continue
    removed += result.removed
    if (result.kept.length === 0) delete hooks[event]
    else hooks[event] = result.kept
  }

  if (Object.keys(hooks).length === 0) delete file.hooks
  else file.hooks = hooks

  if (removed > 0) writeJson(path, file)
  return {
    agent,
    file: path,
    action: removed > 0 ? 'removed' : 'unchanged',
    note: removed > 0 ? undefined : '설치된 훅 없음'
  }
}

/**
 * 훅이 보낸 것을 읽는다.
 *
 * Claude Code는 훅 페이로드를 stdin에 JSON으로 준다. 세션 id는 `session_id`,
 * 알림 문구는 `message`에 들어 있다.
 */
export async function readHookPayload(): Promise<Record<string, unknown>> {
  if (process.stdin.isTTY) return {}

  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk))
  // BOM이 붙어 오면 JSON.parse가 막힌다 — Windows 파이프에서 흔한 일이다
  const text = Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/, '').trim()
  if (text === '') return {}

  try {
    const parsed: unknown = JSON.parse(text)
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/**
 * 세션 id를 적는다 (P22-8).
 *
 * 어느 cvmux 세션에서 어느 에이전트 대화가 도는지가 여기 남는다. cvmux 밖에서
 * 부르면 적을 자리가 없으므로 조용히 넘어간다 — 훅이 실패해 에이전트를
 * 멈추게 해서는 안 된다.
 */
export function recordSession(agent: string, payload: Record<string, unknown>): string {
  const sessionId = process.env.CVMUX_SESSION_ID
  if (!sessionId) return 'cvmux 세션이 아닙니다. 기록하지 않습니다.'

  const agentSessionId = String(payload.session_id ?? payload.sessionId ?? '')
  if (!agentSessionId) return '세션 id가 없습니다. 기록하지 않습니다.'

  const store = new AgentSessionStore()
  store.load()
  store.record({
    sessionId,
    agent,
    agentSessionId,
    cwd: String(payload.cwd ?? process.cwd()),
    updatedAt: Date.now()
  })
  return `${agent} 세션 ${agentSessionId}를 기록했습니다.`
}

/** 훅이 알려 온 문구. 없으면 상황에 맞는 기본 문구를 쓴다 */
export function hookNotifyText(payload: Record<string, unknown>, stop: boolean): string {
  const message = payload.message
  if (typeof message === 'string' && message.trim() !== '') return message.trim()
  return stop ? '응답을 마쳤습니다' : '확인이 필요합니다'
}

export function hooksStatus(): string {
  return (Object.keys(AGENT_HOOKS) as HookAgent[]).map(agentStatus).join('\n')
}

function agentStatus(agent: HookAgent): string {
  const spec = AGENT_HOOKS[agent]
  const path = spec.path()
  const name = agent.padEnd(8)
  if (!existsSync(path)) return `${name} 설치되지 않음  (${path} 없음)`

  try {
    const hooks = (readJson(path).hooks ?? {}) as Record<string, unknown>
    const installed = Object.keys(spec.events).filter((event) => withoutOurs(hooks[event]).removed > 0)
    const all = Object.keys(spec.events).length
    return installed.length === all
      ? `${name} 설치됨  (${path})`
      : installed.length === 0
        ? `${name} 설치되지 않음  (${path})`
        : `${name} 일부만 설치됨: ${installed.join(', ')}  (${path})`
  } catch (error) {
    return `${name} 읽을 수 없음: ${error instanceof Error ? error.message : String(error)}`
  }
}

/** resume까지 지원하는 에이전트 목록 — 기록만 되는 것과 구분해 보여 준다 */
export function resumableAgents(): string {
  return supportedAgents().join(', ')
}

// ── 파일 다루기 ────────────────────────────────────────────────

function readJson(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {}
  try {
    const parsed = parseJsonc(readFileSync(path, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new CliError(`${path}의 최상위가 객체가 아닙니다. 손대지 않았습니다.`)
    }
    return parsed as Record<string, unknown>
  } catch (error) {
    if (error instanceof CliError) throw error
    /*
     * 읽지 못한 설정은 덮어쓰지 않는다.
     *
     * 여기서 빈 객체로 시작하면 사용자의 Claude 설정을 통째로 날린다. 훅을
     * 걸지 못하는 것보다 그쪽이 훨씬 나쁘다.
     */
    throw new CliError(
      `${path}를 읽을 수 없습니다: ${error instanceof Error ? error.message : String(error)}\n` +
        '파일을 고친 뒤 다시 실행하세요. 덮어쓰지 않았습니다.'
    )
  }
}

function writeJson(path: string, value: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true })
  // 원본을 한 번 남긴다 — 남의 설정을 고치는 일이라 되돌릴 길이 있어야 한다
  if (existsSync(path) && !existsSync(`${path}.cvmux-backup`)) {
    writeFileSync(`${path}.cvmux-backup`, readFileSync(path, 'utf8'), 'utf8')
  }
  const temp = `${path}.tmp`
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  renameSync(temp, path)
}

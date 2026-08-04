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
 * **자동 설치는 Claude Code만 한다.** 다른 에이전트의 훅 파일 형식을 확인 없이
 * 짐작해서 쓰면 남의 설정을 망가뜨린다. 대신 `cvmux hooks record`는 어느
 * 에이전트든 받으므로, 훅 한 줄만 직접 걸면 같은 것이 동작한다.
 */

/** 우리가 넣은 항목이라는 표시. 지울 때 남의 훅과 구분하는 유일한 근거다 */
const MARK = '_cvmux'

interface HookEntry {
  matcher?: string
  hooks: Array<{ type: string; command: string }>
  [MARK]?: boolean
}

function claudeSettingsPath(): string {
  return join(homedir(), '.claude', 'settings.json')
}

/** Claude Code가 부를 명령. 세션 안에서 도는 훅이므로 `cvmux`가 PATH에 있다 */
const CLAUDE_HOOKS: Record<string, string> = {
  SessionStart: 'cvmux hooks record --agent claude',
  Notification: 'cvmux hooks notify --agent claude',
  Stop: 'cvmux hooks notify --agent claude --stop'
}

export interface HookResult {
  agent: string
  file: string
  action: 'installed' | 'removed' | 'unchanged'
  note?: string
}

export function installClaude(): HookResult {
  const path = claudeSettingsPath()
  const settings = readJson(path)
  const hooks = (settings.hooks ?? {}) as Record<string, unknown>

  for (const [event, command] of Object.entries(CLAUDE_HOOKS)) {
    const existing = Array.isArray(hooks[event]) ? (hooks[event] as HookEntry[]) : []
    // 우리 것만 걷어내고 다시 넣는다 — 사용자가 직접 건 훅은 그대로 둔다
    const others = existing.filter((entry) => entry?.[MARK] !== true)
    others.push({ matcher: '', [MARK]: true, hooks: [{ type: 'command', command }] })
    hooks[event] = others
  }

  settings.hooks = hooks
  writeJson(path, settings)
  return { agent: 'claude', file: path, action: 'installed' }
}

export function uninstallClaude(): HookResult {
  const path = claudeSettingsPath()
  if (!existsSync(path)) return { agent: 'claude', file: path, action: 'unchanged', note: '파일 없음' }

  const settings = readJson(path)
  const hooks = (settings.hooks ?? {}) as Record<string, unknown>
  let removed = 0

  for (const event of Object.keys(CLAUDE_HOOKS)) {
    if (!Array.isArray(hooks[event])) continue
    const before = (hooks[event] as HookEntry[]).length
    const kept = (hooks[event] as HookEntry[]).filter((entry) => entry?.[MARK] !== true)
    removed += before - kept.length
    if (kept.length === 0) delete hooks[event]
    else hooks[event] = kept
  }

  if (Object.keys(hooks).length === 0) delete settings.hooks
  else settings.hooks = hooks

  writeJson(path, settings)
  return {
    agent: 'claude',
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
  const text = Buffer.concat(chunks).toString('utf8').trim()
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
  const path = claudeSettingsPath()
  if (!existsSync(path)) return `claude   설치되지 않음  (${path} 없음)`

  try {
    const settings = readJson(path)
    const hooks = (settings.hooks ?? {}) as Record<string, unknown>
    const installed = Object.keys(CLAUDE_HOOKS).filter((event) => {
      const list = hooks[event]
      return Array.isArray(list) && (list as HookEntry[]).some((e) => e?.[MARK] === true)
    })
    return installed.length === Object.keys(CLAUDE_HOOKS).length
      ? `claude   설치됨  (${path})`
      : installed.length === 0
        ? `claude   설치되지 않음  (${path})`
        : `claude   일부만 설치됨: ${installed.join(', ')}  (${path})`
  } catch (error) {
    return `claude   읽을 수 없음: ${error instanceof Error ? error.message : String(error)}`
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

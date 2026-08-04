import { existsSync, readFileSync } from 'node:fs'

import { ConfigStore, configPaths } from '@core/config-store'
import { parseConfig, parseJsonc } from '@shared/config'
import { M } from '@shared/protocol'
import { CliError, ControlClient, resolveEndpoint } from './client'
import { HELP, VERSION, commandHelp } from './help'
import {
  hookNotifyText,
  hooksStatus,
  installClaude,
  readHookPayload,
  recordSession,
  resumableAgents,
  uninstallClaude
} from './hooks'
import { render } from './render'

/**
 * cvmux CLI (P20-1).
 *
 * cmux의 CLI 계약(docs/cli-contract.md)을 따르되 cvmux가 가진 것만 담았다.
 * 명령 이름과 인자 표기는 그대로라 cmux용 스크립트를 거의 그대로 옮길 수 있다.
 *
 * 규칙 하나: **소켓 없이 답할 수 있는 것은 소켓 없이 답한다.** `--help`와
 * `--version`이 앱이 꺼져 있다고 실패하면 도구로 못 쓴다.
 */

interface Parsed {
  command: string
  args: string[]
  flags: Map<string, string | true>
}

/**
 * 값을 받지 않는 스위치 (P20-1).
 *
 * 이 목록이 없으면 `cvmux --json notify 완료`에서 `--json`이 뒤의 `notify`를
 * 자기 값으로 삼켜 명령이 사라진다. 스위치인지 옵션인지는 이름으로만 알 수
 * 있으므로 여기 적어 둔다.
 */
const SWITCHES: ReadonlySet<string> = new Set([
  'help',
  'version',
  'json',
  'enter',
  'all',
  'close',
  'reconnect',
  'no-ack'
])

function parse(argv: string[]): Parsed {
  const flags = new Map<string, string | true>()
  const positional: string[] = []
  let passthrough = false

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (passthrough) {
      positional.push(token)
      continue
    }
    if (token === '--') {
      passthrough = true
      continue
    }
    if (token.startsWith('--')) {
      const eq = token.indexOf('=')
      if (eq !== -1) {
        flags.set(token.slice(2, eq), token.slice(eq + 1))
        continue
      }
      const name = token.slice(2)
      const next = argv[i + 1]
      // 값 없는 스위치와 값을 받는 옵션을 여기서 가른다
      if (!SWITCHES.has(name) && next !== undefined && !next.startsWith('-')) {
        flags.set(name, next)
        i++
      } else {
        flags.set(name, true)
      }
      continue
    }
    if (token.startsWith('-') && token.length > 1) {
      const short: Record<string, string> = { h: 'help', v: 'version', j: 'json' }
      const name = short[token.slice(1)] ?? token.slice(1)
      flags.set(name, true)
      continue
    }
    positional.push(token)
  }

  return { command: positional[0] ?? '', args: positional.slice(1), flags }
}

function str(flags: Map<string, string | true>, name: string): string | undefined {
  const value = flags.get(name)
  return typeof value === 'string' ? value : undefined
}

function all(flags: Map<string, string | true>, name: string): string[] {
  const value = flags.get(name)
  return typeof value === 'string' ? [value] : []
}

/** 세션 인자의 기본값은 부르는 쪽의 세션이다. P20-4 */
function defaultSession(flags: Map<string, string | true>): string | undefined {
  return str(flags, 'session') ?? process.env.CVMUX_SESSION_ID
}

async function main(argv: string[]): Promise<number> {
  const parsed = parse(argv)
  const { command, args, flags } = parsed
  const json = flags.get('json') === true

  // ── 소켓 없이 답하는 것들 ───────────────────────────────────
  if (flags.get('version') === true || command === 'version') {
    process.stdout.write(`${VERSION}\n`)
    return 0
  }
  if (command === '' || command === 'help' || (flags.get('help') === true && command === '')) {
    process.stdout.write(`${HELP}\n`)
    return 0
  }
  if (flags.get('help') === true) {
    const help = commandHelp(command)
    process.stdout.write(`${help}\n`)
    return help.startsWith('Usage:') ? 0 : 1
  }

  /*
   * 훅과 설정은 소켓 없이 답한다 (P20-1 / P22-6).
   *
   * `cvmux hooks record`는 에이전트가 부르는 명령이라 앱이 떠 있지 않을 수도
   * 있고, `cvmux config doctor`는 애초에 앱이 뜨지 않을 때 쓰는 것이다.
   */
  if (command === 'hooks') return runHooks(args, flags)
  if (command === 'config' && args[0] !== 'reload') return runConfig(args, flags, json)

  const endpoint = resolveEndpoint({ socket: str(flags, 'socket'), password: str(flags, 'password') })
  const client = new ControlClient(endpoint)
  await client.connect()

  try {
    const result = await run(client, command, args, flags)
    if (result !== undefined) process.stdout.write(`${render(command, result, json)}\n`)
    return 0
  } finally {
    // 이벤트 스트림은 스스로 끝난다 — 그 외에는 여기서 닫는다
    if (command !== 'events') client.close()
  }
}

/**
 * `cvmux hooks …` (P22-7).
 *
 * `record`와 `notify`는 에이전트가 부르는 것이라 **절대 실패로 끝나지 않는다** —
 * 훅이 0이 아닌 코드로 끝나면 에이전트가 그것을 오류로 다룬다. 할 수 없는
 * 상황이면 이유만 적고 0으로 나간다.
 */
async function runHooks(args: string[], flags: Map<string, string | true>): Promise<number> {
  const sub = args[0] ?? 'status'
  const agent = str(flags, 'agent') ?? args[1] ?? 'claude'

  switch (sub) {
    case 'setup':
    case 'install': {
      if (agent !== 'claude') {
        process.stderr.write(
          `cvmux: ${agent}는 자동 설치를 지원하지 않습니다.\n` +
            '훅 형식을 확인 없이 짐작해 쓰면 남의 설정을 망가뜨립니다.\n' +
            `대신 그 에이전트의 훅에 이 한 줄을 직접 걸면 같은 것이 동작합니다:\n` +
            `  cvmux hooks record --agent ${agent}\n`
        )
        return 1
      }
      const result = installClaude()
      process.stdout.write(
        `claude 훅을 설치했습니다 → ${result.file}\n` +
          `이어서 띄우기를 지원하는 에이전트: ${resumableAgents()}\n`
      )
      return 0
    }

    case 'uninstall': {
      if (agent !== 'claude') {
        process.stderr.write(`cvmux: ${agent}는 자동 설치를 지원하지 않습니다.\n`)
        return 1
      }
      const result = uninstallClaude()
      process.stdout.write(
        result.action === 'removed'
          ? `claude 훅을 제거했습니다 → ${result.file}\n`
          : `제거할 훅이 없습니다 (${result.note ?? ''}).\n`
      )
      return 0
    }

    case 'status':
    case 'list':
      process.stdout.write(`${hooksStatus()}\n`)
      return 0

    case 'record': {
      const payload = await readHookPayload()
      process.stdout.write(`${recordSession(agent, payload)}\n`)
      return 0
    }

    case 'notify': {
      const payload = await readHookPayload()
      const text = hookNotifyText(payload, flags.get('stop') === true)
      // 세션 id도 함께 갱신한다 — 알림 훅이 SessionStart보다 먼저 올 수 있다
      recordSession(agent, payload)

      try {
        const endpoint = resolveEndpoint({})
        const client = new ControlClient(endpoint)
        await client.connect()
        await client.call(M.SESSION_NOTIFY, {
          session: process.env.CVMUX_SESSION_ID,
          title: agent === 'claude' ? 'Claude Code' : agent,
          text
        })
        client.close()
      } catch (error) {
        // 앱이 꺼져 있으면 알릴 곳이 없다. 그래도 에이전트를 멈추지는 않는다
        process.stderr.write(
          `cvmux: 알림을 보내지 못했습니다 (${error instanceof Error ? error.message : String(error)})\n`
        )
      }
      return 0
    }

    default:
      process.stderr.write(`cvmux: 모르는 하위 명령: hooks ${sub}\n`)
      return 1
  }
}

/** `cvmux config …` — 소켓 없이 도는 쪽. P22-6 */
function runConfig(args: string[], flags: Map<string, string | true>, json: boolean): number {
  const sub = args[0] ?? 'path'

  if (sub === 'path' || sub === 'paths') {
    const [primary, alternate] = configPaths()
    process.stdout.write(
      `설정 파일 (앞의 것이 먼저 읽힙니다):\n  ${primary}\n  ${alternate}\n\n` +
        '없으면 `cvmux config init`으로 주석이 달린 본보기를 만들 수 있습니다.\n' +
        '고친 뒤에는 저장만 하면 바로 반영됩니다 (`cvmux config reload`로도 됩니다).\n'
    )
    return 0
  }

  if (sub === 'init') {
    // 앱이 하는 일과 같은 것을 CLI에서도 할 수 있게 한다
    const store = new ConfigStore(() => {})
    const path = store.ensureFile()
    process.stdout.write(`${path}\n`)
    return 0
  }

  if (sub === 'doctor' || sub === 'check' || sub === 'validate') {
    const explicit = str(flags, 'path')
    const candidates = explicit ? [explicit] : configPaths()
    const findings: Array<{ path: string; ok: boolean; problems: string[] }> = []

    for (const path of candidates) {
      if (!existsSync(path)) {
        findings.push({ path, ok: true, problems: ['(파일 없음 — 기본값을 씁니다)'] })
        continue
      }
      try {
        const { problems } = parseConfig(parseJsonc(readFileSync(path, 'utf8')))
        findings.push({
          path,
          ok: problems.length === 0,
          problems: problems.map((p) => `${p.path || '(최상위)'}: ${p.message}`)
        })
      } catch (error) {
        findings.push({
          path,
          ok: false,
          problems: [error instanceof Error ? error.message : String(error)]
        })
      }
    }

    const bad = findings.filter((f) => !f.ok)
    if (json) {
      process.stdout.write(`${JSON.stringify({ ok: bad.length === 0, findings }, null, 2)}\n`)
    } else {
      for (const finding of findings) {
        process.stdout.write(`${finding.ok ? 'OK  ' : 'ERR '}${finding.path}\n`)
        for (const problem of finding.problems) process.stdout.write(`      ${problem}\n`)
      }
    }
    return bad.length === 0 ? 0 : 1
  }

  process.stderr.write(`cvmux: 모르는 하위 명령: config ${sub}\n`)
  return 1
}

async function run(
  client: ControlClient,
  command: string,
  args: string[],
  flags: Map<string, string | true>
): Promise<unknown> {
  const workspace = str(flags, 'workspace')
  const pane = str(flags, 'pane')

  switch (command) {
    // ── 연결 ───────────────────────────────────────────────────
    case 'ping':
      return client.call(M.PING)
    case 'capabilities':
      return client.call(M.CAPABILITIES)
    case 'identify':
      return client.call(M.IDENTIFY)
    case 'focus':
      return client.call(M.APP_FOCUS)

    case 'rpc': {
      const method = args[0]
      if (!method) throw new CliError('메서드 이름이 필요합니다. 사용법: cvmux rpc <method> [json]')
      const params = args[1] ? (JSON.parse(args[1]) as Record<string, unknown>) : {}
      return client.call(method, params)
    }

    case 'events': {
      const names = [...all(flags, 'name')]
      // --after를 주지 않으면 지금부터다. 버퍼를 쏟는 것은 명시적으로 요청해야 한다
      const after = str(flags, 'after')
      const limit = Number(str(flags, 'limit') ?? 0)
      let seen = 0
      await client.stream({ after: after === undefined ? undefined : Number(after), names }, (frame) => {
        process.stdout.write(`${JSON.stringify(frame)}\n`)
        seen++
        if (limit > 0 && seen >= limit) {
          client.close()
          process.exit(0)
        }
      })
      // 끊길 때까지 산다. 이 명령만은 응답을 찍고 끝나지 않는다
      return undefined
    }

    // ── 워크스페이스 ────────────────────────────────────────────
    case 'list-workspaces':
      return client.call(M.WORKSPACE_LIST)
    case 'current-workspace':
      return client.call(M.WORKSPACE_CURRENT)
    case 'tree':
      return client.call(M.WORKSPACE_TREE)

    case 'new-workspace':
      return client.call(M.WORKSPACE_CREATE, {
        cwd: str(flags, 'cwd') ?? args[0],
        title: str(flags, 'title')
      })

    case 'select-workspace':
      return client.call(M.WORKSPACE_SELECT, { workspace: args[0] ?? workspace })
    case 'close-workspace':
      return client.call(M.WORKSPACE_CLOSE, { workspace: args[0] ?? workspace })

    case 'rename-workspace': {
      // `rename-workspace <handle> <title>` 또는 `rename-workspace <title>`
      const [first, second] = args
      return client.call(M.WORKSPACE_RENAME, {
        workspace: second === undefined ? workspace : first,
        title: second ?? first ?? null
      })
    }

    // ── pane ────────────────────────────────────────────────────
    case 'list-panes':
      return client.call(M.PANE_LIST, { workspace })
    case 'new-split':
      return client.call(M.PANE_SPLIT, {
        workspace,
        pane,
        direction: str(flags, 'direction') ?? args[0] ?? 'right'
      })
    // ── 가로 탭 (P24-6) ────────────────────────────────────────
    case 'list-surfaces':
      return client.call(M.SURFACE_LIST, { workspace, pane })
    case 'new-surface':
      return client.call(M.SURFACE_NEW, {
        workspace,
        pane,
        kind: str(flags, 'kind') ?? args[0],
        url: str(flags, 'url')
      })
    case 'select-surface':
      return client.call(M.SURFACE_SELECT, { workspace, pane, surface: args[0] ?? str(flags, 'surface') })
    case 'close-surface':
      return client.call(M.SURFACE_CLOSE, { workspace, pane, surface: args[0] ?? str(flags, 'surface') })

    case 'focus-pane':
      return client.call(M.PANE_FOCUS, { workspace, pane: args[0] ?? pane })
    case 'close-pane':
      return client.call(M.PANE_CLOSE, { workspace, pane: args[0] ?? pane })

    // ── 세션 ────────────────────────────────────────────────────
    case 'list-sessions':
      return client.call(M.SESSION_LIST)

    case 'read-screen':
      return client.call(M.SESSION_READ, {
        session: defaultSession(flags),
        lines: Number(str(flags, 'lines') ?? 0)
      })

    case 'send':
      return client.call(M.SESSION_SEND, {
        session: defaultSession(flags),
        text: args.join(' '),
        enter: flags.get('enter') === true
      })

    case 'send-key':
      return client.call(M.SESSION_SEND_KEY, {
        session: defaultSession(flags),
        key: str(flags, 'key') ?? args[0] ?? ''
      })

    case 'close-session':
      return client.call(M.SESSION_CLOSE, { session: args[0] ?? defaultSession(flags) })
    case 'restart-session':
      return client.call(M.SESSION_RESTART, { session: args[0] ?? defaultSession(flags) })
    case 'set-title':
      return client.call(M.SESSION_SET_TITLE, {
        session: defaultSession(flags),
        title: args.join(' ') || null
      })

    // ── 알림 ────────────────────────────────────────────────────
    case 'notify':
      return client.call(M.SESSION_NOTIFY, {
        session: defaultSession(flags),
        title: str(flags, 'title'),
        text: args.join(' ')
      })

    case 'list-notifications':
      return client.call(M.NOTIFICATION_LIST)
    case 'mark-notification-read':
      return client.call(M.NOTIFICATION_MARK_READ, {
        session: flags.get('all') === true ? undefined : (args[0] ?? defaultSession(flags))
      })
    case 'dismiss-notification':
      return client.call(M.NOTIFICATION_DISMISS, { session: args[0] })
    case 'clear-notifications':
      return client.call(M.NOTIFICATION_CLEAR)
    case 'open-notification':
      return client.call(M.NOTIFICATION_OPEN, { session: args[0] ?? defaultSession(flags) })
    case 'jump-to-unread':
      return client.call(M.NOTIFICATION_JUMP_UNREAD)

    // config의 나머지는 소켓 없이 처리했다. reload만 앱에 닿아야 한다. P22-6
    case 'config':
      return client.call(M.CONFIG_RELOAD)

    case 'panel':
      return client.call(M.APP_PANEL, {
        panel: args[0] ?? 'notifications',
        open: flags.get('close') !== true,
        scope: str(flags, 'scope'),
        query: str(flags, 'query') ?? args[1]
      })

    /*
     * ── 내장 브라우저 (P23-3) ─────────────────────────────────
     *
     * 하위 명령 이름은 cmux의 `browser …`를 그대로 따른다. 에이전트가 쓰는
     * 방식도 같다 — `snapshot`으로 요소에 이름을 받고, 그 이름을 눌러 조작한다.
     */
    case 'browser': {
      const sub = args[0] ?? 'list'
      const target = { browser: str(flags, 'browser') ?? str(flags, 'surface') }
      const ref = str(flags, 'ref')
      const selector = str(flags, 'selector')

      switch (sub) {
        case 'open':
        case 'new':
          return client.call(M.BROWSER_OPEN, {
            url: args[1] ?? str(flags, 'url'),
            direction: str(flags, 'direction') ?? 'right'
          })
        case 'list':
          return client.call(M.BROWSER_LIST)
        case 'goto':
        case 'navigate':
          return client.call(M.BROWSER_GOTO, { ...target, url: args[1] ?? str(flags, 'url') })
        case 'back':
          return client.call(M.BROWSER_BACK, target)
        case 'forward':
          return client.call(M.BROWSER_FORWARD, target)
        case 'reload':
          return client.call(M.BROWSER_RELOAD, target)
        case 'close':
          return client.call(M.BROWSER_CLOSE, target)
        case 'snapshot':
          return client.call(M.BROWSER_SNAPSHOT, { ...target, limit: str(flags, 'limit') })
        case 'eval':
          return client.call(M.BROWSER_EVAL, { ...target, code: args.slice(1).join(' ') })
        case 'click':
          return client.call(M.BROWSER_CLICK, { ...target, ref: ref ?? args[1], selector })
        case 'fill':
        case 'type':
          return client.call(M.BROWSER_FILL, {
            ...target,
            ref: ref ?? args[1],
            selector,
            value: str(flags, 'value') ?? args.slice(2).join(' ')
          })
        case 'press':
        case 'key':
          return client.call(M.BROWSER_PRESS, {
            ...target,
            ref,
            selector,
            key: str(flags, 'key') ?? args[1] ?? ''
          })
        case 'get':
          return client.call(M.BROWSER_GET, {
            ...target,
            what: args[1] ?? 'url',
            ref,
            selector
          })
        case 'wait':
          return client.call(M.BROWSER_WAIT, {
            ...target,
            selector: selector ?? args[1],
            text: str(flags, 'text'),
            timeout: str(flags, 'timeout')
          })
        case 'screenshot':
          return client.call(M.BROWSER_SCREENSHOT, target)
        default:
          throw new CliError(`모르는 하위 명령: browser ${sub}`)
      }
    }

    // ── 기타 ────────────────────────────────────────────────────
    case 'open': {
      const path = args[0]
      if (!path) throw new CliError('열 경로가 필요합니다. 사용법: cvmux open <path>')
      return client.call(M.APP_OPEN, { path })
    }

    default:
      throw new CliError(`모르는 명령: ${command}\n\`cvmux --help\`로 목록을 볼 수 있습니다.`)
  }
}

void main(process.argv.slice(2)).then(
  (code) => {
    if (code !== 0) process.exit(code)
  },
  (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`cvmux: ${message}\n`)
    process.exit(error instanceof CliError ? error.exitCode : 1)
  }
)

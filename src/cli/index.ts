import { M } from '@shared/protocol'
import { CliError, ControlClient, resolveEndpoint } from './client'
import { HELP, VERSION, commandHelp } from './help'
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

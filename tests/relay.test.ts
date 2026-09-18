/*
 * 옆 pane의 에이전트에게 답 넘기기 (POLICY.md P29) — 회귀 테스트.
 *
 * 지키는 것:
 *   - 받는 쪽이 셸 프롬프트면 넣지 않는다 — 넣으면 답이 명령으로 실행된다
 *   - 받는 쪽이 일하는 중이거나 권한을 묻는 중이면 기다렸다 넣는다
 *   - 사람 손 없이 N번 이어지면 멈춘다. 사람 입력이 끼면 다시 센다
 *   - 연결은 저장되고, 순번이 밀려도 맞는 세션을 가리킨다
 *   - 훅 설치는 남의 훅을 건드리지 않는다
 *
 * 실행: npm test
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Relay, isHumanInput, type RelayHost } from '../src/core/relay'
import { PtyManager } from '../src/core/pty-manager'
import { SessionStore } from '../src/core/store'
import type { SessionStatus } from '../src/shared/types'

const results: string[] = []
let failed = 0

function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failed++
  results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `  ← ${detail}` : ''}`)
}

/** 흉내 낸 세션들. 쓰인 것과 알림을 모아 둔다 */
function fakeHost(): RelayHost & {
  targets: Map<string, string | null>
  status: Map<string, SessionStatus>
  command: Map<string, boolean>
  written: Array<[string, string]>
  notes: Array<[string, string]>
} {
  const host = {
    targets: new Map<string, string | null>(),
    status: new Map<string, SessionStatus>([
      ['A', 'waiting'],
      ['B', 'waiting']
    ]),
    command: new Map<string, boolean>([
      ['A', true],
      ['B', true]
    ]),
    written: [] as Array<[string, string]>,
    notes: [] as Array<[string, string]>,
    targetOf: (id: string) => host.targets.get(id) ?? null,
    setTarget: (id: string, target: string | null) => void host.targets.set(id, target),
    statusOf: (id: string) => host.status.get(id) ?? null,
    inCommand: (id: string) => host.command.get(id) ?? false,
    write: (id: string, data: string) => void host.written.push([id, data]),
    notify: (id: string, text: string) => void host.notes.push([id, text])
  }
  return host
}

async function main(): Promise<void> {
  let clock = 0
  const later: Array<() => void> = []
  const make = (max = 10) => {
    const host = fakeHost()
    const relay = new Relay(host, max, (fn) => later.push(fn), () => clock)
    return { host, relay }
  }
  const runLater = (): void => {
    while (later.length) later.shift()!()
  }
  const pastedTo = (host: ReturnType<typeof fakeHost>, id: string): string[] =>
    host.written.filter(([to, data]) => to === id && data.startsWith('\x1b[200~')).map(([, d]) => d)

  // ── 방향 (P29-2) ─────────────────────────────────────────────
  {
    const { host, relay } = make()
    check('처음엔 꺼져 있다', relay.modeOf('A', 'B') === 'off')
    relay.setMode('A', 'B', 'forward')
    check('forward는 A → B', relay.modeOf('A', 'B') === 'forward' && host.targets.get('B') == null)
    relay.setMode('A', 'B', 'backward')
    check('backward는 B → A만', relay.modeOf('A', 'B') === 'backward' && host.targets.get('A') === null)
    relay.setMode('A', 'B', 'both')
    check('both는 양쪽', relay.modeOf('A', 'B') === 'both')
    relay.setMode('A', 'B', 'off')
    check('off는 둘 다 끊는다', relay.modeOf('A', 'B') === 'off')

    host.targets.set('A', 'C')
    relay.setMode('A', 'B', 'off')
    check('다른 칸으로 가던 연결은 건드리지 않는다', host.targets.get('A') === 'C')
  }

  // ── 넣기 (P29-3) ─────────────────────────────────────────────
  {
    const { host, relay } = make()
    relay.setMode('A', 'B', 'forward')
    relay.turnComplete('A', '  테스트 12개 통과\n다음은?  ', 'claude')
    const pasted = pastedTo(host, 'B')
    check('bracketed paste로 한 덩어리를 넣는다', pasted.length === 1 && pasted[0].endsWith('\x1b[201~'))
    check('누가 보냈는지 머리를 붙인다', pasted[0]?.includes('claude') && pasted[0].includes('테스트 12개 통과\n다음은?'))
    check('Enter는 나중에 따로 보낸다', !host.written.some(([, d]) => d === '\r'))
    runLater()
    check('그다음 Enter를 보낸다', host.written.at(-1)?.[0] === 'B' && host.written.at(-1)?.[1] === '\r')

    relay.turnComplete('B', '답장', 'codex')
    check('반대 방향은 꺼져 있으면 넘기지 않는다', pastedTo(host, 'A').length === 0)
    relay.turnComplete('A', '   ', 'claude')
    check('빈 답은 넘기지 않는다', pastedTo(host, 'B').length === 1)
  }

  // ── 셸에 붙여 넣지 않는다 (P29-4) ─────────────────────────────
  {
    const { host, relay } = make()
    relay.setMode('A', 'B', 'forward')
    host.command.set('B', false)
    relay.turnComplete('A', 'Remove-Item -Recurse C:\\', 'claude')
    check('받는 쪽이 셸 프롬프트면 넣지 않는다', host.written.length === 0)
    check('넣지 못했다고 알린다', host.notes.some(([id]) => id === 'B'))
  }

  // ── 기다렸다 넣기 (P29-5) ─────────────────────────────────────
  {
    const { host, relay } = make()
    relay.setMode('A', 'B', 'forward')
    host.status.set('B', 'busy')
    relay.turnComplete('A', '첫째', 'claude')
    check('일하는 중이면 기다린다', pastedTo(host, 'B').length === 0)
    host.status.set('B', 'waiting')
    relay.statusChanged('B')
    check('한가해지면 넣는다', pastedTo(host, 'B').length === 1)

    // 넣은 것을 처리하는 동안 또 오면 기다린다
    relay.turnComplete('A', '둘째', 'claude')
    relay.turnComplete('A', '셋째', 'claude')
    check('처리 중이면 다음 것을 기다린다', pastedTo(host, 'B').length === 1)
    clock += 1000
    relay.statusChanged('B')
    check('넣자마자의 한가함은 믿지 않는다', pastedTo(host, 'B').length === 1)
    relay.turnComplete('B', '', 'codex')
    const last = pastedTo(host, 'B').at(-1) ?? ''
    check('받는 쪽이 턴을 끝내면 모인 것을 한 번에 넣는다', pastedTo(host, 'B').length === 2 && last.includes('둘째') && last.includes('셋째'))

    // 훅이 없는 받는 쪽 — 상태가 풀리고 충분히 지나면 끝났다고 본다
    relay.turnComplete('A', '넷째', 'claude')
    clock += 5000
    relay.statusChanged('B')
    check('훅이 없어도 상태가 풀리면 넣는다', pastedTo(host, 'B').length === 3)
  }

  // ── 권한 질문에 붙여 넣지 않는다 (P29-5) ──────────────────────
  {
    const { host, relay } = make()
    relay.setMode('A', 'B', 'forward')
    host.status.set('B', 'attention')
    relay.turnComplete('A', '확인해 주세요', 'claude')
    check('확인 필요(권한 질문)면 기다린다', pastedTo(host, 'B').length === 0)
    relay.turnComplete('B', '', 'codex')
    check('턴을 끝낸 뒤의 확인 필요는 넣어도 된다', pastedTo(host, 'B').length === 1)
  }

  // ── 핑퐁 제한 (P29-6) ────────────────────────────────────────
  {
    const { host, relay } = make(3)
    relay.setMode('A', 'B', 'both')
    const volley = (): void => {
      relay.turnComplete('A', 'ping', 'claude')
      relay.turnComplete('B', 'pong', 'codex')
    }
    volley() // 2번
    relay.turnComplete('A', 'ping', 'claude') // 3번
    check('상한까지는 넘긴다', relay.modeOf('A', 'B') === 'both')
    relay.turnComplete('B', 'pong', 'codex') // 4번째 — 멈춘다
    check('상한을 넘으면 두 방향 모두 끈다', relay.modeOf('A', 'B') === 'off')
    check('멈췄다고 양쪽에 알린다', host.notes.filter(([, t]) => t.includes('멈췄습니다')).length === 2)

    relay.setMode('A', 'B', 'both')
    volley()
    relay.noteInput('A', '\x1b[I') // 포커스 보고 — 사람 입력이 아니다
    volley()
    check('포커스 보고는 횟수를 되돌리지 않는다', relay.modeOf('A', 'B') === 'off')

    relay.setMode('A', 'B', 'both')
    volley()
    relay.noteInput('B', '좀 더 자세히\r')
    volley()
    check('사람이 끼면 다시 센다', relay.modeOf('A', 'B') === 'both')
  }

  // ── 끝내기 (P29-9) ───────────────────────────────────────────
  {
    const { host, relay } = make(3)
    relay.setMode('A', 'B', 'both')
    relay.turnComplete('A', '테스트를 고쳤습니다. 다음 할 일: 리뷰', 'claude')
    check('머리말이 끝내는 법을 알려 준다', pastedTo(host, 'B')[0]?.includes('[완료]'))
    relay.turnComplete('B', '  [완료] 리뷰했습니다. 문제 없습니다', 'codex')
    check('[완료]로 시작하면 넘기지 않는다', pastedTo(host, 'A').length === 0)
    check('대신 사람에게 알린다', host.notes.some(([id, t]) => id === 'B' && t.includes('[완료]')))
    check('연결은 켜 둔다', relay.modeOf('A', 'B') === 'both')
    relay.turnComplete('A', '[DONE] nothing more', 'claude')
    check('[DONE]도 끝내는 표시다', pastedTo(host, 'B').length === 1)
    relay.turnComplete('A', '결론: [완료] 표시는 첫머리에만 씁니다', 'claude')
    check('중간의 [완료]는 끝내는 표시가 아니다', pastedTo(host, 'B').length === 2)

    // 끝낸 뒤에는 핑퐁 횟수도 처음부터 센다
    relay.turnComplete('B', '[완료]', 'codex')
    for (let i = 0; i < 3; i++) relay.turnComplete('A', `일 ${i}`, 'claude')
    check('끝내면 핑퐁 횟수를 되돌린다', relay.modeOf('A', 'B') === 'both')
  }

  // ── 사람 입력 판정 ───────────────────────────────────────────
  check('글자는 사람 입력', isHumanInput('a'))
  check('Enter도 사람 입력', isHumanInput('\r'))
  check('방향키도 사람 입력', isHumanInput('\x1b[A'))
  check('포커스 보고는 아니다', !isHumanInput('\x1b[I') && !isHumanInput('\x1b[O'))
  check('장치 속성 응답은 아니다', !isHumanInput('\x1b[?1;2c'))

  // ── 저장과 복원 (P29-7) ──────────────────────────────────────
  {
    const dir = mkdtempSync(join(tmpdir(), 'cvmux-relay-'))
    const manager = new PtyManager({ defaultCwd: dir })
    const ids = manager.restore([
      { cwd: dir, title: 'claude' },
      { cwd: dir, title: 'codex' },
      { cwd: dir, title: '빌드' }
    ]) as string[]
    manager.relay.setMode(ids[0], ids[1], 'both')
    const saved = manager.serialize()
    check('연결은 순번으로 저장된다', saved[0].relayTo === 1 && saved[1].relayTo === 0 && saved[2].relayTo === undefined)
    check('메타에도 실린다', manager.metaOf(ids[0])?.relayTo === ids[1])

    const again = new PtyManager({ defaultCwd: dir })
    const next = again.restore(saved) as string[]
    check('복원하면 새 id로 다시 잇는다', again.relay.modeOf(next[0], next[1]) === 'both')

    await manager.close(ids[1])
    check('닫힌 세션으로 가던 연결은 끊긴다', manager.metaOf(ids[0])?.relayTo === null)

    // 상한에 걸려 앞의 세션이 잘려도 순번이 맞아야 한다
    const file = join(dir, 'sessions.json')
    const many = Array.from({ length: 34 }, (_, i) => ({
      cwd: dir,
      title: `s${i}`,
      relayTo: i === 33 ? 32 : i === 5 ? 0 : undefined
    }))
    writeFileSync(file, JSON.stringify({ version: 4, savedAt: 0, sessions: many, windows: [], notifications: [] }))
    const loaded = new SessionStore(file).load()!
    const last = loaded.sessions.at(-1)!
    check('잘린 만큼 순번을 당긴다', last.relayTo === loaded.sessions.length - 2, String(last.relayTo))
    const fifth = loaded.sessions.find((s) => s.title === 's5')
    check('잘려 나간 세션을 가리키던 연결은 버린다', fifth !== undefined && !('relayTo' in fifth))

    await manager.disposeAll()
    await again.disposeAll()
    rmSync(dir, { recursive: true, force: true })
  }

  // ── 훅 설치 (P29-8) ──────────────────────────────────────────
  {
    const home = mkdtempSync(join(tmpdir(), 'cvmux-home-'))
    const previous = process.env.USERPROFILE
    process.env.USERPROFILE = home
    const { installHooks, uninstallHooks, hooksStatus } = await import('../src/cli/hooks')

    mkdirSync(join(home, '.codex'), { recursive: true })
    const hooksFile = join(home, '.codex', 'hooks.json')
    writeFileSync(
      hooksFile,
      JSON.stringify({
        description: '내 훅',
        hooks: { Stop: [{ hooks: [{ type: 'command', command: 'python3 stop.py' }] }] }
      })
    )

    installHooks('codex')
    installHooks('codex')
    const installed = JSON.parse(readFileSync(hooksFile, 'utf8'))
    const stop = installed.hooks.Stop as Array<{ hooks: Array<{ command: string }> }>
    check('남의 Stop 훅은 그대로 둔다', stop.some((e) => e.hooks[0].command === 'python3 stop.py'))
    check('두 번 설치해도 하나만 건다', stop.filter((e) => e.hooks[0].command.startsWith('cvmux hooks')).length === 1)
    check('Codex에는 모르는 키를 넣지 않는다', !JSON.stringify(installed).includes('_cvmux'))
    check('Stop 훅이 턴 끝을 알린다', stop.some((e) => e.hooks[0].command === 'cvmux hooks notify --agent codex --stop'))
    check('상태가 설치됨으로 보인다', /codex\s+설치됨/.test(hooksStatus()))

    uninstallHooks('codex')
    const removed = JSON.parse(readFileSync(hooksFile, 'utf8'))
    check('제거하면 우리 것만 빠진다', removed.description === '내 훅' && removed.hooks.Stop.length === 1 && !removed.hooks.SessionStart)

    // 옛 Claude 설치가 남긴 표시도 알아본다
    mkdirSync(join(home, '.claude'), { recursive: true })
    const claudeFile = join(home, '.claude', 'settings.json')
    writeFileSync(
      claudeFile,
      JSON.stringify({ hooks: { Stop: [{ matcher: '', _cvmux: true, hooks: [{ type: 'command', command: 'cvmux hooks notify --agent claude --stop' }] }] } })
    )
    uninstallHooks('claude')
    check('옛 표시가 붙은 Claude 훅도 걷어낸다', !JSON.parse(readFileSync(claudeFile, 'utf8')).hooks)

    process.env.USERPROFILE = previous
    rmSync(home, { recursive: true, force: true })
  }

  console.log(results.join('\n'))
  console.log(`\n${results.length - failed}/${results.length} passed`)
  process.exit(failed === 0 ? 0 : 1)
}

void main()

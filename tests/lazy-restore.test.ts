/*
 * 복원한 세션은 볼 때 켠다 (POLICY.md P28) — 회귀 테스트.
 *
 * 앱을 켤 때 지난번 세션을 전부 띄우면 쓰지도 않을 PowerShell이 conhost까지
 * 하나에 80MB씩 쌓인다. 실제로 16개가 떠서 1.3GB를 먹고 있었다. 여기서 지키는
 * 것은 셋이다 — 복원은 프로세스를 하나도 띄우지 않고, 켜지 않은 채 다시
 * 저장해도 저장본이 그대로이며, 켜면 그때 셸이 뜬다.
 *
 * 셸 하나는 진짜로 띄운다. 켜는 길이 실제 PTY까지 닿는지는 흉내로 확인할 수 없다.
 *
 * 실행: npm test
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PtyManager } from '../src/core/pty-manager'
import {
  SessionStore,
  workspacesFromPersisted,
  workspacesToPersisted,
  type PersistedSession
} from '../src/core/store'

const results: string[] = []
let failed = 0

function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failed++
  results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `  ← ${detail}` : ''}`)
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'cvmux-lazy-'))

  // ── 복원은 아무것도 띄우지 않는다 (P28-1) ─────────────────────
  {
    const saved: PersistedSession[] = [
      { cwd: dir, title: '빌드', agent: { name: 'claude', sessionId: 'abc-123' } },
      { cwd: dir, title: null }
    ]

    const manager = new PtyManager({ defaultCwd: dir })
    const ids = manager.restore(saved)
    const [first, second] = ids as [string, string]

    check('복원한 세션은 전부 자리를 받는다', ids.every((id) => id !== null))
    check(
      '복원은 셸을 띄우지 않는다',
      manager.list().every((m) => m.status === 'dormant' && m.shell === '')
    )
    check('켜지 않은 세션은 실행 중으로 세지 않는다', manager.busyCount() === 0)
    check('복원한 세션은 이전 화면 없이 빈 채로 온다 (P16-5)', manager.snapshot(first)?.replay === '')

    // 켜지 않고 껐다 켜기를 되풀이해도 에이전트 연결을 잃으면 안 된다
    const again = manager.serialize()
    check(
      '켜지 않은 채 다시 저장하면 저장본 그대로다',
      JSON.stringify(again) === JSON.stringify(saved),
      JSON.stringify(again)
    )

    manager.setTitle(second, '이름')
    check('그새 바꾼 이름은 저장본에 실린다', manager.serialize()[1].title === '이름')

    // ── 켜는 길 (P28-2) ──────────────────────────────────────
    check('wake는 켜지 않은 세션을 켠다', manager.wake(first))
    check('이미 켠 세션은 다시 켜지 않는다', !manager.wake(first))
    check('없는 세션은 켜지 않는다', !manager.wake('nope'))

    const woken = manager.metaOf(first)
    check('켜면 dormant를 벗는다', woken?.status !== 'dormant', woken?.status)
    check('켜면 셸이 뜬다', (woken?.shell ?? '') !== '', woken?.warning ?? '')
    check('켜면 저장본을 놓는다 — 이제 살아 있는 화면이 저장된다', manager.serialize()[0].agent === undefined)
    check('나머지는 여전히 꺼져 있다', manager.metaOf(second)?.status === 'dormant')
    check(
      '켠 세션을 저장해도 화면은 적지 않는다 (P16-5)',
      JSON.stringify(Object.keys(manager.serialize()[0])) === '["cwd","title"]',
      JSON.stringify(manager.serialize()[0])
    )

    // ── 입력이 오면 켠다 (P28-4) ─────────────────────────────
    manager.write(second, '')
    check('입력을 받은 세션은 켜진다', manager.metaOf(second)?.status !== 'dormant')

    await manager.disposeAll()
  }

  // ── 새로 만든 세션은 바로 켠다 (P28-7) ────────────────────────
  {
    const manager = new PtyManager({ defaultCwd: dir })
    const created = manager.create({ cwd: dir })
    check('새 세션은 켜진 채로 태어난다', created.ok && created.session?.status !== 'dormant')
    await manager.disposeAll()
  }

  // ── 고정은 저장되고 되살아난다 (P28-3) ────────────────────────
  {
    const leaf = { kind: 'leaf' as const, sessionIndexes: [0], active: 0 }
    const restored = workspacesFromPersisted(
      [
        { title: null, root: leaf, focusedIndex: 0, autostart: true },
        { title: null, root: { ...leaf, sessionIndexes: [1] }, focusedIndex: 1 }
      ],
      ['s1', 's2']
    )
    check('고정한 워크스페이스는 고정된 채 돌아온다', restored[0].autostart === true)
    check('고정하지 않은 것은 그대로', restored[1].autostart === false)

    const back = workspacesToPersisted(restored, ['s1', 's2'])
    check('고정은 저장된다', back[0].autostart === true && back[1].autostart === false)

    const file = join(dir, 'sessions.json')
    writeFileSync(
      file,
      JSON.stringify({
        version: 4,
        savedAt: 0,
        sessions: [{ cwd: dir, title: null, scrollback: 'PS> npm test\r\nok\r\n' }],
        windows: [{ workspaces: [{ title: null, root: leaf, focusedIndex: 0, autostart: true }] }],
        notifications: []
      })
    )
    const loaded = new SessionStore(file).load()
    check('파일에서도 고정을 읽는다', loaded?.windows[0]?.workspaces[0]?.autostart === true)
    check(
      '옛 파일의 스크롤백은 읽지 않는다 (P16-6)',
      loaded !== null && !('scrollback' in loaded.sessions[0]),
      JSON.stringify(loaded?.sessions[0])
    )
  }

  rmSync(dir, { recursive: true, force: true })

  console.log(results.join('\n'))
  console.log(`\n${results.length - failed}/${results.length} passed`)
  process.exit(failed === 0 ? 0 : 1)
}

void main()

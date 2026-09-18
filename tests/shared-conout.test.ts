/*
 * ConPTY 출력 중계를 Worker 하나로 모은다 (POLICY.md P8-7) — 회귀 테스트.
 *
 * node-pty는 세션마다 Worker 스레드를 띄워, 켜 둔 세션 6개가 main에서만 75MB를
 * 먹었다. 여기서 지키는 것은 셋이다 — 갈아 끼우기가 실제로 걸리고, 모든 세션이
 * 제 출력을 제대로 받으며, 하나를 닫아도 나머지 출력이 끊기지 않는다.
 *
 * 셸은 진짜로 띄운다. 파이프가 실제로 이어지는지는 흉내로 확인할 수 없다.
 *
 * 실행: npm test
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PtyManager } from '../src/core/pty-manager'
import { sharedConoutCount } from '../src/core/shared-conout'

const results: string[] = []
let failed = 0

function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failed++
  results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `  ← ${detail}` : ''}`)
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function waitFor(test: () => boolean, ms = 15_000): Promise<boolean> {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (test()) return true
    await sleep(200)
  }
  return test()
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'cvmux-conout-'))
  const manager = new PtyManager({ defaultCwd: dir })

  const connection = require('node-pty/lib/windowsConoutConnection') as {
    ConoutConnection: { name: string }
  }
  check('node-pty의 중계를 갈아 끼웠다', connection.ConoutConnection.name === 'SharedConoutConnection')

  const ids = [0, 1, 2].map((i) => {
    const result = manager.create({ cwd: dir, title: `s${i}` })
    return result.ok && result.session ? result.session.id : ''
  })
  check('세션 셋이 뜬다', ids.every(Boolean))
  check('중계는 세션 셋을 맡는다', sharedConoutCount() === 3, String(sharedConoutCount()))

  const screen = (id: string): string => manager.snapshot(id)?.replay ?? ''
  // 셸이 입력을 받을 준비가 되기 전에 쓰면 PSReadLine이 먹는다 — 프롬프트를 기다린다
  await waitFor(() => ids.every((id) => screen(id).includes('PS ')))

  ids.forEach((id, i) => manager.write(id, `echo CONOUT-${i}-OK\r`))
  const all = await waitFor(() => ids.every((id, i) => screen(id).includes(`CONOUT-${i}-OK`)))
  check('세션마다 제 출력을 받는다', all)
  check(
    '남의 출력이 섞이지 않는다',
    ids.every((id, i) => [0, 1, 2].every((j) => j === i || !screen(id).includes(`CONOUT-${j}-OK`)))
  )

  // ── 하나를 닫아도 나머지는 계속 받는다 ──────────────────────────
  await manager.close(ids[0])
  await sleep(1500)
  check('닫은 세션은 중계에서 빠진다', sharedConoutCount() === 2, String(sharedConoutCount()))

  manager.write(ids[1], 'echo AFTER-CLOSE\r')
  check('닫은 뒤에도 다른 세션의 출력이 온다', await waitFor(() => screen(ids[1]).includes('AFTER-CLOSE')))

  await manager.disposeAll()
  await sleep(1500)
  check('모두 닫으면 중계도 빈다', sharedConoutCount() === 0, String(sharedConoutCount()))

  rmSync(dir, { recursive: true, force: true })

  console.log(results.join('\n'))
  console.log(`\n${results.length - failed}/${results.length} passed`)
  process.exit(failed === 0 ? 0 : 1)
}

void main()

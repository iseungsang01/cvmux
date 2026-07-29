/*
 * 프로세스 트리에서 "따로 도는 셸"을 가려내는 규칙의 회귀 테스트 (POLICY.md P14-13).
 *
 * 규칙 둘 다 실제 트리를 관찰해서 나왔다. 에이전트 세션 아래에서 70초 동안
 * 셸이 169개 떴다 사라졌는데, 그중 알리고 싶은 것은 몇 개뿐이었다:
 *
 *   도구 호출·git 등      0.1 ~ 5초    ← 소음
 *   상태줄 훅            최대 12.9초   ← 소음
 *   에이전트의 상주 셸    628초 / 3632초 ← 신호
 *
 * 규칙이 무너지면 두 방향으로 거짓말을 한다 — 소음을 세면 칩이 몇 초마다
 * 깜빡이고(P4-15에서 고친 그 병), 손자까지 못 따라가면 정작 claude가
 * 돌리는 셸을 놓친다.
 *
 * 실행: npm test
 */
import { shellNamesUnder, type ProcessSnapshot } from '../src/core/port-probe'
import { POLICY } from '@shared/policy'

const results: string[] = []
let failed = 0

function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failed++
  results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `  ← ${detail}` : ''}`)
}

const NOW = 1_800_000_000_000
/** 문턱을 넘긴 나이 / 못 넘긴 나이 */
const OLD = NOW - POLICY.SHELL_MIN_AGE_MS - 1000
const YOUNG = NOW - 12_900 // 관측된 상태줄 훅의 최대 수명

/** [pid, ppid, name, startedAt] 목록으로 스냅샷을 만든다 — WMI 출력과 같은 모양 */
function snapshot(rows: Array<[number, number, string, number]>): ProcessSnapshot {
  const children = new Map<number, number[]>()
  const info = new Map<number, { name: string; startedAt: number }>()
  for (const [pid, ppid, name, startedAt] of rows) {
    info.set(pid, { name, startedAt })
    const list = children.get(ppid)
    if (list) list.push(pid)
    else children.set(ppid, [pid])
  }
  return { children, info }
}

function main(): void {
  /*
   * 실제로 관측된 모양이다. cvmux 세션의 셸(100) 아래 claude가 붙고(200),
   * claude가 명령을 돌리려고 자기 셸을 띄운다(300).
   */
  {
    const snap = snapshot([
      [100, 1, 'powershell.exe', OLD],
      [150, 100, 'conhost.exe', OLD],
      [200, 100, 'claude.exe', OLD],
      [300, 200, 'powershell.exe', OLD],
      [350, 300, 'conhost.exe', OLD]
    ])
    const shells = shellNamesUnder(snap, 100, NOW)
    check('P14-13 손자로 뜬 셸을 찾는다', shells.length === 1, JSON.stringify(shells))
    check('P14-13 이름에서 .exe를 뗀다', shells[0] === 'powershell', String(shells[0]))
  }

  // 세션 셸만 있으면 아무것도 없다 — 뿌리를 세면 모든 줄에 칩이 붙는다
  {
    const snap = snapshot([
      [100, 1, 'powershell.exe', OLD],
      [150, 100, 'conhost.exe', OLD]
    ])
    check('P14-13 세션 자신의 셸은 세지 않는다', shellNamesUnder(snap, 100, NOW).length === 0)
  }

  // 셸이 아닌 자손(에이전트 본체, 빌드 프로세스)은 셸이 아니다
  {
    const snap = snapshot([
      [100, 1, 'powershell.exe', OLD],
      [200, 100, 'claude.exe', OLD],
      [210, 200, 'node.exe', OLD],
      [220, 210, 'esbuild.exe', OLD]
    ])
    check('P14-13 셸이 아닌 자손은 세지 않는다', shellNamesUnder(snap, 100, NOW).length === 0)
  }

  /*
   * Git for Windows의 bash는 `bin/bash.exe`가 `usr/bin/bash.exe`를 다시 띄운다.
   * 그대로 세면 명령 하나가 둘로 보인다 — 실제 트리에서 628초짜리 한 쌍,
   * 3632초짜리 세 겹으로 관측됐다.
   */
  {
    const snap = snapshot([
      [100, 1, 'powershell.exe', OLD],
      [200, 100, 'claude.exe', OLD],
      [300, 200, 'bash.exe', OLD], // bin/bash.exe
      [310, 300, 'bash.exe', OLD], // usr/bin/bash.exe
      [320, 310, 'node.exe', OLD],
      [330, 320, 'cmd.exe', OLD] // 그 안에서 또 부른 git
    ])
    const shells = shellNamesUnder(snap, 100, NOW)
    check('P14-13 셸 안의 셸은 다시 세지 않는다', shells.length === 1, JSON.stringify(shells))
  }

  // 잠깐 스쳐가는 셸(상태줄 훅)은 세지 않는다 — 세면 칩이 몇 초마다 깜빡인다
  {
    const snap = snapshot([
      [100, 1, 'powershell.exe', OLD],
      [200, 100, 'claude.exe', OLD],
      [300, 200, 'bash.exe', YOUNG]
    ])
    check('P14-13 12.9초짜리 훅은 세지 않는다', shellNamesUnder(snap, 100, NOW).length === 0)
  }

  // 문턱을 넘기면 그때부터 센다
  {
    const snap = snapshot([
      [100, 1, 'powershell.exe', OLD],
      [200, 100, 'claude.exe', OLD],
      [300, 200, 'bash.exe', NOW - POLICY.SHELL_MIN_AGE_MS]
    ])
    check('P14-13 문턱을 넘긴 셸은 센다', shellNamesUnder(snap, 100, NOW).length === 1)
  }

  // 시작 시각을 모르면 감추지 않는다 — 모른다고 숨기면 진짜 셸을 놓친다
  {
    const snap = snapshot([
      [100, 1, 'powershell.exe', OLD],
      [200, 100, 'claude.exe', OLD],
      [300, 200, 'bash.exe', 0]
    ])
    check('P14-13 시작 시각을 모르면 세어 둔다', shellNamesUnder(snap, 100, NOW).length === 1)
  }

  // 여러 개면 개수가 그대로 보여야 한다 — "몇 개가 돌고 있나"가 질문이다
  {
    const snap = snapshot([
      [100, 1, 'powershell.exe', OLD],
      [200, 100, 'claude.exe', OLD],
      [300, 200, 'bash.exe', OLD],
      [400, 200, 'cmd.exe', OLD],
      [500, 200, 'pwsh.exe', OLD]
    ])
    const shells = shellNamesUnder(snap, 100, NOW)
    check('P14-13 나란히 뜬 셸은 모두 센다', shells.length === 3, JSON.stringify(shells))
    check('P14-13 정렬해서 돌려준다', shells.join(',') === 'bash,cmd,pwsh', shells.join(','))
  }

  // 다른 세션의 셸이 섞이면 안 된다
  {
    const snap = snapshot([
      [100, 1, 'powershell.exe', OLD],
      [101, 1, 'powershell.exe', OLD],
      [200, 101, 'claude.exe', OLD],
      [300, 200, 'bash.exe', OLD]
    ])
    check('P14-13 남의 트리는 보지 않는다', shellNamesUnder(snap, 100, NOW).length === 0)
    check('P14-13 자기 트리는 본다', shellNamesUnder(snap, 101, NOW).length === 1)
  }

  /*
   * PID가 재사용되면 부모-자식 관계가 고리를 이룰 수 있다. 순회가 멈추지
   * 않으면 워커가 통째로 굳는다 — 조사 하나가 앱을 멈추면 안 된다(P0-5).
   */
  {
    const snap = snapshot([
      [100, 200, 'powershell.exe', OLD],
      [200, 100, 'bash.exe', OLD]
    ])
    check('P14-13 순환 트리에서도 끝난다', shellNamesUnder(snap, 100, NOW).length === 1)
  }

  // pid를 모르는 세션(아직 안 떴거나 죽었다)은 조용히 빈손
  {
    const snap = snapshot([[100, 1, 'powershell.exe', OLD]])
    check('P14-13 알 수 없는 pid는 빈 목록', shellNamesUnder(snap, Number.NaN, NOW).length === 0)
  }

  console.log(results.join('\n'))
  console.log(`\n${results.length - failed}/${results.length} passed`)
  process.exit(failed === 0 ? 0 : 1)
}

main()

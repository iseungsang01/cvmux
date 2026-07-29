/*
 * 사이드바가 "어디인가"에 답하는 방식(POLICY.md P19-1 / P19-7)의 회귀 테스트.
 *
 * 저장소 이름만 적던 시절에는 `cd`로 하위 폴더에 들어가도 사이드바가 꿈쩍하지
 * 않았다. 움직였는데 화면이 그대로면 사용자는 추적이 고장 났다고 읽는다 —
 * 실제로 cwd는 정확히 따라가고 있었는데도. 그 회귀를 여기서 막는다.
 *
 * 실행: npm test
 */
import type { GitInfo, SessionMeta } from '../src/shared/types'
import { repoRelativePath, shortenPath, statusLabel, whereLabel } from '../src/renderer/lib/format'

const results: string[] = []
let failed = 0

function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failed++
  results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `  ← ${detail}` : ''}`)
}

function git(overrides: Partial<GitInfo> = {}): GitInfo {
  return {
    repo: 'cvmux',
    root: 'C:\\Users\\lss\\Documents\\GitHub\\cvmux',
    branch: 'main',
    detached: false,
    dirty: false,
    ahead: 0,
    behind: 0,
    operation: null,
    ...overrides
  }
}

function session(cwd: string, gitInfo: GitInfo | null): SessionMeta {
  return {
    id: 's1',
    title: 'session',
    userTitle: null,
    cwd,
    shell: 'pwsh.exe',
    status: 'idle',
    confidence: 'certain',
    preview: '',
    unread: false,
    exitCode: null,
    exitSignal: null,
    warning: null,
    altScreen: false,
    git: gitInfo,
    ports: [],
    createdAt: 0
  }
}

function main(): void {
  // ── P13-12: 저장소 루트로부터의 상대 경로
  {
    const root = 'C:\\Users\\lss\\Documents\\GitHub\\cvmux'
    check('루트 자신이면 상대 경로 없음', repoRelativePath(root, root) === null)
    check(
      '하위 폴더',
      repoRelativePath(root, `${root}\\src\\core`) === 'src\\core',
      String(repoRelativePath(root, `${root}\\src\\core`))
    )
    // Windows 경로는 대소문자를 가리지 않는다
    check(
      '대소문자가 달라도 같은 자리',
      repoRelativePath(root, 'c:\\users\\lss\\documents\\github\\cvmux') === null
    )
    check(
      '끝에 붙은 구분자를 무시',
      repoRelativePath(`${root}\\`, `${root}\\src`) === 'src',
      String(repoRelativePath(`${root}\\`, `${root}\\src`))
    )
    // 이름이 같은 접두어에 속아 넘어가면 안 된다 — cvmux-old는 cvmux 안이 아니다
    check(
      '이름이 겹치는 형제 폴더는 밖',
      repoRelativePath(root, 'C:\\Users\\lss\\Documents\\GitHub\\cvmux-old') === null
    )
    check('저장소 밖', repoRelativePath(root, 'C:\\Windows\\System32') === null)
    check('bare 저장소(root 없음)', repoRelativePath(null, 'C:\\anything') === null)
  }

  // ── P19-7: 사이드바 한 줄이 적는 "어디인가"
  {
    const root = 'C:\\Users\\lss\\Documents\\GitHub\\cvmux'

    check('루트에서는 저장소 이름만', whereLabel(session(root, git())) === 'cvmux')

    const inner = whereLabel(session(`${root}\\src\\core`, git()))
    check('하위 폴더가 이름 뒤에 붙는다', inner === 'cvmux\\src\\core', inner)

    // 깊이 들어가면 끝 두 단계만 — 한 줄에 들어가야 읽힌다. P11-3
    const deep = whereLabel(session(`${root}\\a\\b\\c\\d`, git()))
    check('깊은 경로는 끝 두 단계로 줄인다', deep === 'cvmux\\…\\c\\d', deep)

    // cd로 저장소를 벗어나면 저장소 정보 자체가 사라진다(git=null) — 축약 경로로 답한다. P19-4
    const outside = whereLabel(session('C:\\Windows\\System32', null))
    check('저장소가 아니면 축약 경로', outside === shortenPath('C:\\Windows\\System32'), outside)

    // 같은 저장소의 다른 자리로 옮기면 표시도 달라져야 한다. 이것이 이 테스트의 이유다
    const before = whereLabel(session(root, git()))
    const after = whereLabel(session(`${root}\\src`, git()))
    check('cd 하면 표시가 바뀐다', before !== after, `${before} → ${after}`)
  }

  // ── P19-6: idle과 waiting은 눈으로 구분되어야 한다
  {
    const idle = statusLabel(session('C:\\', null))
    const waiting = statusLabel({ ...session('C:\\', null), status: 'waiting' })
    check('idle과 waiting의 문구가 다르다', idle !== waiting, `${idle} / ${waiting}`)
  }

  console.log(results.join('\n'))
  console.log(`\n${results.length - failed}/${results.length} passed`)
  process.exit(failed === 0 ? 0 : 1)
}

main()

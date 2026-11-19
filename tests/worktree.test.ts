/*
 * 작업마다 worktree 하나(POLICY.md P31)의 회귀 테스트.
 *
 * 임시 폴더에 진짜 저장소를 만들어 git을 그대로 부른다 — 이 기능이 하는 일의
 * 전부가 git을 제대로 부르는 것이라, 흉내 낸 git으로는 아무것도 확인하지 못한다.
 *
 * 실행: npm test
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  createWorktree,
  inspectWorktree,
  mainRootOf,
  removeWorktree,
  worktreePath,
  worktreeSlug
} from '../src/core/worktree'

const results: string[] = []
let failed = 0

function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failed++
  results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `  ← ${detail}` : ''}`)
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true })
}

async function main(): Promise<void> {
  // ── P31-2: 이름과 자리
  check('P31-2 슬래시는 하이픈', worktreeSlug('feat/login') === 'feat-login')
  check('P31-2 Windows가 받지 않는 글자', worktreeSlug('a:b*c?') === 'abc')
  check('P31-2 빈 이름', worktreeSlug('///') === 'worktree' && worktreeSlug('') === 'worktree')
  check(
    'P31-2 저장소 옆에 둔다',
    worktreePath('C:\\src\\app', 'feat/x') === join('C:\\src', 'app.worktrees', 'feat-x'),
    worktreePath('C:\\src\\app', 'feat/x')
  )
  check('P31-2 .git에서 저장소로', mainRootOf('C:/src/app/.git') === join('C:\\src', 'app'), mainRootOf('C:/src/app/.git'))
  check('P31-2 bare 저장소', mainRootOf('C:/src/app.git') === join('C:\\src', 'app'))

  // ── 진짜 저장소로
  const base = mkdtempSync(join(tmpdir(), 'cvmux-wt-'))
  const repo = join(base, 'app')
  try {
    execFileSync('git', ['init', '-q', '-b', 'main', repo], { windowsHide: true })
    git(repo, 'config', 'user.email', 'test@example.invalid')
    git(repo, 'config', 'user.name', 'cvmux test')
    git(repo, 'config', 'commit.gpgsign', 'false')
    writeFileSync(join(repo, 'a.txt'), 'a\n')
    git(repo, 'add', '.')
    git(repo, 'commit', '-q', '-m', 'init')

    // P31-1: 새 브랜치로 만든다
    const made = await createWorktree(repo, 'feat/one')
    check('P31-1 만든다', made.ok, made.message)
    const path = made.path ?? ''
    check('P31-1 저장소 옆 자리', path === join(base, 'app.worktrees', 'feat-one'), path)
    check('P31-1 폴더가 생겼다', existsSync(join(path, 'a.txt')))
    check('P31-1 브랜치가 생겼다', git(repo, 'branch', '--list', 'feat/one').includes('feat/one'))

    // 작업 트리 안에서 또 만들어도 본 저장소 옆에 놓인다
    const nested = await createWorktree(path, 'feat/two')
    check('P31-1 작업 트리 안에서도 본 저장소 옆', nested.path === join(base, 'app.worktrees', 'feat-two'), nested.path)

    // 같은 자리에 두 번은 만들지 않는다
    const again = await createWorktree(repo, 'feat/one')
    check('P31-1 이미 있는 자리는 덮지 않는다', !again.ok, again.message)

    const bad = await createWorktree(repo, 'bad name..')
    check('P31-1 이름이 잘못되면 거절', !bad.ok, bad.message)
    const outside = await createWorktree(base, 'x')
    check('P31-1 저장소가 아니면 거절', !outside.ok, outside.message)

    // ── P31-3: 지우기
    const main = await inspectWorktree(repo)
    check('P31-3 본 저장소는 지우지 않는다', !main.ok, main.message)

    writeFileSync(join(path, 'dirty.txt'), 'x')
    const dirty = await inspectWorktree(path)
    check('P31-3 변경이 있으면 지우지 않는다', !dirty.ok, dirty.message)
    rmSync(join(path, 'dirty.txt'))

    const ok = await inspectWorktree(path)
    check('P31-3 깨끗하면 지울 수 있다', ok.ok && ok.target?.branch === 'feat/one', ok.message)
    if (ok.target) {
      const removed = await removeWorktree(ok.target)
      check('P31-3 지웠다', removed.ok && !existsSync(path), removed.message)
      check('P31-3 합쳐진 브랜치도 지운다', !git(repo, 'branch', '--list', 'feat/one').includes('feat/one'), removed.message)
    }

    // 합쳐지지 않은 커밋이 있는 브랜치는 남긴다
    const twoPath = nested.path ?? ''
    writeFileSync(join(twoPath, 'b.txt'), 'b\n')
    git(twoPath, 'add', '.')
    git(twoPath, 'commit', '-q', '-m', 'work')
    const two = await inspectWorktree(twoPath)
    if (two.target) {
      const removed = await removeWorktree(two.target)
      check('P31-3 작업 트리는 지웠다', removed.ok && !existsSync(twoPath), removed.message)
      check(
        'P31-3 합쳐지지 않은 브랜치는 남긴다',
        git(repo, 'branch', '--list', 'feat/two').includes('feat/two') && (removed.message ?? '').includes('남겼'),
        removed.message
      )
    } else {
      check('P31-3 두 번째 작업 트리 확인', false, two.message)
    }
  } finally {
    rmSync(base, { recursive: true, force: true })
  }

  console.log(results.join('\n'))
  console.log(`\n${results.length - failed}/${results.length} passed`)
  process.exit(failed === 0 ? 0 : 1)
}

void main()

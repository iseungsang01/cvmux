import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { basename, dirname, join, normalize } from 'node:path'

import type { WorktreeResult } from '@shared/types'
import { isLinkedWorktree } from './git-probe'

export type { WorktreeResult }

/**
 * 작업마다 git worktree 하나 (POLICY.md P31).
 *
 * Orca가 세운 방식이다 — 에이전트 여럿이 한 저장소에서 서로의 파일을 밟지 않게,
 * 일 하나에 작업 트리 하나를 주고 그 자리에 워크스페이스를 연다. Orca는 diff
 * 뷰어·PR 패널·편집기까지 얹지만 여기서는 **만들고 지우는 것만** 한다. 나머지는
 * 그 자리에서 도는 셸과 에이전트가 이미 할 수 있다.
 *
 * 네트워크를 쓰지 않는다(fetch 없음). 새 브랜치는 지금 보고 있는 자리의 HEAD에서
 * 갈라진다 — 다른 곳에서 갈라지려면 `base`를 준다.
 */

const GIT_TIMEOUT_MS = 10_000
/** 체크아웃은 저장소 크기만큼 걸린다 */
const ADD_TIMEOUT_MS = 120_000

interface GitResult {
  ok: boolean
  out: string
  err: string
}

function git(args: string[], cwd: string, timeout = GIT_TIMEOUT_MS): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      { cwd, windowsHide: true, timeout, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' },
      (error, stdout, stderr) => resolve({ ok: !error, out: stdout ?? '', err: stderr ?? '' })
    )
  })
}

function fail(message: string): WorktreeResult {
  return { ok: false, message }
}

/** git이 남긴 오류의 요지 — 첫 줄의 `fatal:` 머리를 뗀다 */
function reason(err: string): string {
  const line = err.split(/\r?\n/).find((l) => l.trim() !== '') ?? ''
  return line.replace(/^(fatal|error):\s*/i, '').trim()
}

/**
 * 브랜치 이름을 폴더 이름으로 (P31-2).
 *
 * `feat/login`은 폴더 둘이 아니라 하나(`feat-login`)여야 목록에서 한눈에 보인다.
 * Windows가 받지 않는 글자는 걷어낸다.
 */
export function worktreeSlug(branch: string): string {
  const slug = branch
    .trim()
    .replace(/[\\/]+/g, '-')
    .replace(/[<>:"|?*\x00-\x1f]/g, '')
    .replace(/[. ]+$/, '')
    .replace(/^-+|-+$/g, '')
  return slug || 'worktree'
}

/**
 * 작업 트리가 놓일 자리 (P31-2).
 *
 * 저장소 **옆**의 `<저장소>.worktrees\<브랜치>`. 저장소 안에 두면 본 저장소의
 * `git status`와 검색·빌드 도구가 그것을 다시 훑는다. 한곳(`~/…/worktrees`)에
 * 모으면 어느 저장소의 것인지 이름만으로 알 수 없다.
 */
export function worktreePath(mainRoot: string, branch: string): string {
  return join(dirname(mainRoot), `${basename(mainRoot)}.worktrees`, worktreeSlug(branch))
}

/** `--git-common-dir`(본 저장소의 .git)에서 본 저장소 자리를 되짚는다 */
export function mainRootOf(commonDir: string): string {
  const dir = normalize(commonDir.trim()).replace(/[\\/]+$/, '')
  return basename(dir).toLowerCase() === '.git' ? dirname(dir) : dir.replace(/\.git$/i, '')
}

/**
 * 작업 트리를 만든다 (P31-1).
 *
 * 브랜치가 이미 있으면 그것을 꺼내고, 없으면 새로 판다. 자리에 이미 무엇이 있으면
 * 덮지 않는다.
 */
export async function createWorktree(cwd: string, branch: string, base?: string): Promise<WorktreeResult> {
  const name = branch.trim()
  if (!name) return fail('브랜치 이름이 비었습니다')

  const valid = await git(['check-ref-format', '--branch', name], cwd)
  if (!valid.ok) {
    return fail(valid.err.includes('not a git') ? 'git 저장소가 아닙니다' : `브랜치 이름으로 쓸 수 없습니다: ${name}`)
  }

  const common = await git(['rev-parse', '--path-format=absolute', '--git-common-dir'], cwd)
  if (!common.ok) return fail('git 저장소가 아닙니다')
  const path = worktreePath(mainRootOf(common.out), name)
  if (existsSync(path)) return fail(`이미 있는 폴더입니다: ${path}`)

  const known = await git(['show-ref', '--verify', '--quiet', `refs/heads/${name}`], cwd)
  const args = known.ok
    ? ['worktree', 'add', path, name]
    : ['worktree', 'add', '-b', name, path, ...(base ? [base] : [])]
  const added = await git(args, cwd, ADD_TIMEOUT_MS)
  if (!added.ok) return fail(reason(added.err) || 'git worktree add가 실패했습니다')

  return { ok: true, path, branch: name, message: known.ok ? '있던 브랜치를 꺼냈습니다' : undefined }
}

/** 지울 수 있는 작업 트리의 정보. 확인을 거친 것만 지운다 */
export interface RemovableWorktree {
  path: string
  mainRoot: string
  branch: string | null
}

/**
 * 지워도 되는 작업 트리인가 (P31-3).
 *
 * 세션을 닫기 **전에** 묻는다 — 셸을 다 죽인 뒤에 "변경이 있어 못 지운다"고 하면
 * 사람은 일하던 자리만 잃는다. 본 저장소는 어떤 경우에도 지우지 않는다.
 */
export async function inspectWorktree(cwd: string): Promise<WorktreeResult & { target?: RemovableWorktree }> {
  const top = await git(['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-dir', '--git-common-dir'], cwd)
  if (!top.ok) return fail('git 저장소가 아닙니다')
  const [root, gitDir, commonDir] = top.out.split(/\r?\n/).map((l) => l.trim())
  if (!root || !gitDir || !commonDir || !isLinkedWorktree(gitDir)) {
    return fail('git worktree로 만든 작업 트리가 아닙니다 — 본 저장소는 지우지 않습니다')
  }

  const status = await git(['status', '--porcelain'], root)
  if (!status.ok) return fail(reason(status.err) || '작업 트리 상태를 읽지 못했습니다')
  if (status.out.trim() !== '') return fail('커밋하지 않은 변경이 있어 지우지 않습니다')

  const head = await git(['symbolic-ref', '--quiet', '--short', 'HEAD'], root)
  return {
    ok: true,
    path: normalize(root),
    target: { path: normalize(root), mainRoot: mainRootOf(commonDir), branch: head.ok ? head.out.trim() : null }
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * 작업 트리를 지우고, 다 합쳐진 브랜치면 브랜치도 지운다 (P31-3).
 *
 * 합쳐지지 않은 브랜치는 남긴다(`branch -d`가 거절한다) — 작업 트리는 다시 만들
 * 수 있지만 커밋은 그렇지 않다. 방금 닫은 셸이 폴더를 아직 쥐고 있을 수 있어
 * (Windows는 쓰는 중인 폴더를 지우지 못한다) 잠깐씩 몇 번 다시 해 본다.
 */
export async function removeWorktree(target: RemovableWorktree): Promise<WorktreeResult> {
  let removed: GitResult = { ok: false, out: '', err: '' }
  for (let attempt = 0; attempt < 5; attempt++) {
    removed = await git(['worktree', 'remove', target.path], target.mainRoot)
    if (removed.ok) break
    await sleep(400)
  }
  if (!removed.ok) return fail(reason(removed.err) || 'git worktree remove가 실패했습니다')

  if (target.branch === null) return { ok: true, path: target.path }
  const deleted = await git(['branch', '-d', target.branch], target.mainRoot)
  return {
    ok: true,
    path: target.path,
    branch: target.branch,
    message: deleted.ok
      ? `브랜치 ${target.branch}도 지웠습니다`
      : `브랜치 ${target.branch}는 합쳐지지 않아 남겼습니다`
  }
}

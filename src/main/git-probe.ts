import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { POLICY } from '@shared/policy'
import type { GitInfo } from '@shared/types'

/**
 * git 저장소 정보 조사 (POLICY.md P13).
 *
 * `git status --porcelain=v2 --branch` 한 번으로 브랜치·추적·ahead/behind·변경 여부를
 * 모두 얻는다. 진행 중인 작업(rebase 등)만 git 디렉토리의 파일 존재로 판별한다.
 */

function run(command: string, args: string[], cwd: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      {
        cwd,
        windowsHide: true,
        timeout: POLICY.GIT_TIMEOUT_MS, // P13-5
        maxBuffer: 4 * 1024 * 1024,
        encoding: 'utf8'
      },
      (error, stdout) => {
        if (error) {
          resolve(null)
          return
        }
        resolve(stdout)
      }
    )
  })
}

/** git 디렉토리 안의 흔적으로 진행 중인 작업을 판별한다. P13-4 */
function detectOperation(gitDir: string): string | null {
  if (existsSync(join(gitDir, 'rebase-merge')) || existsSync(join(gitDir, 'rebase-apply'))) {
    return 'rebase'
  }
  if (existsSync(join(gitDir, 'MERGE_HEAD'))) return 'merge'
  if (existsSync(join(gitDir, 'CHERRY_PICK_HEAD'))) return 'cherry-pick'
  if (existsSync(join(gitDir, 'REVERT_HEAD'))) return 'revert'
  if (existsSync(join(gitDir, 'BISECT_LOG'))) return 'bisect'
  return null
}

export class GitProbe {
  /** git이 아예 없는 환경에서 매번 실패하지 않도록 한 번만 판정한다. P13-2 */
  private available = true
  /** cwd → git 디렉토리 절대경로. null은 "저장소가 아님"을 캐시한 것. P13-1 */
  private readonly gitDirCache = new Map<string, string | null>()
  /** 세션별 진행 중인 조사 — 겹치면 건너뛴다. P13-6 */
  private readonly inFlight = new Set<string>()

  get enabled(): boolean {
    return this.available
  }

  /** cwd가 바뀌면 그 경로의 판정을 버린다. P13-7 */
  forget(cwd: string): void {
    this.gitDirCache.delete(cwd)
  }

  /**
   * @returns 저장소가 아니거나 조사에 실패하면 null (호출자는 이전 값을 유지한다)
   */
  async probe(sessionId: string, cwd: string): Promise<GitInfo | null> {
    if (!this.available) return null
    if (this.inFlight.has(sessionId)) return null // P13-6
    this.inFlight.add(sessionId)
    try {
      return await this.doProbe(cwd)
    } finally {
      this.inFlight.delete(sessionId)
    }
  }

  private async doProbe(cwd: string): Promise<GitInfo | null> {
    const gitDir = await this.resolveGitDir(cwd)
    if (!gitDir) return null

    const output = await run('git', ['status', '--porcelain=v2', '--branch'], cwd)
    // 타임아웃이나 실패 — 이전 결과를 유지하도록 null. P13-5
    if (output === null) return null

    return parseStatus(output, detectOperation(gitDir))
  }

  private async resolveGitDir(cwd: string): Promise<string | null> {
    const cached = this.gitDirCache.get(cwd)
    if (cached !== undefined) return cached

    const output = await run('git', ['rev-parse', '--absolute-git-dir'], cwd)
    if (output === null) {
      // git 자체가 없는지, 그냥 저장소가 아닌지 구분한다
      if (!(await this.checkGitInstalled())) {
        this.available = false
        return null
      }
      this.gitDirCache.set(cwd, null) // 저장소가 아님. P13-1
      return null
    }

    const gitDir = output.trim()
    this.gitDirCache.set(cwd, gitDir)
    return gitDir
  }

  private async checkGitInstalled(): Promise<boolean> {
    const output = await run('git', ['--version'], process.cwd())
    return output !== null
  }
}

/** `git status --porcelain=v2 --branch` 출력을 파싱한다 */
function parseStatus(output: string, operation: string | null): GitInfo {
  let branch = ''
  let oid = ''
  let detached = false
  let ahead = 0
  let behind = 0
  let dirty = false

  for (const line of output.split('\n')) {
    if (line.startsWith('# branch.oid ')) {
      oid = line.slice('# branch.oid '.length).trim()
    } else if (line.startsWith('# branch.head ')) {
      const head = line.slice('# branch.head '.length).trim()
      if (head === '(detached)') detached = true
      else branch = head
    } else if (line.startsWith('# branch.ab ')) {
      const ab = /\+(\d+)\s+-(\d+)/.exec(line)
      if (ab) {
        ahead = Number.parseInt(ab[1], 10)
        behind = Number.parseInt(ab[2], 10)
      }
    } else if (line.length > 0 && !line.startsWith('#')) {
      // 1/2/u/? 로 시작하는 변경 항목이 하나라도 있으면 dirty
      dirty = true
    }
  }

  // detached HEAD는 브랜치명 대신 짧은 해시. P13-3
  if (detached) {
    branch = oid && oid !== '(initial)' ? oid.slice(0, 7) : 'detached'
  } else if (!branch) {
    branch = oid === '(initial)' ? '(빈 저장소)' : 'HEAD'
  }

  return { branch, detached, dirty, ahead, behind, operation }
}

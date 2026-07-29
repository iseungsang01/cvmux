import { POLICY } from '@shared/policy'
import type { GitInfo, SessionMeta } from '@shared/types'

/**
 * 사이드바에 넣을 만큼 경로를 줄인다 (P11-3).
 * 긴 경로·UNC·유니코드 모두 표시만 줄이고 원본은 건드리지 않는다(P11-4 / P11-5).
 */
export function shortenPath(fullPath: string): string {
  if (!fullPath) return ''
  const isUnc = fullPath.startsWith('\\\\')
  const parts = fullPath.split(/[\\/]/).filter(Boolean)
  if (parts.length <= 2) return fullPath
  const tail = parts.slice(-2).join('\\')
  return isUnc ? `\\\\…\\${tail}` : `…\\${tail}`
}

/** 표시용으로 경로 표기를 하나로 맞춘다 — 끝의 구분자를 떼고 전부 역슬래시로 */
function normalizePath(value: string): string {
  return value.replace(/[\\/]+$/, '').replace(/\//g, '\\')
}

/**
 * 저장소 루트에서 cwd까지의 상대 경로. 루트 자신이거나 밖이면 null (P13-12).
 *
 * Windows 경로는 대소문자를 가리지 않으므로 비교도 그래야 한다. 표시에는
 * 셸이 알려준 원래 표기를 그대로 쓴다 — 비교 때문에 사용자가 친 대소문자를
 * 바꿔 보여줄 이유는 없다.
 */
export function repoRelativePath(root: string | null, cwd: string): string | null {
  if (!root) return null
  const base = normalizePath(root)
  const here = normalizePath(cwd)
  if (here.toLowerCase() === base.toLowerCase()) return null
  if (!here.toLowerCase().startsWith(`${base.toLowerCase()}\\`)) return null
  return here.slice(base.length + 1)
}

/**
 * "어디인가"에 답하는 한 줄 (P19-1 / P19-7).
 *
 * 저장소 이름만 적으면 `cd`로 하위 폴더에 들어간 것이 사이드바에 전혀
 * 드러나지 않는다 — 움직였는데 화면이 그대로면 추적이 고장 난 것처럼 보인다.
 * 저장소 안에서는 루트로부터의 상대 경로를 뒤에 붙여 지금 선 자리를 적는다.
 */
export function whereLabel(session: SessionMeta): string {
  const { git, cwd } = session
  if (!git) return shortenPath(cwd)

  const relative = repoRelativePath(git.root, cwd)
  if (relative === null) return git.repo

  // 깊이 들어갔으면 끝의 두 단계만 — 한 줄에 들어가야 읽힌다. P11-3
  const parts = relative.split('\\')
  const tail = parts.length > 2 ? `…\\${parts.slice(-2).join('\\')}` : relative
  return `${git.repo}\\${tail}`
}

/** 종료된 세션의 배지 문구. P1-1 ~ P1-3 */
export function exitLabel(session: SessionMeta): string | null {
  if (session.status !== 'exited') return null
  if (session.exitSignal !== null) return `signal ${session.exitSignal}`
  if (session.exitCode !== null) return `exit ${session.exitCode}`
  return 'exited'
}

/** 종료 코드가 0이 아니면 실패로 본다 — 사이드바에서 색을 다르게 준다. P1-2 */
export function isFailedExit(session: SessionMeta): boolean {
  if (session.status !== 'exited') return false
  return session.exitSignal !== null || (session.exitCode !== null && session.exitCode !== 0)
}

/** 브랜치 옆 툴팁 문구. P13-9 (표시는 말줄임, 전체는 여기로) */
export function gitTooltip(git: GitInfo): string {
  const parts = [git.detached ? `detached at ${git.branch}` : `브랜치 ${git.branch}`]
  if (git.operation) parts.push(`${git.operation} 진행 중`)
  if (git.dirty) parts.push('변경사항 있음')
  if (git.ahead > 0) parts.push(`${git.ahead} 커밋 앞섬`)
  if (git.behind > 0) parts.push(`${git.behind} 커밋 뒤처짐`)
  return parts.join(' · ')
}

/** 포트는 오름차순 최대 3개, 나머지는 +N. P14-1 */
export function splitPorts(ports: number[]): { shown: number[]; extra: number } {
  const shown = ports.slice(0, POLICY.MAX_PORTS_SHOWN)
  return { shown, extra: ports.length - shown.length }
}

/**
 * 사이드바에 그대로 적히는 상태 문구 (P19-2 / P19-6).
 *
 * `idle`과 `waiting`은 눈으로 구분되어야 한다. 둘 다 "조용하다"지만 전혀 다른
 * 상황이다 — `idle`은 셸이 빈손으로 다음 명령을 기다리는 것이고, `waiting`은
 * 무언가가 **떠 있는 채로** 조용한 것이다. 후자가 곧 에이전트를 띄워두고
 * 아무 일도 일어나지 않는 상태다.
 */
export function statusLabel(session: SessionMeta): string {
  switch (session.status) {
    case 'busy':
      return session.altScreen ? '전체화면 앱' : '실행 중'
    case 'idle':
      return '셸 프롬프트'
    case 'waiting':
      return '대기 중'
    case 'attention':
      return '확인 필요'
    case 'exited':
      return exitLabel(session) ?? '종료됨'
  }
}

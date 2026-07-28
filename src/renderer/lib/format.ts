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
 * 사이드바에 그대로 적히는 상태 문구 (P19-2).
 *
 * `idle`을 그냥 "대기"라고 쓰면 `waiting`("입력 대기")과 눈으로 구분되지 않는다.
 * 둘은 전혀 다른 상황이다 — 하나는 셸이 다음 명령을 기다리는 평온한 상태이고,
 * 다른 하나는 무언가가 사용자의 답을 기다리는 중일지도 모르는 상태다.
 */
export function statusLabel(session: SessionMeta): string {
  switch (session.status) {
    case 'busy':
      return session.altScreen ? '전체화면 앱' : '실행 중'
    case 'idle':
      return '프롬프트 대기'
    case 'waiting':
      return '입력 대기 (추정)'
    case 'attention':
      return '확인 필요'
    case 'exited':
      return exitLabel(session) ?? '종료됨'
  }
}

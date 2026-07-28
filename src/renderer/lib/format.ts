import type { SessionMeta } from '@shared/types'

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

export function statusLabel(session: SessionMeta): string {
  switch (session.status) {
    case 'busy':
      return session.altScreen ? '전체화면 앱' : '실행 중'
    case 'idle':
      return '대기'
    case 'waiting':
      return '입력 대기 (추정)'
    case 'attention':
      return '확인 필요'
    case 'exited':
      return exitLabel(session) ?? '종료됨'
  }
}

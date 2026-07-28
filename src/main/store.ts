import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { POLICY } from '@shared/policy'

/**
 * 세션 목록을 디스크에 남긴다 (POLICY.md P16).
 *
 * 복원되는 것은 "어디서 무엇을 하고 있었는가"이지 프로세스가 아니다. 이전 셸은
 * 이미 죽었고 새 셸이 그 자리에 선다 — 복원된 스크롤백 뒤에 구분선을 넣어
 * 그 사실을 감추지 않는다(P16-6).
 */

export interface PersistedSession {
  cwd: string
  /** 사용자가 직접 지정한 제목만 저장한다. 셸이 설정한 제목은 다시 오면 그만 */
  title: string | null
  scrollback: string
}

export interface PersistedState {
  version: 1
  savedAt: number
  sessions: PersistedSession[]
}

/** 스크롤백을 상한까지 줄인다. 이스케이프 시퀀스 중간에서 자르면 화면이 깨지므로 개행에서 자른다. P16-5 */
export function trimScrollback(text: string): string {
  if (text.length <= POLICY.PERSIST_SCROLLBACK_BYTES) return text
  const cut = text.length - POLICY.PERSIST_SCROLLBACK_BYTES
  const newline = text.indexOf('\n', cut)
  return text.slice(newline === -1 ? cut : newline + 1)
}

export class SessionStore {
  constructor(private readonly filePath: string) {}

  /**
   * @returns 파일이 없거나 읽을 수 없으면 null — 빈 상태로 시작한다. P16-2
   */
  load(): PersistedState | null {
    if (!existsSync(this.filePath)) return null

    let raw: string
    try {
      raw = readFileSync(this.filePath, 'utf8')
    } catch (error) {
      console.warn('[cvmux] 세션 파일을 읽지 못했습니다:', error)
      return null
    }

    try {
      const parsed: unknown = JSON.parse(raw)
      return this.validate(parsed)
    } catch (error) {
      // 손상된 파일은 덮어쓰기 전에 남겨둔다 — 사용자의 작업 기록이었을 수 있다. P16-2
      console.warn('[cvmux] 세션 파일이 손상되었습니다. .bak으로 보존합니다:', error)
      try {
        copyFileSync(this.filePath, `${this.filePath}.bak`)
      } catch {
        // 백업 실패는 치명적이지 않다
      }
      return null
    }
  }

  /** 임시 파일에 쓰고 원자적으로 바꿔치기한다. 반쪽 파일을 남기지 않는다. P16-3 */
  save(state: PersistedState): void {
    try {
      mkdirSync(dirname(this.filePath), { recursive: true })
      const temp = `${this.filePath}.tmp`
      writeFileSync(temp, JSON.stringify(state), 'utf8')
      renameSync(temp, this.filePath)
    } catch (error) {
      // 저장 실패가 앱을 멈추게 해서는 안 된다. P12-2
      console.warn('[cvmux] 세션을 저장하지 못했습니다:', error)
    }
  }

  private validate(value: unknown): PersistedState | null {
    if (typeof value !== 'object' || value === null) return null
    const state = value as Partial<PersistedState>
    if (state.version !== 1 || !Array.isArray(state.sessions)) return null

    const sessions: PersistedSession[] = []
    for (const entry of state.sessions) {
      if (typeof entry !== 'object' || entry === null) continue
      const s = entry as Partial<PersistedSession>
      if (typeof s.cwd !== 'string' || !s.cwd) continue
      sessions.push({
        cwd: s.cwd,
        title: typeof s.title === 'string' ? s.title : null,
        scrollback: typeof s.scrollback === 'string' ? s.scrollback : ''
      })
    }

    // 오래된 것부터 잘라 상한을 지킨다. P16-7
    return {
      version: 1,
      savedAt: typeof state.savedAt === 'number' ? state.savedAt : 0,
      sessions: sessions.slice(-POLICY.MAX_SESSIONS)
    }
  }
}

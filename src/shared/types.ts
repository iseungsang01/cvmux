/**
 * main ↔ renderer 사이의 계약. 양쪽 모두 이 파일만 신뢰한다.
 */

/**
 * 세션 상태. 판정 신호의 확실성 순서는 POLICY.md P4 참조.
 *
 * - `busy`      출력이 흐르는 중 (추측 5순위)
 * - `idle`      프롬프트 대기 (추측 4순위 / OSC 133이면 확실 3순위)
 * - `waiting`   출력이 멎었으나 프롬프트가 아님 = 입력 대기 추정 (추측)
 * - `attention` OSC 9/777/99 또는 BEL로 명시적 알림을 받음 (확실 1순위)
 * - `exited`    프로세스 종료 (확실 2순위)
 */
export type SessionStatus = 'busy' | 'idle' | 'waiting' | 'attention' | 'exited'

/** 상태가 확실한 신호에서 왔는지, 휴리스틱 추측인지. P0-3 */
export type StatusConfidence = 'certain' | 'inferred'

/** 세션의 작업 디렉토리가 속한 git 저장소 상태. P13 */
export interface GitInfo {
  /** 브랜치명, detached면 짧은 커밋 해시. P13-3 */
  branch: string
  detached: boolean
  /** 커밋되지 않은 변경이 있는가 */
  dirty: boolean
  ahead: number
  behind: number
  /** rebase / merge / cherry-pick / revert / bisect 진행 중. P13-4 */
  operation: string | null
}

export interface SessionMeta {
  id: string
  /** 표시용 제목. userTitle이 있으면 그것, 없으면 셸이 OSC 0/2로 설정한 제목. P5-8 */
  title: string
  /** 사용자가 직접 지정한 제목. 있으면 셸의 제목 설정이 덮어쓰지 못한다. P5-8 */
  userTitle: string | null
  cwd: string
  shell: string
  status: SessionStatus
  confidence: StatusConfidence
  /** 사이드바에 보여줄 마지막 출력 줄 (제어문자 제거됨). P4-13 */
  preview: string
  /** 명시적 알림을 받았고 아직 사용자가 보지 않음. P4-1 / P4-4 */
  unread: boolean
  /** 정상 종료 시의 종료 코드. 신호 종료면 null. P1-1 / P1-2 */
  exitCode: number | null
  /** 신호로 종료된 경우의 신호 번호. P1-3 */
  exitSignal: number | null
  /** 사용자가 알아야 할 경고 (cwd 폴백, 셸 없음 등). P11-2 / P1-5 / P12-1 */
  warning: string | null
  /** 대체 화면 버퍼(vim/less 등) 안에 있는가. 프롬프트 휴리스틱이 꺼진 상태. P4-9 */
  altScreen: boolean
  /** cwd의 git 상태. 저장소가 아니거나 git이 없으면 null. P13-1 / P13-2 */
  git: GitInfo | null
  /** 이 세션의 프로세스 트리가 리슨 중인 포트 (오름차순). P14 */
  ports: number[]
  createdAt: number
}

export interface CreateSessionOptions {
  cwd?: string
  shell?: string
  title?: string
  cols?: number
  rows?: number
}

/** 생성 실패도 정상 응답으로 다룬다. 예외를 던져 렌더러를 죽이지 않는다. P1-8 / P12 */
export interface CreateSessionResult {
  ok: boolean
  session?: SessionMeta
  error?: string
}

/** 렌더러 재연결 시 화면을 되살리기 위한 스냅샷. P9-1 */
export interface SessionSnapshot {
  meta: SessionMeta
  replay: string
}

export interface SessionExitInfo {
  id: string
  exitCode: number | null
  exitSignal: number | null
}

export const IPC = {
  // renderer → main (invoke)
  LIST: 'session:list',
  SNAPSHOT: 'session:snapshot',
  CREATE: 'session:create',
  CLOSE: 'session:close',
  RESTART: 'session:restart',
  WRITE: 'session:write',
  RESIZE: 'session:resize',
  SET_TITLE: 'session:set-title',
  MARK_READ: 'session:mark-read',
  RESIZE_HINT: 'session:resize-hint',
  CONFIRM_PASTE: 'app:confirm-paste',
  /** 어떤 세션을 보고 있는지 main에 알린다 — 토스트를 띄울지 판단에 쓴다. P15-2 */
  SET_ACTIVE: 'app:set-active',

  // main → renderer (send)
  EVT_DATA: 'evt:session-data',
  EVT_META: 'evt:session-meta',
  EVT_EXIT: 'evt:session-exit',
  EVT_CLOSED: 'evt:session-closed',
  EVT_CREATED: 'evt:session-created',
  /** 토스트를 클릭했다 — 해당 세션으로 전환하라. P15-5 */
  EVT_ACTIVATE: 'evt:activate-session'
} as const

/** preload가 contextBridge로 노출하는 화이트리스트 API. P9-2 */
export interface CvmuxApi {
  list(): Promise<SessionMeta[]>
  snapshot(id: string): Promise<SessionSnapshot | null>
  create(options?: CreateSessionOptions): Promise<CreateSessionResult>
  close(id: string): Promise<boolean>
  restart(id: string): Promise<boolean>
  write(id: string, data: string): Promise<boolean>
  resize(id: string, cols: number, rows: number): Promise<boolean>
  setTitle(id: string, title: string | null): Promise<boolean>
  markRead(id: string): Promise<boolean>
  confirmPaste(bytes: number): Promise<boolean>
  setActive(id: string | null): Promise<boolean>

  onData(cb: (id: string, chunk: string) => void): () => void
  onMeta(cb: (meta: SessionMeta) => void): () => void
  onExit(cb: (info: SessionExitInfo) => void): () => void
  onClosed(cb: (id: string) => void): () => void
  onCreated(cb: (meta: SessionMeta) => void): () => void
  onActivate(cb: (id: string) => void): () => void
}

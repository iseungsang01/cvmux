/**
 * main ↔ renderer 사이의 계약. 양쪽 모두 이 파일만 신뢰한다.
 */

/**
 * 세션 상태. 판정 신호의 확실성 순서는 POLICY.md P4 참조.
 *
 * - `busy`      출력이 흐르는 중 (추측 5순위)
 * - `idle`      셸 프롬프트 — 아무 명령도 돌지 않는다 (추측 4순위 / OSC 133이면 확실 3순위)
 * - `waiting`   명령은 살아 있는데 출력이 멎었다. 일을 끝냈거나 답을 기다린다 (P4-14)
 * - `attention` OSC 9/777/99 또는 BEL로 명시적 알림을 받음 (확실 1순위)
 * - `exited`    프로세스 종료 (확실 2순위)
 */
export type SessionStatus = 'busy' | 'idle' | 'waiting' | 'attention' | 'exited'

/** 상태가 확실한 신호에서 왔는지, 휴리스틱 추측인지. P0-3 */
export type StatusConfidence = 'certain' | 'inferred'

/** 세션의 작업 디렉토리가 속한 git 저장소 상태. P13 */
export interface GitInfo {
  /**
   * 저장소 이름 — 작업 트리 루트의 폴더명. 사이드바에서 "지금 어느 프로젝트인가"를
   * 답하는 값이라 경로보다 이것이 먼저 온다. worktree면 그 worktree의 이름. P13-11
   */
  repo: string
  /**
   * 작업 트리 루트의 절대 경로. bare 저장소에는 없으므로 null.
   *
   * 저장소 이름만으로는 `cd`로 하위 폴더에 들어간 것이 사이드바에 드러나지
   * 않는다. 루트를 알아야 "저장소 안 어디에 서 있는가"를 적을 수 있다. P13-12
   */
  root: string | null
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
  /**
   * 세션 셸 아래에서 따로 도는 셸들의 이름 (P14-13).
   *
   * 에이전트가 명령을 돌리려고 자기 셸을 띄우면 여기 잡힌다. 비어 있으면
   * 세션 셸 하나뿐이라는 뜻이다.
   */
  shells: string[]
  createdAt: number
}

/**
 * 워크스페이스 안의 pane 배치 (P17).
 *
 * 잎(leaf)이 터미널 하나, 가지(split)가 나눔이다. 분할하지 않으면 root가 곧
 * 잎 하나이므로, 분할을 쓰지 않는 사용자에게는 이 구조가 보이지 않는다.
 */
export type PaneNode =
  | { kind: 'leaf'; id: string; sessionId: string }
  | {
      kind: 'split'
      id: string
      /** row = 좌우로 나란히, column = 위아래로 쌓임 (CSS flex-direction과 같다) */
      direction: 'row' | 'column'
      children: PaneNode[]
      /** 각 자식의 비율. 합은 항상 1 */
      sizes: number[]
    }

export interface Workspace {
  id: string
  /** 사용자가 지은 이름. null이면 대표 pane의 세션 제목을 쓴다 */
  title: string | null
  root: PaneNode
  /** 마지막으로 포커스된 잎. 워크스페이스로 돌아올 때 이 pane으로 복귀한다. P17-9 */
  focusedPaneId: string
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

/** 붙여넣기 시점의 클립보드 상태. P7-4 / P7-5 */
export interface ClipboardContent {
  text: string
  /** 텍스트는 없고 이미지만 들어 있는가 — 터미널이 실어 나를 수 없는 종류 */
  hasImage: boolean
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
  /** 클립보드 내용 조회 — 렌더러는 샌드박스라 직접 읽을 수 없다. P7-4 */
  READ_CLIPBOARD: 'app:read-clipboard',
  /** 선택 영역 복사 — 읽기와 같은 이유로 main을 거친다. P6-1 */
  WRITE_CLIPBOARD: 'app:write-clipboard',
  /** 어떤 세션을 보고 있는지 main에 알린다 — 토스트를 띄울지 판단에 쓴다. P15-2 */
  SET_ACTIVE: 'app:set-active',
  /** pane 배치 저장/복원. P16 / P17 */
  LOAD_LAYOUT: 'layout:load',
  SAVE_LAYOUT: 'layout:save',
  /** 제어 소켓 요청에 대한 렌더러의 답. P20-7 */
  CTL_REPLY: 'ctl:reply',
  /** 알림함. P21 */
  NOTIFICATIONS: 'notify:list',
  NOTIFICATION_READ: 'notify:read',
  NOTIFICATION_UNREAD: 'notify:unread',
  NOTIFICATION_DISMISS: 'notify:dismiss',
  NOTIFICATIONS_CLEAR: 'notify:clear',

  // main → renderer (send)
  EVT_DATA: 'evt:session-data',
  EVT_META: 'evt:session-meta',
  EVT_EXIT: 'evt:session-exit',
  EVT_CLOSED: 'evt:session-closed',
  EVT_CREATED: 'evt:session-created',
  /** 토스트를 클릭했다 — 해당 세션으로 전환하라. P15-5 */
  EVT_ACTIVATE: 'evt:activate-session',
  /** 제어 소켓이 렌더러에게 묻는다 (워크스페이스·pane·알림). P20-7 */
  EVT_CTL_REQUEST: 'evt:control-request',
  /** 알림함이 바뀌었다. P21 */
  EVT_NOTIFICATIONS: 'evt:notifications'
} as const

/** 렌더러가 답해야 하는 제어 요청. P20-7 */
export interface ControlAsk {
  id: number
  method: string
  params: Record<string, unknown>
}

/**
 * 알림함의 한 줄 (P21).
 *
 * 세션이 닫혀도 남으므로 세션 제목을 함께 들고 있다 — 나중에 목록을 열었을 때
 * "무엇이 나를 불렀는지"가 id만 남으면 아무 도움이 안 된다.
 */
export interface Notification {
  id: string
  sessionId: string
  sessionTitle: string
  text: string
  createdAt: number
  read: boolean
}

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
  readClipboard(): Promise<ClipboardContent>
  /** 선택한 텍스트를 클립보드에 넣는다. P6-1 */
  writeClipboard(text: string): Promise<boolean>
  setActive(id: string | null): Promise<boolean>
  /** 저장된 pane 배치. 세션이 사라졌으면 그 워크스페이스는 걸러진다. P17 */
  loadLayout(): Promise<Workspace[]>
  saveLayout(workspaces: Workspace[]): Promise<boolean>
  /** 제어 소켓 요청에 답한다. 오류면 ok=false에 사유 문자열. P20-7 */
  controlReply(id: number, ok: boolean, payload: unknown): Promise<boolean>

  /** 알림함. P21 */
  notifications(): Promise<Notification[]>
  notificationRead(id: string): Promise<boolean>
  notificationUnread(id: string): Promise<boolean>
  notificationDismiss(id: string): Promise<boolean>
  /** 읽은 것만 치울지(`read`), 전부 비울지 */
  notificationsClear(scope: 'read' | 'all'): Promise<boolean>

  onData(cb: (id: string, chunk: string) => void): () => void
  onMeta(cb: (meta: SessionMeta) => void): () => void
  onExit(cb: (info: SessionExitInfo) => void): () => void
  onClosed(cb: (id: string) => void): () => void
  onCreated(cb: (meta: SessionMeta) => void): () => void
  onActivate(cb: (id: string) => void): () => void
  onControlRequest(cb: (ask: ControlAsk) => void): () => void
  onNotifications(cb: (items: Notification[]) => void): () => void
}

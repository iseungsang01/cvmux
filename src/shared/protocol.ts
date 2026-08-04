/**
 * 제어 소켓 프로토콜 (P20).
 *
 * cvmux 바깥에서 앱을 조종하는 유일한 통로다. CLI도 이 위에 얹혀 있고,
 * 세션 안에서 도는 에이전트도 같은 문으로 들어온다.
 *
 * cmux의 v2 소켓 계약(docs/cli-contract.md, docs/events.md)을 따르되
 * 전송을 Unix 도메인 소켓에서 **Windows named pipe**로 옮겼다. 프레임은
 * 양쪽 모두 줄바꿈으로 끊은 JSON이라 형태는 같다.
 */

export const CONTROL_PROTOCOL_VERSION = 1

/** 한 프레임의 최대 크기. 이보다 큰 줄이 오면 연결을 끊는다. P20-6 */
export const CONTROL_MAX_FRAME_BYTES = 1024 * 1024

/** 이벤트 재생 버퍼 크기 — 잠깐 끊긴 구독자가 놓친 것을 따라잡을 수 있는 범위. P20-9 */
export const CONTROL_EVENT_BUFFER = 4096

/** 렌더러가 답해야 하는 요청의 제한 시간. 창이 없거나 멈췄으면 여기서 끊는다. P20-8 */
export const CONTROL_BRIDGE_TIMEOUT_MS = 5000

export type ControlErrorCode =
  /** 비밀번호가 없거나 틀렸다 */
  | 'unauthorized'
  /** 이 서버가 모르는 메서드 */
  | 'unknown_method'
  /** 인자가 빠졌거나 형식이 틀렸다 */
  | 'invalid_params'
  /** 가리킨 대상(세션·워크스페이스·pane)이 없다 */
  | 'not_found'
  /** 지금 상태로는 할 수 없다 (창이 없다, 이미 종료됐다) */
  | 'invalid_state'
  /** 렌더러가 제한 시간 안에 답하지 않았다 */
  | 'timeout'
  | 'internal_error'

export interface ControlRequest {
  id: number
  method: string
  params?: Record<string, unknown>
}

export interface ControlSuccess {
  id: number
  ok: true
  result: unknown
}

export interface ControlFailure {
  id: number
  ok: false
  error: { code: ControlErrorCode; message: string }
}

export type ControlResponse = ControlSuccess | ControlFailure

/**
 * 이벤트 프레임 (P20-9).
 *
 * `seq`는 서버가 사는 동안 단조증가한다. 구독자는 처리한 seq를 적어 두었다가
 * `--after`로 되붙으면 그 사이에 놓친 것을 받는다.
 */
export interface ControlEventFrame {
  type: 'event'
  seq: number
  name: string
  at: number
  payload: unknown
}

/** events.stream의 첫 프레임 — 어디서부터 재생하는지 알려 준다 */
export interface ControlAckFrame {
  type: 'ack'
  resume: {
    afterSeq: number
    oldestSeq: number
    latestSeq: number
    nextSeq: number
    /** 요청한 지점이 버퍼 밖이라 건너뛴 구간이 있는가 */
    gap: boolean
  }
}

export type ControlFrame = ControlResponse | ControlEventFrame | ControlAckFrame

/**
 * 앱을 찾는 방법 (P20-2).
 *
 * 실행 중인 cvmux가 이 파일에 파이프 이름과 비밀번호를 적어 둔다. CLI는
 * 환경변수 → 이 파일 순으로 읽는다. 세션 안에서 도는 프로세스는 환경변수를
 * 물려받으므로 파일을 읽을 일이 없다.
 */
export interface ControlEndpoint {
  version: number
  /** `\\.\pipe\cvmux-…` */
  path: string
  password: string
  pid: number
  startedAt: number
}

/** 세션·워크스페이스·pane을 가리키는 방법. P20-4 */
export interface HandleRef {
  /** `workspace:2` 같은 참조, UUID, 또는 1부터 세는 순번 문자열 */
  raw: string
}

/**
 * `<kind>:<n>` 참조를 푼다.
 *
 * `workspace:2` → 2번째 워크스페이스. 접두어 없는 숫자도 순번으로 본다.
 * 그 밖의 문자열은 id로 취급한다 — 짧게 줄인 id도 접두 일치로 받아 준다.
 */
export function resolveHandle<T extends { id: string }>(
  items: readonly T[],
  raw: string | undefined,
  kind: string
): T | null {
  if (raw === undefined || raw === '') return null

  const ref = raw.startsWith(`${kind}:`) ? raw.slice(kind.length + 1) : raw
  const index = /^\d+$/.test(ref) ? Number.parseInt(ref, 10) : null
  if (index !== null) return items[index - 1] ?? null

  const exact = items.find((item) => item.id === ref)
  if (exact) return exact

  // 줄여 쓴 id. 여러 개에 걸리면 가리킨 것이 없는 것과 같다
  const matches = items.filter((item) => item.id.startsWith(ref))
  return matches.length === 1 ? matches[0] : null
}

/** 메서드 이름. 문자열을 여기저기 흩뿌리지 않는다 */
export const M = {
  PING: 'ping',
  CAPABILITIES: 'capabilities',
  IDENTIFY: 'identify',

  SESSION_LIST: 'session.list',
  SESSION_READ: 'session.read',
  SESSION_SEND: 'session.send',
  SESSION_SEND_KEY: 'session.send-key',
  SESSION_CLOSE: 'session.close',
  SESSION_RESTART: 'session.restart',
  SESSION_SET_TITLE: 'session.set-title',
  SESSION_NOTIFY: 'session.notify',

  WORKSPACE_LIST: 'workspace.list',
  WORKSPACE_CREATE: 'workspace.create',
  WORKSPACE_CLOSE: 'workspace.close',
  WORKSPACE_SELECT: 'workspace.select',
  WORKSPACE_RENAME: 'workspace.rename',
  WORKSPACE_CURRENT: 'workspace.current',
  WORKSPACE_TREE: 'workspace.tree',

  PANE_LIST: 'pane.list',
  PANE_SPLIT: 'pane.split',
  PANE_FOCUS: 'pane.focus',
  PANE_CLOSE: 'pane.close',

  NOTIFICATION_LIST: 'notification.list',
  NOTIFICATION_MARK_READ: 'notification.mark-read',
  NOTIFICATION_DISMISS: 'notification.dismiss',
  NOTIFICATION_CLEAR: 'notification.clear',
  NOTIFICATION_OPEN: 'notification.open',
  NOTIFICATION_JUMP_UNREAD: 'notification.jump-to-unread',

  APP_OPEN: 'app.open',
  APP_FOCUS: 'app.focus',
  /** 설정 파일을 다시 읽는다. P22-6 */
  CONFIG_RELOAD: 'config.reload',
  /** 알림함·팔레트·찾기를 소켓에서 연다. cmux의 `right-sidebar show`에 해당. P21-11 */
  APP_PANEL: 'app.panel',

  EVENTS_STREAM: 'events.stream'
} as const

export type ControlMethod = (typeof M)[keyof typeof M]

/**
 * 렌더러가 답해야 하는 메서드 (P20-7).
 *
 * 워크스페이스와 pane 배치는 렌더러가 들고 있다 — main은 세션만 안다.
 * 그래서 이 메서드들은 main에서 렌더러로 한 번 더 건너간다.
 */
export const RENDERER_METHODS: ReadonlySet<string> = new Set<string>([
  M.WORKSPACE_LIST,
  M.WORKSPACE_CREATE,
  M.WORKSPACE_CLOSE,
  M.WORKSPACE_SELECT,
  M.WORKSPACE_RENAME,
  M.WORKSPACE_CURRENT,
  M.WORKSPACE_TREE,
  M.PANE_LIST,
  M.PANE_SPLIT,
  M.PANE_FOCUS,
  M.PANE_CLOSE,
  /*
   * 알림함 자체는 main이 들고 있다(P21). 여는 것만 렌더러 몫이다 —
   * 그 세션이 어느 워크스페이스에 있는지는 렌더러만 안다.
   */
  M.NOTIFICATION_OPEN,
  M.APP_OPEN,
  M.APP_PANEL
])

/** 이벤트 이름. 이름 필터(`--name`)가 쓰는 값이기도 하다 */
export const EV = {
  SESSION_CREATED: 'session.created',
  SESSION_CLOSED: 'session.closed',
  SESSION_EXITED: 'session.exited',
  SESSION_STATUS: 'session.status',
  SESSION_NOTIFY: 'session.notify',
  WORKSPACE_SELECTED: 'workspace.selected'
} as const

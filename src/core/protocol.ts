import { createHash } from 'node:crypto'

/**
 * 앱 ↔ 데몬 사이의 계약 (POLICY.md P20).
 *
 * 세션을 들고 있는 쪽은 데몬이고, 앱은 그것을 들여다보는 창일 뿐이다. 둘은
 * 서로 다른 프로세스이므로 이 파일이 유일한 접점이 된다.
 */

/**
 * 프로토콜이 바뀌면 올린다 (P20-5).
 *
 * 앱을 새로 설치해도 예전 데몬은 계속 돌고 있다. 버전이 다르면 앱이 그
 * 데몬을 물러나게 하고 자기 짝을 새로 띄운다 — 낡은 데몬과 새 앱이 말이
 * 통하는 척하다 엉키는 것보다 낫다.
 */
export const PROTOCOL_VERSION = 1

/**
 * 파이프 이름은 상태 디렉토리에서 나온다 (P20-8).
 *
 * 짝을 정하는 기준이 곧 "같은 세션 파일을 보는가"이기 때문이다. userData
 * 경로에는 사용자 이름이 이미 들어 있으므로 한 기계에 여러 사람이 로그인해
 * 있어도 서로의 세션에 닿지 않고, `--user-data-dir`로 따로 띄운 인스턴스는
 * 자기들끼리만 통한다.
 */
export function pipePath(stateDir: string): string {
  const hash = createHash('sha1').update(stateDir.toLowerCase()).digest('hex').slice(0, 12)
  return `\\\\.\\pipe\\cvmux-${hash}`
}

export interface Request {
  id: number
  method: string
  params: unknown[]
}

export interface Response {
  id: number
  ok: boolean
  result?: unknown
  error?: string
}

export interface DaemonEvent {
  event: string
  args: unknown[]
}

export type ServerMessage = Response | DaemonEvent

export function isEvent(message: ServerMessage): message is DaemonEvent {
  return 'event' in message
}

/** 데몬이 받아들이는 요청 이름. 렌더러의 IPC 채널과 일대일은 아니다 */
export const RPC = {
  HELLO: 'hello',
  LIST: 'list',
  SNAPSHOT: 'snapshot',
  CREATE: 'create',
  CLOSE: 'close',
  RESTART: 'restart',
  WRITE: 'write',
  RESIZE: 'resize',
  SET_TITLE: 'setTitle',
  MARK_READ: 'markRead',
  BUSY_COUNT: 'busyCount',
  LOAD_LAYOUT: 'loadLayout',
  SAVE_LAYOUT: 'saveLayout',
  /** 데몬을 완전히 끝낸다 — 세션도 함께 정리된다. P20-6 */
  SHUTDOWN: 'shutdown'
} as const

/** 데몬이 밀어 보내는 이벤트. PtyManager의 이벤트를 그대로 옮긴다 */
export const RPC_EVENT = {
  DATA: 'data',
  META: 'meta',
  EXIT: 'exit',
  CLOSED: 'closed',
  CREATED: 'created',
  NOTIFY: 'notify'
} as const

export interface HelloResult {
  protocol: number
  pid: number
  /** 데몬이 뜬 시각 — 세션이 얼마나 오래 살아 있었는지 알려준다 */
  startedAt: number
}

const HEADER_BYTES = 4

/**
 * 한 프레임이 넘을 수 없는 크기.
 *
 * 길이 접두사를 그대로 믿고 버퍼를 키우면, 깨진 4바이트 하나가 곧바로
 * 메모리 고갈이 된다. 스크롤백 재생이 가장 큰 메시지인데 그래도 이 상한
 * 근처에도 가지 않는다.
 */
export const MAX_FRAME_BYTES = 64 * 1024 * 1024

export function encodeFrame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value), 'utf8')
  const frame = Buffer.allocUnsafe(HEADER_BYTES + body.length)
  frame.writeUInt32LE(body.length, 0)
  body.copy(frame, HEADER_BYTES)
  return frame
}

/**
 * 스트림을 프레임으로 자른다.
 *
 * 파이프는 경계를 지켜주지 않는다 — 한 번의 write가 여러 번에 나뉘어 오고,
 * 여러 번의 write가 한 덩어리로 오기도 한다. 길이 접두사가 그 경계를 대신한다.
 */
export class FrameDecoder {
  private buffer: Buffer = Buffer.alloc(0)
  /** 상한을 넘긴 프레임을 만나면 더 읽지 않는다 — 호출자가 연결을 끊어야 한다 */
  overflowed = false

  /** 소켓은 인코딩을 지정하지 않는 한 Buffer를 주지만, 타입은 문자열도 허용한다 */
  push(chunk: Buffer | string): unknown[] {
    if (this.overflowed) return []
    const incoming = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk
    this.buffer = this.buffer.length === 0 ? incoming : Buffer.concat([this.buffer, incoming])

    const out: unknown[] = []
    while (this.buffer.length >= HEADER_BYTES) {
      const length = this.buffer.readUInt32LE(0)
      if (length > MAX_FRAME_BYTES) {
        this.overflowed = true
        this.buffer = Buffer.alloc(0)
        break
      }
      if (this.buffer.length < HEADER_BYTES + length) break

      const body = this.buffer.subarray(HEADER_BYTES, HEADER_BYTES + length)
      this.buffer = this.buffer.subarray(HEADER_BYTES + length)
      try {
        out.push(JSON.parse(body.toString('utf8')))
      } catch {
        // 깨진 프레임 하나로 연결 전체를 버리지는 않는다
      }
    }
    return out
  }
}

import { readFileSync } from 'node:fs'
import { connect, type Socket } from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'

import {
  type ControlEndpoint,
  type ControlEventFrame,
  type ControlResponse
} from '@shared/protocol'

/**
 * 제어 소켓 클라이언트 (P20-2).
 *
 * 앱을 찾는 순서는 명시한 값 → 환경변수 → 접속 정보 파일이다. 세션 안에서
 * 부르면 환경변수가 이미 있으므로 파일까지 갈 일이 없다.
 */

export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode = 1
  ) {
    super(message)
  }
}

/** 접속 정보 파일 자리 — Electron의 userData와 같은 곳이어야 한다 */
function endpointFile(): string {
  const appData = process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming')
  return join(appData, 'cvmux', 'control.json')
}

export interface Endpoint {
  path: string
  password: string
}

export function resolveEndpoint(overrides: {
  socket?: string
  password?: string
}): Endpoint {
  const path = overrides.socket ?? process.env.CVMUX_SOCKET_PATH
  const password = overrides.password ?? process.env.CVMUX_SOCKET_PASSWORD

  if (path && password) return { path, password }

  let saved: ControlEndpoint | null = null
  try {
    saved = JSON.parse(readFileSync(endpointFile(), 'utf8')) as ControlEndpoint
  } catch {
    saved = null
  }

  if (!saved) {
    throw new CliError(
      'cvmux가 실행 중이지 않습니다. 앱을 먼저 실행하세요.\n' +
        `(접속 정보를 찾은 곳: ${endpointFile()})`
    )
  }

  return { path: path ?? saved.path, password: password ?? saved.password }
}

interface Pending {
  resolve(value: unknown): void
  reject(error: Error): void
}

export class ControlClient {
  private socket: Socket | null = null
  private buffer = ''
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  private onEvent: ((frame: ControlEventFrame) => void) | null = null

  constructor(private readonly endpoint: Endpoint) {}

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = connect(this.endpoint.path)
      socket.setEncoding('utf8')
      socket.once('connect', () => resolve())
      socket.once('error', (error: NodeJS.ErrnoException) => {
        if (this.pending.size === 0) {
          const hint =
            error.code === 'ENOENT'
              ? 'cvmux가 실행 중이지 않습니다. 앱을 먼저 실행하세요.'
              : `제어 소켓에 연결하지 못했습니다: ${error.message}`
          reject(new CliError(hint))
          return
        }
        for (const p of this.pending.values()) p.reject(new CliError(error.message))
        this.pending.clear()
      })
      socket.on('data', (chunk: string) => this.feed(chunk))
      socket.on('close', () => {
        for (const p of this.pending.values()) p.reject(new CliError('연결이 끊겼습니다'))
        this.pending.clear()
      })
      this.socket = socket
    })
  }

  private feed(chunk: string): void {
    this.buffer += chunk
    let cut = this.buffer.indexOf('\n')
    while (cut !== -1) {
      const line = this.buffer.slice(0, cut).trim()
      this.buffer = this.buffer.slice(cut + 1)
      if (line) this.frame(line)
      cut = this.buffer.indexOf('\n')
    }
  }

  private frame(line: string): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      return
    }

    // 이벤트 프레임은 id가 없다 — 응답과 섞이지 않는다
    if ((parsed as ControlEventFrame).type === 'event') {
      this.onEvent?.(parsed as ControlEventFrame)
      return
    }

    const response = parsed as ControlResponse
    const waiting = this.pending.get(response.id)
    if (!waiting) return
    this.pending.delete(response.id)
    if (response.ok) waiting.resolve(response.result)
    else waiting.reject(new CliError(`${response.error.message} (${response.error.code})`))
  }

  call(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const socket = this.socket
    if (!socket) return Promise.reject(new CliError('연결되지 않았습니다'))

    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      socket.write(`${JSON.stringify({ id, method, params, auth: this.endpoint.password })}\n`)
    })
  }

  /** 이벤트 구독을 켠다. 이 뒤로는 프로세스가 끊길 때까지 산다 */
  stream(
    params: Record<string, unknown>,
    onFrame: (frame: ControlEventFrame) => void
  ): Promise<unknown> {
    this.onEvent = onFrame
    return this.call('events.stream', params)
  }

  close(): void {
    this.socket?.end()
    this.socket = null
  }
}

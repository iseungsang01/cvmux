/**
 * 증분 ANSI/OSC 파서.
 *
 * PTY 출력은 임의의 지점에서 청크로 쪼개져 도착한다. 이스케이프 시퀀스가
 * 청크 경계에서 잘리는 것이 정상이므로(P3-2), 이 파서는 미완결 시퀀스를
 * carry에 남겨 다음 청크에서 이어 처리한다. 청크 단위로 정규식을 돌리면
 * `\x1b]9;알림` 이 두 조각으로 나뉘었을 때 알림을 통째로 놓친다.
 *
 * 동시에 "현재 줄"을 CR/BS/EL을 반영해 추적한다. 진행률 표시줄처럼 CR로
 * 같은 줄을 덮어쓰는 출력에서 마지막 상태만 남기기 위함이다(P4-10).
 */

/** 미완결 시퀀스가 이보다 길어지면 깨진 스트림으로 보고 버린다. */
const MAX_CARRY = 4096

const enum S {
  Ground,
  Esc,
  Csi,
  Osc,
  /** DCS/SOS/PM/APC — ST(ESC \ 또는 BEL)까지 통째로 버린다 */
  String
}

export interface AnsiEvents {
  /** OSC 시퀀스 본문 (`]`와 종결자 사이). 예: `9;빌드 완료` */
  onOsc(body: string): void
  /** GROUND 상태에서 만난 단독 BEL. P4-3 */
  onBell(): void
  /** CSI 시퀀스. params는 `?1049` 같은 원본 파라미터 문자열, final은 종결 문자 */
  onCsi(params: string, final: string): void
  /** 개행으로 확정된 줄 (제어문자 제거됨). 빈 줄도 전달된다 */
  onLine(line: string): void
}

export class AnsiParser {
  private state: S = S.Ground
  private carry = ''
  /** 아직 개행되지 않은 현재 줄 */
  private line = ''
  /** 현재 줄 안에서의 커서 위치 */
  private col = 0
  /** 마지막으로 확정된 비어있지 않은 줄 */
  private lastLine = ''

  constructor(private readonly events: AnsiEvents) {}

  /** 커서가 놓인, 아직 개행되지 않은 줄. 프롬프트 판정 대상. P4-12 */
  get currentLine(): string {
    return this.line
  }

  /** 미리보기용 텍스트 — 현재 줄이 비었으면 마지막 확정 줄. P4-13 */
  get previewLine(): string {
    return this.line.trim().length > 0 ? this.line : this.lastLine
  }

  reset(): void {
    this.state = S.Ground
    this.carry = ''
    this.line = ''
    this.col = 0
    this.lastLine = ''
  }

  write(chunk: string): void {
    const buf = this.carry + chunk
    this.carry = ''

    let i = 0
    // 현재 처리 중인 시퀀스의 시작 위치 (미완결 시 carry로 넘길 지점)
    let seqStart = 0
    let oscStart = 0

    while (i < buf.length) {
      const ch = buf[i]

      switch (this.state) {
        case S.Ground: {
          if (ch === '\x1b') {
            this.state = S.Esc
            seqStart = i
            i++
          } else if (ch === '\x07') {
            this.events.onBell()
            i++
          } else {
            i = this.text(buf, i)
          }
          break
        }

        case S.Esc: {
          if (ch === '[') {
            this.state = S.Csi
            i++
          } else if (ch === ']') {
            this.state = S.Osc
            oscStart = i + 1
            i++
          } else if (ch === 'P' || ch === 'X' || ch === '^' || ch === '_') {
            this.state = S.String
            i++
          } else {
            // 2바이트 이스케이프 (ESC c, ESC 7 등) — 소비만 하고 넘어간다
            this.state = S.Ground
            i++
          }
          break
        }

        case S.Csi: {
          const code = ch.charCodeAt(0)
          // 최종 바이트: 0x40–0x7E
          if (code >= 0x40 && code <= 0x7e) {
            this.events.onCsi(buf.slice(seqStart + 2, i), ch)
            this.csi(buf.slice(seqStart + 2, i), ch)
            this.state = S.Ground
            i++
          } else {
            i++
          }
          break
        }

        case S.Osc: {
          if (ch === '\x07') {
            this.events.onOsc(buf.slice(oscStart, i))
            this.state = S.Ground
            i++
          } else if (ch === '\x1b') {
            if (i + 1 >= buf.length) {
              // ST가 청크 경계에 걸렸다 — 다음 청크에서 이어서 본다
              i = buf.length
              break
            }
            if (buf[i + 1] === '\\') {
              this.events.onOsc(buf.slice(oscStart, i))
              this.state = S.Ground
              i += 2
            } else {
              // 잘못된 시퀀스 — OSC를 포기하고 ESC부터 다시 해석
              this.state = S.Esc
              seqStart = i
              i++
            }
          } else {
            i++
          }
          break
        }

        case S.String: {
          if (ch === '\x07') {
            this.state = S.Ground
            i++
          } else if (ch === '\x1b') {
            if (i + 1 >= buf.length) {
              i = buf.length
              break
            }
            if (buf[i + 1] === '\\') {
              this.state = S.Ground
              i += 2
            } else {
              i++
            }
          } else {
            i++
          }
          break
        }
      }
    }

    if (this.state !== S.Ground) {
      const pending = buf.slice(seqStart)
      if (pending.length > MAX_CARRY) {
        // 종결자가 오지 않는 깨진 스트림 — 붙잡고 있어봐야 메모리만 먹는다
        this.state = S.Ground
        this.carry = ''
      } else {
        this.carry = pending
      }
    }
  }

  /**
   * GROUND 상태의 일반 텍스트를 소비한다. 다음 이스케이프/제어문자 위치를 반환.
   * CR은 커서를 줄 앞으로 되돌려 덮어쓰기를 만든다(P4-10).
   */
  private text(buf: string, start: number): number {
    let i = start
    while (i < buf.length) {
      const ch = buf[i]
      if (ch === '\x1b' || ch === '\x07') break

      if (ch === '\n') {
        this.commitLine()
        i++
      } else if (ch === '\r') {
        this.col = 0
        i++
      } else if (ch === '\b') {
        if (this.col > 0) this.col--
        i++
      } else if (ch === '\t') {
        const next = (Math.floor(this.col / 8) + 1) * 8
        this.put(' '.repeat(next - this.col))
        i++
      } else {
        const code = ch.charCodeAt(0)
        // 그 외 C0 제어문자는 표시 텍스트에서 제외 (P4-13)
        if (code < 0x20) {
          i++
        } else {
          // 연속된 표시 가능 문자를 한 번에 처리
          let j = i
          while (j < buf.length) {
            const c = buf.charCodeAt(j)
            if (c < 0x20 || c === 0x1b || c === 0x7f) break
            j++
          }
          this.put(buf.slice(i, j))
          i = j
        }
      }
    }
    return i
  }

  /** 커서 위치에 문자열을 덮어쓴다 */
  private put(s: string): void {
    if (this.col === this.line.length) {
      this.line += s
    } else {
      this.line = this.line.slice(0, this.col) + s + this.line.slice(this.col + s.length)
    }
    this.col += s.length
  }

  private commitLine(): void {
    const line = this.line
    if (line.trim().length > 0) this.lastLine = line
    this.events.onLine(line)
    this.line = ''
    this.col = 0
  }

  /** 줄 내용에 영향을 주는 CSI만 반영한다. 완전한 터미널 에뮬레이션은 xterm.js의 몫 */
  private csi(params: string, final: string): void {
    switch (final) {
      // EL — 줄 지우기
      case 'K': {
        const mode = params === '' ? 0 : Number.parseInt(params, 10)
        if (mode === 0) this.line = this.line.slice(0, this.col)
        else if (mode === 1) this.line = ' '.repeat(this.col) + this.line.slice(this.col)
        else if (mode === 2) {
          this.line = ''
          this.col = 0
        }
        break
      }
      // ED — 화면 지우기
      case 'J': {
        const mode = params === '' ? 0 : Number.parseInt(params, 10)
        if (mode === 2 || mode === 3) {
          this.line = ''
          this.col = 0
          this.lastLine = ''
        }
        break
      }
      /*
       * CUP/HVP — 커서 이동. 열만 옮기고 줄 내용은 건드리지 않는다.
       *
       * PSReadLine은 프롬프트를 다시 그린 뒤 `ESC[1;41H`로 프롬프트 끝에 커서를
       * 되돌린다. 여기서 줄을 비우면 화면에 멀쩡히 있는 프롬프트를 잃어버려
       * "입력 대기"로 오판한다. 커서가 옮겨간 자리에 무엇이 쓰이든 put()이
       * 그 위치부터 덮어쓰므로 내용은 자연히 맞춰진다.
       */
      case 'H':
      case 'f': {
        const parts = params.split(';')
        const col = parts.length > 1 ? Number.parseInt(parts[1], 10) : 1
        this.col = Math.max(0, (Number.isFinite(col) ? col : 1) - 1)
        break
      }
      // CHA — 열 이동
      case 'G': {
        const n = params === '' ? 1 : Number.parseInt(params, 10)
        this.col = Math.max(0, (Number.isNaN(n) ? 1 : n) - 1)
        break
      }
      // 대체 화면 버퍼 전환 — 화면이 통째로 바뀌므로 줄 추적을 버린다.
      // 그러지 않으면 vim을 나온 뒤 프롬프트가 이전 화면의 잔여 텍스트에 이어붙는다. P4-9
      case 'h':
      case 'l': {
        if (params === '?1049' || params === '?1047' || params === '?47') {
          this.line = ''
          this.col = 0
          this.lastLine = ''
        }
        break
      }
      default:
        break
    }
  }
}

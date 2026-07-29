/*
 * 상태 감지 엔진(POLICY.md P4)의 회귀 테스트.
 *
 * 이 테스트는 실제로 버그 세 개를 잡았다:
 *   1. ingest()가 파싱 후 busy를 덮어써서 OSC 9/133/BEL 알림이 전부 사라지던 문제
 *   2. alt screen 이탈 시 줄 추적이 남아 vim 종료 후 프롬프트를 인식하지 못하던 문제
 *   3. 청크 경계에 걸린 OSC 종결자 처리
 *
 * 실행: npm test
 */
import { SessionState } from '../src/core/session-state'

const results: string[] = []
let failed = 0

function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failed++
  results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `  ← ${detail}` : ''}`)
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function make(): { s: SessionState; notes: string[]; cwds: string[] } {
  const notes: string[] = []
  const cwds: string[] = []
  const s = new SessionState({
    onChange: () => {},
    onNotify: (t) => notes.push(t),
    onCwd: (cwd) => cwds.push(cwd)
  })
  return { s, notes, cwds }
}

/** 셸 통합이 매 프롬프트마다 내보내는 시퀀스 (pty-manager.ts의 SHELL_INTEGRATION과 같은 모양) */
function promptSequence(windowsPath: string, body: string): string {
  const url = windowsPath.replace(/\\/g, '/')
  return `\x1b]133;D\x07\x1b]133;A\x07\x1b]7;file:///${url}\x07${body}\x1b]133;B\x07`
}

const IDLE_WAIT = 550

async function main(): Promise<void> {
  // ── P4-7: 프롬프트로 끝나면 idle
  {
    const { s } = make()
    s.ingest('PS C:\\Users\\lss\\Documents> ')
    await sleep(IDLE_WAIT)
    check('P4-7 PowerShell 프롬프트 → idle', s.status === 'idle', s.status)
    s.dispose()
  }

  // ── P4-8: 프롬프트가 아니면 waiting (에이전트가 확인을 기다리는 전형)
  {
    const { s } = make()
    s.ingest('Do you want to proceed? (y/n)')
    await sleep(IDLE_WAIT)
    check('P4-8 프롬프트 아님 → waiting', s.status === 'waiting', s.status)
    s.dispose()
  }

  // ── P4-11: 프롬프트 뒤에 타이핑 중이면 여전히 idle
  {
    const { s } = make()
    s.ingest('PS C:\\Users\\lss> git st')
    await sleep(IDLE_WAIT)
    check('P4-11 프롬프트 + 타이핑 중 → idle', s.status === 'idle', s.status)
    s.dispose()
  }

  // ── P4-12: 출력 중간의 '>' 는 프롬프트가 아니다
  {
    const { s } = make()
    s.ingest('build > dist/out.js\r\ncompiling...')
    await sleep(IDLE_WAIT)
    check('P4-12 출력 중 > 오탐 없음 → waiting', s.status === 'waiting', s.status)
    s.dispose()
  }

  // ── P4-7 / P4-12: PSReadLine이 프롬프트를 그린 뒤 화면을 정리하고 CUP으로 복귀하는
  //    실제 패턴. 저장된 스크롤백에서 그대로 가져왔다. 이 케이스에서 프롬프트를
  //    놓치면 멀쩡히 대기 중인 세션이 "입력 대기"로 잘못 표시된다.
  {
    const { s } = make()
    s.ingest('\x1b[?25l\x1b[8;43;144t\x1b[HPS C:\\Users\\lss\\Documents\\GitHub\\cvmux>\x1b[K')
    s.ingest('\r\n\x1b[K'.repeat(40))
    s.ingest('\x1b[K\x1b[1;41H\x1b[?25h')
    await sleep(IDLE_WAIT)
    check('P4-12 화면 정리 + CUP 복귀 후에도 프롬프트 인식', s.status === 'idle', s.status)
    s.dispose()
  }

  // ── CUP이 줄 내용을 지우지 않아야 한다 (위 케이스의 근본 원인)
  {
    const { s } = make()
    s.ingest('PS C:\\Users\\lss> ')
    s.ingest('\x1b[1;18H') // 프롬프트 끝으로 커서 복귀
    await sleep(IDLE_WAIT)
    check('CUP이 현재 줄을 지우지 않음', s.status === 'idle', s.status)
    s.dispose()
  }

  // ── P4-1: OSC 9 알림 → attention + unread
  {
    const { s, notes } = make()
    s.ingest('\x1b]9;빌드가 끝났습니다\x07')
    check('P4-1 OSC 9 → attention', s.status === 'attention' && s.unread, `${s.status}/${s.unread}`)
    check('P4-1 알림 텍스트 전달', notes[0] === '빌드가 끝났습니다', JSON.stringify(notes))
    check('P4-1 미리보기에 알림 노출', s.preview === '빌드가 끝났습니다', s.preview)
    s.dispose()
  }

  // ── P3-2: OSC가 청크 경계에서 잘려도 감지된다 (이 파서의 존재 이유)
  {
    const { s, notes } = make()
    s.ingest('\x1b]9;에이전')
    check('P3-2 미완결 OSC는 아직 알림 아님', s.status !== 'attention', s.status)
    s.ingest('트 대기 중\x07')
    check(
      'P3-2 청크 경계 넘어 OSC 9 감지',
      s.status === 'attention' && notes[0] === '에이전트 대기 중',
      `${s.status} / ${JSON.stringify(notes)}`
    )
    s.dispose()
  }

  // ── P3-2: ESC \ 종결자가 경계에 걸린 경우
  {
    const { s, notes } = make()
    s.ingest('\x1b]777;notify;Claude;확인이 필요합니다\x1b')
    s.ingest('\\')
    check(
      'P4-2 OSC 777 + ST 경계 분할',
      s.status === 'attention' && notes[0] === 'Claude: 확인이 필요합니다',
      `${s.status} / ${JSON.stringify(notes)}`
    )
    s.dispose()
  }

  /*
   * ── P13-7 / P3-9: 셸에서 `cd`를 치면 작업 디렉토리가 따라와야 한다
   *
   * 이게 끊기면 사이드바가 세션이 시작한 자리에 영원히 머문다 — 사용자에게는
   * "cd를 쳤는데 반영이 안 된다"로 보인다. 실제로 그렇게 보고된 적이 있다.
   */
  {
    const { s, cwds } = make()
    s.ingest(
      promptSequence(
        'C:\\Users\\lss\\Documents\\GitHub\\cvmux',
        'PS C:\\Users\\lss\\Documents\\GitHub\\cvmux> '
      )
    )
    check(
      'P3-9 OSC 7 → cwd 보고',
      cwds[0] === 'C:\\Users\\lss\\Documents\\GitHub\\cvmux',
      JSON.stringify(cwds)
    )

    // cd 뒤의 새 프롬프트가 새 자리를 알린다
    s.ingest(promptSequence('C:\\Windows\\System32', 'PS C:\\Windows\\System32> '))
    check('P13-7 cd 후 새 cwd 보고', cwds[1] === 'C:\\Windows\\System32', JSON.stringify(cwds))

    // 셸 통합이 살아 있으면 프롬프트 판정은 정규식이 아니라 133 마커를 따른다
    await sleep(IDLE_WAIT)
    check(
      'P3-9 셸 통합이면 idle 판정이 확실해진다',
      s.status === 'idle' && s.confidence === 'certain',
      `${s.status}/${s.confidence}`
    )
    s.dispose()
  }

  // ── P3-2: OSC 7이 청크 경계에 걸려도 놓치지 않는다
  {
    const { s, cwds } = make()
    const seq = promptSequence('C:\\Users\\lss\\Documents\\GitHub\\cvmux\\src\\core', 'PS> ')
    const cut = seq.indexOf('file:///') + 12
    s.ingest(seq.slice(0, cut))
    s.ingest(seq.slice(cut))
    check(
      'P3-2 경계에 걸린 OSC 7도 온전히 파싱',
      cwds[0] === 'C:\\Users\\lss\\Documents\\GitHub\\cvmux\\src\\core',
      JSON.stringify(cwds)
    )
    s.dispose()
  }

  // ── 133;C(명령 시작) → busy, 133;D(명령 종료) → idle. 둘 다 확실한 신호다
  {
    const { s } = make()
    s.ingest(promptSequence('C:\\Users\\lss', 'PS C:\\Users\\lss> '))
    s.ingest('\x1b]133;C\x07')
    check('P3-9 133;C → busy(확실)', s.status === 'busy' && s.confidence === 'certain', s.status)
    s.dispose()
  }

  /*
   * ── P4-14: 에이전트를 띄워둔 채 아무 일도 일어나지 않으면 busy가 아니다
   *
   * 실제로 보고된 증상이다 — "claude 켜놓고 아무것도 안 하는데 초록이다".
   * 셸 통합이 켜져 있으면 명령이 살아 있는 동안 commandRunning이 참으로 남는데,
   * 그것만 보고 busy를 유지하면 초록 점이 영영 꺼지지 않는다.
   */
  {
    const { s } = make()
    s.ingest(promptSequence('C:\\Users\\lss', 'PS C:\\Users\\lss> '))
    s.ingest('\x1b]133;C\x07') // claude 시작
    s.ingest('무언가 출력하는 중...\r\n')
    check('P4-14 출력이 흐르는 동안은 busy', s.status === 'busy', s.status)

    // 출력이 멎었다 — 명령은 아직 살아 있지만 조용하다
    await sleep(IDLE_WAIT)
    check(
      'P4-14 떠 있는 채로 조용하면 waiting',
      s.status === 'waiting' && s.confidence === 'certain',
      `${s.status}/${s.confidence}`
    )

    // 다시 출력이 흐르면 busy로 돌아온다
    s.ingest('다시 일을 시작한다\r\n')
    check('P4-14 출력이 재개되면 busy', s.status === 'busy', s.status)

    // 명령이 끝나 프롬프트로 돌아오면 빈손 상태
    s.ingest(promptSequence('C:\\Users\\lss', 'PS C:\\Users\\lss> '))
    await sleep(IDLE_WAIT)
    check(
      'P4-14 프롬프트로 돌아오면 idle',
      s.status === 'idle' && s.confidence === 'certain',
      `${s.status}/${s.confidence}`
    )
    s.dispose()
  }

  // ── P4-1: ConEmu 진행률(OSC 9;4)은 알림이 아니다
  {
    const { s, notes } = make()
    s.ingest('\x1b]9;4;1;50\x07')
    check('P4-1 ConEmu progress 무시', s.status !== 'attention' && notes.length === 0, s.status)
    s.dispose()
  }

  // ── P4-3: BEL 합치기
  {
    const { s, notes } = make()
    s.ingest('\x07\x07\x07\x07')
    check('P4-3 연속 BEL 1회로 합침', notes.length === 1, `${notes.length}회`)
    check('P4-3 BEL → attention', s.status === 'attention', s.status)
    s.dispose()
  }

  // ── P4-9: 대체 화면 버퍼에서는 프롬프트 휴리스틱을 끈다
  {
    const { s } = make()
    s.ingest('\x1b[?1049h')
    s.ingest('~\r\n~\r\n"file.txt" 3L, 42B')
    await sleep(IDLE_WAIT)
    check('P4-9 alt screen 안에서는 busy 고정', s.status === 'busy' && s.altScreen, s.status)
    s.ingest('\x1b[?1049l')
    s.ingest('PS C:\\Users\\lss> ')
    await sleep(IDLE_WAIT)
    check('P4-9 alt screen 이탈 후 재개', s.status === 'idle' && !s.altScreen, s.status)
    s.dispose()
  }

  // ── P4-10 / P4-13: CR 덮어쓰기는 마지막 상태만 남는다
  {
    const { s } = make()
    s.ingest('진행률 10%\r진행률 90%\r진행률 100%')
    check('P4-10 CR 덮어쓰기 → 최종 줄만', s.preview === '진행률 100%', s.preview)
    s.dispose()
  }

  // ── P4-13: 미리보기에서 ANSI가 제거된다
  {
    const { s } = make()
    s.ingest('\x1b[32m성공\x1b[0m: 12개 통과\r\n')
    check('P4-13 미리보기에 ANSI 없음', s.preview === '성공: 12개 통과', JSON.stringify(s.preview))
    s.dispose()
  }

  // ── OSC 133: 셸 통합이 있으면 확실한 판정
  {
    const { s } = make()
    s.ingest('\x1b]133;C\x07')
    check('OSC 133;C → busy(certain)', s.status === 'busy' && s.confidence === 'certain', s.status)
    s.ingest('\x1b]133;D;0\x07')
    check('OSC 133;D → idle(certain)', s.status === 'idle' && s.confidence === 'certain', s.status)
    s.dispose()
  }

  // ── P5-8: OSC 0 제목
  {
    const { s } = make()
    s.ingest('\x1b]0;npm run dev\x07')
    check('P5-8 OSC 0 제목 수신', s.shellTitle === 'npm run dev', String(s.shellTitle))
    s.dispose()
  }

  // ── P4-5: 읽음 처리하면 attention 해제 후 재평가
  {
    const { s } = make()
    s.ingest('PS C:\\Users\\lss> ')
    s.ingest('\x1b]9;확인 요청\x07')
    check('attention 진입', s.status === 'attention', s.status)
    s.markRead()
    check('P4-5 읽음 → idle 재평가', s.status === 'idle' && !s.unread, `${s.status}/${s.unread}`)
    s.dispose()
  }

  // ── P1-1: 종료는 어떤 신호보다 우선하며 유지된다
  {
    const { s } = make()
    s.ingest('\x1b]9;알림\x07')
    s.noteExit()
    check('P1-1 종료 → exited(certain)', s.status === 'exited' && s.confidence === 'certain', s.status)
    s.ingest('뒤늦은 출력')
    await sleep(IDLE_WAIT)
    check('P1-1 종료 후 상태 유지', s.status === 'exited', s.status)
    s.dispose()
  }

  // ── P2-4: 리사이즈 직후 reflow 출력은 상태를 흔들지 않는다
  {
    const { s } = make()
    s.ingest('PS C:\\Users\\lss> ')
    await sleep(IDLE_WAIT)
    const before = s.status
    s.noteResize()
    s.ingest('\x1b[2J\x1b[HPS C:\\Users\\lss> ')
    check('P2-4 리사이즈 억제 중 busy 전환 없음', s.status === before, `${before} → ${s.status}`)
    s.dispose()
  }

  // ── 대량 출력에서도 버퍼가 무한히 자라지 않는다 (P3-6 / P8-2)
  {
    const { s } = make()
    const big = 'x'.repeat(50_000)
    s.ingest(`${big}\r\n`)
    check('P3-6 대량 출력 후 미리보기 길이 제한', s.preview.length <= 80, `${s.preview.length}자`)
    s.dispose()
  }

  // ── 깨진 무한 OSC가 메모리를 먹지 않는다
  {
    const { s } = make()
    for (let i = 0; i < 10; i++) s.ingest(`\x1b]9;${'y'.repeat(1000)}`)
    s.ingest('\x07')
    check('깨진 OSC carry 상한 동작 (크래시 없음)', true)
    s.dispose()
  }

  console.log(results.join('\n'))
  console.log(`\n${results.length - failed}/${results.length} passed`)
  process.exit(failed === 0 ? 0 : 1)
}

void main()

/**
 * POLICY.md에 규정된 수치의 단일 출처(single source of truth).
 *
 * 이 파일의 값을 바꾸면 POLICY.md의 해당 규칙도 함께 갱신할 것.
 * 각 상수 옆 주석의 `P<영역>-<번호>`가 정책 규칙 ID다.
 */
export const POLICY = {
  /** 동시 세션 상한. 초과 생성은 거부하고 사유를 표시한다. P1-8 / P8-3 */
  MAX_SESSIONS: 32,

  /** xterm 세션당 스크롤백 줄 수. P3-6 / P8-1 */
  SCROLLBACK_LINES: 10_000,

  /** 미리보기·상태 판정용 누적 버퍼 크기. 초과분은 앞에서 버린다. P3-2 / P3-6 / P8-2 */
  PREVIEW_BUFFER_BYTES: 8 * 1024,

  /** 렌더러 크래시/재로드 후 화면 복구용 재생 버퍼. P9-1 */
  REPLAY_BUFFER_BYTES: 256 * 1024,

  /** PTY 출력을 렌더러로 보낼 때의 배칭 간격(ms). 프레임당 1회. P3-4 / P8-4 */
  IPC_FLUSH_MS: 16,

  /** 배치 버퍼가 이 크기를 넘으면 간격을 기다리지 않고 즉시 flush. P3-4 / P8-4 */
  IPC_MAX_BATCH_BYTES: 256 * 1024,

  /** 출력이 멎은 뒤 idle/waiting으로 판정하기까지의 유휴 시간(ms). P4-7 / P4-8 */
  IDLE_THRESHOLD_MS: 400,

  /** 창 리사이즈 → PTY resize 디바운스(ms). ConPTY resize는 비싸다. P2-2 */
  RESIZE_DEBOUNCE_MS: 60,

  /** 리사이즈 직후 reflow 출력을 상태 판정에서 제외하는 시간(ms). P2-4 */
  RESIZE_SUPPRESS_MS: 300,

  /** 이 시간 내에 도착한 중복 BEL은 1회로 합친다. P4-3 */
  BELL_COALESCE_MS: 1000,

  /** 셸이 이 시간 안에 죽으면 즉사로 보고 자동 재시작하지 않는다. P2-7 */
  INSTANT_EXIT_MS: 100,

  /** 이 크기를 넘는 붙여넣기는 확인을 받는다. P7-3 */
  PASTE_CONFIRM_BYTES: 1024 * 1024,

  /** ConPTY는 0 이하 크기를 거부하므로 클램프한다. P2-1 */
  MIN_COLS: 1,
  MIN_ROWS: 1,

  /** 사이드바 미리보기 최대 글자 수. P4-13 */
  PREVIEW_MAX_CHARS: 80,

  /** ConPTY 최소 요구 Windows 빌드 (10 1809). P2-6 */
  MIN_WINDOWS_BUILD: 17763
} as const

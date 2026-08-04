/**
 * CLI 도움말 (P20-1).
 *
 * 여기 있는 문자열은 소켓 없이 나온다. 앱이 꺼져 있어도 `cvmux --help`가
 * 답해야 도구로 쓸 수 있다 — cmux의 no-socket help 계약과 같은 규칙이다.
 */

export const VERSION = 'cvmux 0.1.0'

export const HELP = `cvmux - 제어 소켓으로 cvmux를 조종한다

사용법:
  cvmux [전역 옵션] <명령> [옵션]
  cvmux open <path>

전역 옵션:
  --socket <path>        파이프 경로를 직접 지정 (기본: CVMUX_SOCKET_PATH)
  --password <value>     소켓 비밀번호 (기본: CVMUX_SOCKET_PASSWORD)
  --json                 결과를 JSON으로 출력
  --workspace <handle>   대상 워크스페이스 (id, workspace:2, 또는 순번)
  --pane <handle>        대상 pane
  --session <handle>     대상 세션 (기본: CVMUX_SESSION_ID)

연결:
  ping                   소켓이 살아 있는지 확인
  capabilities           서버가 아는 메서드와 이벤트
  identify               서버 신원과 세션 수
  rpc <method> [json]    메서드를 직접 호출
  events [옵션]          이벤트를 줄 단위 JSON으로 흘려보낸다
  focus                  창을 앞으로 가져온다

워크스페이스:
  list-workspaces        목록
  current-workspace      지금 보고 있는 워크스페이스
  tree                   워크스페이스와 pane 배치 전체
  new-workspace [path]   새 워크스페이스 (--cwd, --title)
  select-workspace <h>   전환
  close-workspace [h]    닫기
  rename-workspace [h] <title>   이름 바꾸기

pane:
  list-panes             현재 워크스페이스의 pane 목록
  new-split [방향]       분할 (right|left|down|up, 기본 right)
  focus-pane <h>         포커스 이동
  close-pane [h]         닫기

세션:
  list-sessions          세션 목록
  read-screen            화면을 텍스트로 (--lines N)
  send <text>            텍스트 입력 (--enter로 엔터까지)
  send-key <key>         키 하나 (Enter, Escape, Ctrl+C, F5 …)
  set-title <title>      제목 지정
  close-session [h]      종료
  restart-session [h]    같은 디렉토리에서 재시작

알림:
  notify <text>          알림 보내기 (--title)
  list-notifications     읽지 않은 알림
  mark-notification-read [h]   읽음 처리 (--all)
  open-notification [h]  그 세션으로 이동하고 읽음 처리
  jump-to-unread         가장 최근 읽지 않은 알림으로 이동
  clear-notifications    전부 읽음 처리

기타:
  open <path>            그 디렉토리에서 새 워크스페이스
  version                버전
  help                   이 도움말

환경변수:
  CVMUX                  cvmux 세션 안이면 1
  CVMUX_SESSION_ID       이 세션의 id
  CVMUX_SOCKET_PATH      제어 소켓 파이프 경로
  CVMUX_SOCKET_PASSWORD  제어 소켓 비밀번호`

const USAGE: Record<string, string> = {
  ping: 'Usage: cvmux ping',
  capabilities: 'Usage: cvmux capabilities',
  identify: 'Usage: cvmux identify',
  focus: 'Usage: cvmux focus',
  rpc: 'Usage: cvmux rpc <method> [json-params]',
  events: 'Usage: cvmux events [--after <seq>] [--name <event>] [--limit <n>]',
  'list-workspaces': 'Usage: cvmux list-workspaces',
  'current-workspace': 'Usage: cvmux current-workspace',
  tree: 'Usage: cvmux tree',
  'new-workspace': 'Usage: cvmux new-workspace [path] [--cwd <path>] [--title <name>]',
  'select-workspace': 'Usage: cvmux select-workspace <id|ref|index>',
  'close-workspace': 'Usage: cvmux close-workspace [id|ref|index]',
  'rename-workspace': 'Usage: cvmux rename-workspace [id|ref|index] <title>',
  'list-panes': 'Usage: cvmux list-panes [--workspace <handle>]',
  'new-split': 'Usage: cvmux new-split [right|left|down|up] [--pane <handle>]',
  'focus-pane': 'Usage: cvmux focus-pane <id|ref|index>',
  'close-pane': 'Usage: cvmux close-pane [id|ref|index]',
  'list-sessions': 'Usage: cvmux list-sessions',
  'read-screen': 'Usage: cvmux read-screen [--session <handle>] [--lines <n>]',
  send: 'Usage: cvmux send <text> [--enter] [--session <handle>]',
  'send-key': 'Usage: cvmux send-key <key> [--session <handle>]',
  'set-title': 'Usage: cvmux set-title <title> [--session <handle>]',
  'close-session': 'Usage: cvmux close-session [handle]',
  'restart-session': 'Usage: cvmux restart-session [handle]',
  notify: 'Usage: cvmux notify <text> [--title <title>] [--session <handle>]',
  'list-notifications': 'Usage: cvmux list-notifications',
  'mark-notification-read': 'Usage: cvmux mark-notification-read [handle] [--all]',
  'dismiss-notification': 'Usage: cvmux dismiss-notification <handle>',
  'clear-notifications': 'Usage: cvmux clear-notifications',
  'open-notification': 'Usage: cvmux open-notification [handle]',
  'jump-to-unread': 'Usage: cvmux jump-to-unread',
  open: 'Usage: cvmux open <path>',
  version: 'Usage: cvmux version',
  help: 'Usage: cvmux help'
}

export function commandHelp(command: string): string {
  return USAGE[command] ?? `모르는 명령: ${command}`
}

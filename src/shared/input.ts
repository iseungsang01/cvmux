/**
 * 렌더러가 세션으로 보내는 것 가운데 무엇이 사람 손에서 왔는가.
 *
 * xterm은 키 입력 말고도 스스로 답하는 제어 시퀀스(포커스 보고, 장치 속성
 * 응답)와 마우스 보고를 같은 길로 보낸다. 옆 에이전트에게 답 넘기기(P29-6)와
 * 동시 입력(P30-7)이 둘을 갈라야 한다.
 */

/** 터미널이 스스로 보내는 응답. 방향키 같은 키 입력은 여기 들지 않는다 */
const TERMINAL_REPLIES: RegExp[] = [
  /\x1b\[[IO]/g, // 포커스 보고
  /\x1b\[[?>]?[\d;]*c/g, // 장치 속성 응답
  /\x1b\[\d+;\d+R/g, // 커서 위치 응답
  /\x1b\[\?[\d;]*\$y/g, // 모드 질의 응답
  /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g // OSC 응답 (색 질의 등)
]

/** 마우스 보고 — SGR(`ESC[<b;x;yM`)과 옛 X10(`ESC[M` + 세 바이트) */
const MOUSE_REPORTS: RegExp[] = [/\x1b\[<[\d;]*[Mm]/g, /\x1b\[M[\s\S]{3}/g]

function strip(data: string, patterns: RegExp[]): string {
  return patterns.reduce((rest, pattern) => rest.replace(pattern, ''), data)
}

/**
 * 사람이 친 키나 누른 마우스인가 (P29-6).
 *
 * 에이전트 TUI는 포커스 보고를 켜 두므로, 이것까지 사람 입력으로 세면 pane을
 * 클릭만 해도 핑퐁 횟수가 되돌려진다.
 */
export function isHumanInput(data: string): boolean {
  return strip(data, TERMINAL_REPLIES).length > 0
}

/**
 * 다른 pane에도 똑같이 보낼 키인가 (P30-7).
 *
 * 마우스 보고는 그 pane의 좌표라 옆 pane에서는 엉뚱한 자리를 누른다. tmux의
 * `synchronize-panes`도 키만 나눠 준다.
 */
export function isBroadcastInput(data: string): boolean {
  return strip(strip(data, TERMINAL_REPLIES), MOUSE_REPORTS).length > 0
}

/**
 * 키 조합 (POLICY.md P22-5).
 *
 * 설정 파일의 `"Ctrl+Shift+N"`을 실제 키 이벤트와 맞춰 본다.
 *
 * 키 이름은 **`event.code`**를 쓴다 — `KeyN`, `Digit1`, `Equal`. `event.key`가
 * 아닌 이유는 한글 자판이나 다른 레이아웃에서 같은 자리를 눌러도 문자가 달라지기
 * 때문이다. 자리로 약속해야 어느 자판에서든 같은 키가 된다.
 */

export interface Chord {
  ctrl: boolean
  shift: boolean
  alt: boolean
  code: string
}

/**
 * 키 이벤트에서 실제로 쓰는 부분만.
 *
 * DOM의 `KeyboardEvent`를 직접 쓰지 않는 이유는 이 파일이 main 쪽 타입 검사에도
 * 걸리기 때문이다. 필요한 것만 적어 두면 테스트에서 흉내 내기도 쉽다.
 */
export interface KeyEventLike {
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
  metaKey: boolean
  code: string
}

/** 사람이 쓰기 쉬운 이름 → `event.code` */
const ALIASES: Record<string, string> = {
  '=': 'Equal',
  '+': 'Equal',
  plus: 'Equal',
  '-': 'Minus',
  minus: 'Minus',
  '[': 'BracketLeft',
  ']': 'BracketRight',
  ',': 'Comma',
  '.': 'Period',
  '/': 'Slash',
  '\\': 'Backslash',
  ';': 'Semicolon',
  "'": 'Quote',
  '`': 'Backquote',
  space: 'Space',
  enter: 'Enter',
  escape: 'Escape',
  esc: 'Escape',
  tab: 'Tab',
  backspace: 'Backspace',
  delete: 'Delete',
  up: 'ArrowUp',
  down: 'ArrowDown',
  left: 'ArrowLeft',
  right: 'ArrowRight',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pagedown: 'PageDown'
}

/**
 * `"Ctrl+Shift+N"` → Chord.
 *
 * @returns 해석할 수 없으면 null — 설정에 오타가 있다고 앱이 멈추지는 않는다(P22-2)
 */
export function parseChord(text: string): Chord | null {
  const trimmed = text.trim()
  if (trimmed === '') return null

  const parts = trimmed.split('+').map((p) => p.trim())
  // "Ctrl++"처럼 마지막이 `+`인 경우 split이 빈 조각을 남긴다
  if (parts.length > 1 && parts[parts.length - 1] === '') {
    parts.pop()
    parts.push('+')
  }

  const chord: Chord = { ctrl: false, shift: false, alt: false, code: '' }

  for (const part of parts) {
    const lower = part.toLowerCase()
    if (lower === 'ctrl' || lower === 'control') {
      chord.ctrl = true
      continue
    }
    if (lower === 'shift') {
      chord.shift = true
      continue
    }
    if (lower === 'alt' || lower === 'option') {
      chord.alt = true
      continue
    }
    // 수정자가 아닌 조각은 실제 키다. 둘 이상이면 조합이 잘못된 것이다
    if (chord.code !== '') return null

    const alias = ALIASES[lower]
    if (alias) {
      chord.code = alias
      continue
    }
    if (/^[a-z]$/.test(lower)) {
      chord.code = `Key${lower.toUpperCase()}`
      continue
    }
    if (/^[0-9]$/.test(lower)) {
      chord.code = `Digit${lower}`
      continue
    }
    if (/^f([1-9]|1[0-9]|2[0-4])$/.test(lower)) {
      chord.code = `F${lower.slice(1)}`
      continue
    }
    // 이미 event.code 표기라면 그대로 받는다 (KeyN, Digit1, Equal …)
    if (/^[A-Za-z][A-Za-z0-9]*$/.test(part)) {
      chord.code = part
      continue
    }
    return null
  }

  return chord.code === '' ? null : chord
}

/**
 * 이벤트가 이 조합인가.
 *
 * 수정자는 **정확히** 맞아야 한다. `Ctrl+Shift+N`을 눌러 달라고 했는데
 * `Ctrl+Alt+Shift+N`에도 반응하면, 다른 조합을 눌렀는데 엉뚱한 일이 벌어진다.
 */
export function matchesChord(chord: Chord, event: KeyEventLike): boolean {
  if (event.metaKey) return false
  return (
    event.ctrlKey === chord.ctrl &&
    event.shiftKey === chord.shift &&
    event.altKey === chord.alt &&
    event.code === chord.code
  )
}

/**
 * 설정의 단축키 표를 조합 표로 바꾼다.
 *
 * 빈 문자열은 "이 동작에 단축키를 두지 않는다"는 뜻이므로 그냥 빠진다.
 * 해석되지 않는 값도 마찬가지다 — 잘못 적은 조합 하나가 나머지를 막지 않는다.
 */
export function compileBindings(bindings: Record<string, string>): Map<string, Chord> {
  const out = new Map<string, Chord>()
  for (const [action, text] of Object.entries(bindings)) {
    const chord = parseChord(text)
    if (chord) out.set(action, chord)
  }
  return out
}

/** 눌린 키에 해당하는 동작. 없으면 null */
export function actionFor(bindings: Map<string, Chord>, event: KeyEventLike): string | null {
  for (const [action, chord] of bindings) {
    if (matchesChord(chord, event)) return action
  }
  return null
}

/** 화면에 보여줄 표기. 설정에 적힌 것을 그대로 보여주기보다 정규화한다 */
export function formatChord(chord: Chord): string {
  const parts: string[] = []
  if (chord.ctrl) parts.push('Ctrl')
  if (chord.alt) parts.push('Alt')
  if (chord.shift) parts.push('Shift')

  const code = chord.code
  if (code.startsWith('Key')) parts.push(code.slice(3))
  else if (code.startsWith('Digit')) parts.push(code.slice(5))
  else if (code === 'Equal') parts.push('=')
  else if (code === 'Minus') parts.push('-')
  else parts.push(code)

  return parts.join('+')
}

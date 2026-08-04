/*
 * 설정 파일(POLICY.md P22)의 회귀 테스트.
 *
 * 지켜야 하는 것은 하나다 — **설정 파일의 실수가 앱을 못 쓰게 만들지 않는다.**
 * 값 하나가 틀렸다고 그 구역이 통째로 기본값으로 돌아가거나, 파일에 오타가
 * 있다고 터미널이 안 뜨면, 설정 파일을 여는 것 자체가 위험한 일이 된다.
 *
 * 실행: npm test
 */
import { DEFAULT_CONFIG, parseConfig, parseJsonc } from '../src/shared/config'
import { actionFor, compileBindings, formatChord, parseChord } from '../src/shared/keys'

const results: string[] = []
let failed = 0

function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failed++
  results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `  ← ${detail}` : ''}`)
}

function key(
  code: string,
  mods: { ctrl?: boolean; shift?: boolean; alt?: boolean; meta?: boolean } = {}
): { ctrlKey: boolean; shiftKey: boolean; altKey: boolean; metaKey: boolean; code: string } {
  return {
    code,
    ctrlKey: mods.ctrl === true,
    shiftKey: mods.shift === true,
    altKey: mods.alt === true,
    metaKey: mods.meta === true
  }
}

function main(): void {
  // ── 빈 설정은 기본값
  {
    const { config, problems } = parseConfig({})
    check('빈 설정에 문제 없음', problems.length === 0)
    check('기본 폰트 크기', config.terminal.fontSize === DEFAULT_CONFIG.terminal.fontSize)
    check('null도 받는다', parseConfig(null).problems.length === 0)
  }

  // ── 값이 얹힌다
  {
    const { config, problems } = parseConfig({
      terminal: { fontSize: 16, cursorStyle: 'block' },
      sidebar: { width: 300 }
    })
    check('설정한 값이 반영된다', config.terminal.fontSize === 16)
    check('커서 모양', config.terminal.cursorStyle === 'block')
    check('사이드바 폭', config.sidebar.width === 300)
    check('건드리지 않은 값은 기본값', config.terminal.lineHeight === 1.25)
    check('문제 없음', problems.length === 0, problems.map((p) => p.path).join(','))
  }

  /*
   * 값 하나가 틀려도 그 구역이 통째로 무너지지 않는다 (P22-2).
   *
   * 여기가 이 테스트의 핵심이다. fontSize에 문자열을 넣었다고 폰트 이름까지
   * 기본값으로 돌아가면, 무엇을 고쳐야 하는지 알아내기 어렵다.
   */
  {
    const { config, problems } = parseConfig({
      terminal: { fontFamily: 'Consolas', fontSize: '크게' }
    })
    check('잘못된 값만 무시된다', config.terminal.fontFamily === 'Consolas')
    check('잘못된 값은 기본값', config.terminal.fontSize === 13)
    check('무엇이 틀렸는지 알려준다', problems.some((p) => p.path === 'terminal.fontSize'))
  }

  // 범위를 벗어난 값
  {
    const { config, problems } = parseConfig({ terminal: { fontSize: 500 } })
    check('범위 밖은 기본값', config.terminal.fontSize === 13)
    check('범위 문제를 알려준다', problems.some((p) => p.path === 'terminal.fontSize'))
  }

  /*
   * 모르는 항목은 짚어 준다 (P22-3).
   *
   * `fontSizze`처럼 잘못 적은 키는 아무 일도 일으키지 않고, 아무 일도 일어나지
   * 않는 것이 가장 알아채기 어렵다. 값을 고쳤는데 화면이 그대로면 사람은
   * 기능이 고장 났다고 읽는다.
   */
  {
    const { problems } = parseConfig({ terminal: { fontSizze: 20 }, nonsense: 1 })
    check('모르는 최상위 항목', problems.some((p) => p.path === 'nonsense'))
    check('오타 난 하위 키', problems.some((p) => p.path === 'terminal.fontSizze'))
    check('설정은 그래도 살아 있다', parseConfig({ nonsense: 1 }).config.terminal.fontSize === 13)
  }

  // 색
  {
    const { config, problems } = parseConfig({
      theme: { background: '#101010', blue: 'blue', frobnicate: '#fff000' }
    })
    check('올바른 색은 반영', config.theme.background === '#101010')
    check('이름 색은 거부', config.theme.blue === DEFAULT_CONFIG.theme.blue)
    check('모르는 색 이름', problems.some((p) => p.path === 'theme.frobnicate'))
  }

  // ── JSONC
  {
    const parsed = parseJsonc(`{
      // 줄 주석
      "terminal": { "fontSize": 15 }, /* 블록 주석 */
      "sidebar": { "width": 300, },
    }`) as { terminal: { fontSize: number } }
    check('주석을 걷어낸다', parsed.terminal.fontSize === 15)

    const withSlash = parseJsonc('{"terminal":{"shell":"C://tools//pwsh.exe"}}') as {
      terminal: { shell: string }
    }
    check('문자열 안의 //는 주석이 아니다', withSlash.terminal.shell === 'C://tools//pwsh.exe')
  }

  // ── 키 조합
  {
    check('Ctrl+Shift+N', formatChord(parseChord('Ctrl+Shift+N')!) === 'Ctrl+Shift+N')
    check('소문자도 받는다', parseChord('ctrl+shift+n')?.code === 'KeyN')
    check('숫자', parseChord('Ctrl+Alt+1')?.code === 'Digit1')
    check('기능키', parseChord('F5')?.code === 'F5')
    check('기호 별칭', parseChord('Alt+Shift+=')?.code === 'Equal')
    check('event.code 표기 그대로', parseChord('Alt+Shift+Minus')?.code === 'Minus')
    check('빈 문자열은 없음', parseChord('') === null)
    check('키가 둘이면 거부', parseChord('Ctrl+A+B') === null)
    check('수정자만 있으면 거부', parseChord('Ctrl+Shift') === null)
  }

  /*
   * 수정자는 정확히 맞아야 한다 (P22-5).
   *
   * Ctrl+Shift+N에 Ctrl+Alt+Shift+N까지 반응하면, 다른 조합을 눌렀는데
   * 엉뚱한 일이 벌어진다.
   */
  {
    const bindings = compileBindings({ 'workspace.new': 'Ctrl+Shift+N' })
    check('맞는 조합', actionFor(bindings, key('KeyN', { ctrl: true, shift: true })) === 'workspace.new')
    check(
      '수정자가 더 붙으면 아니다',
      actionFor(bindings, key('KeyN', { ctrl: true, shift: true, alt: true })) === null
    )
    check('수정자가 빠지면 아니다', actionFor(bindings, key('KeyN', { ctrl: true })) === null)
    check(
      'Win 키가 눌려 있으면 아니다',
      actionFor(bindings, key('KeyN', { ctrl: true, shift: true, meta: true })) === null
    )
    check('다른 키', actionFor(bindings, key('KeyM', { ctrl: true, shift: true })) === null)
  }

  // 빈 조합은 단축키를 없앤다는 뜻
  {
    const bindings = compileBindings({ 'workspace.new': '', 'pane.close': 'Ctrl+Shift+W' })
    check('빈 조합은 등록되지 않는다', !bindings.has('workspace.new'))
    check('나머지는 그대로', bindings.has('pane.close'))
  }

  // 잘못 적은 조합 하나가 나머지를 막지 않는다
  {
    const bindings = compileBindings({ bad: 'Ctrl+Shift', good: 'Ctrl+Shift+K' })
    check('해석 안 되는 것만 빠진다', !bindings.has('bad') && bindings.has('good'))
  }

  // 기본 단축키는 전부 해석된다 — 오타가 있으면 그 동작이 조용히 사라진다
  {
    const bindings = compileBindings(DEFAULT_CONFIG.keybindings)
    const total = Object.keys(DEFAULT_CONFIG.keybindings).length
    check('기본 단축키가 모두 유효', bindings.size === total, `${bindings.size}/${total}`)
  }

  /*
   * 기본 단축키는 셸이 쓰는 키를 건드리지 않는다 (P6-1).
   *
   * Ctrl 단독 조합은 거의 다 PSReadLine의 것이다. 기본값이 그것을 가로채면
   * 설정을 열어 보기도 전에 셸이 망가진다.
   */
  {
    const offenders = Object.entries(DEFAULT_CONFIG.keybindings).filter(([, text]) => {
      const chord = parseChord(text)
      return chord !== null && chord.ctrl && !chord.shift && !chord.alt
    })
    check('Ctrl 단독 기본 단축키 없음', offenders.length === 0, offenders.map(([a]) => a).join(','))
  }

  console.log(results.join('\n'))
  console.log(`\n${results.length - failed}/${results.length} passed`)
  process.exit(failed === 0 ? 0 : 1)
}

main()

import { existsSync, mkdirSync, readFileSync, watch, writeFileSync, type FSWatcher } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import {
  DEFAULT_CONFIG,
  parseConfig,
  parseJsonc,
  type ConfigProblem,
  type CvmuxConfig
} from '@shared/config'

/**
 * 설정 파일을 읽고 지켜본다 (POLICY.md P22).
 *
 * 자리는 두 곳을 본다. `%APPDATA%\cvmux\cvmux.json`이 정본이고, 없으면
 * `~/.config/cvmux/cvmux.json`을 본다 — dotfile을 한곳에 모아 두는 사람이
 * 있고, cmux가 쓰는 자리와 같은 모양이라 옮겨 오기도 쉽다.
 */

export function configPaths(): string[] {
  const appData = process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming')
  return [join(appData, 'cvmux', 'cvmux.json'), join(homedir(), '.config', 'cvmux', 'cvmux.json')]
}

export interface ConfigSnapshot {
  config: CvmuxConfig
  /** 실제로 읽은 파일. 아무 파일도 없으면 null */
  source: string | null
  problems: ConfigProblem[]
}

export class ConfigStore {
  private snapshot: ConfigSnapshot = {
    config: DEFAULT_CONFIG,
    source: null,
    problems: []
  }
  private watchers: FSWatcher[] = []
  private reloadTimer: NodeJS.Timeout | null = null

  constructor(private readonly onChange: (snapshot: ConfigSnapshot) => void) {}

  get current(): ConfigSnapshot {
    return this.snapshot
  }

  load(): ConfigSnapshot {
    for (const path of configPaths()) {
      if (!existsSync(path)) continue

      try {
        const raw = readFileSync(path, 'utf8')
        const { config, problems } = parseConfig(parseJsonc(raw))
        this.snapshot = { config, source: path, problems }
        return this.snapshot
      } catch (error) {
        /*
         * 읽지 못한 설정은 기본값으로 대신한다 (P22-3).
         *
         * JSON 한 글자가 틀렸다고 터미널을 못 쓰게 되면 안 된다. 대신 무엇이
         * 잘못됐는지는 남겨 `cvmux config doctor`가 그대로 보여 준다.
         */
        this.snapshot = {
          config: DEFAULT_CONFIG,
          source: path,
          problems: [{ path: '', message: error instanceof Error ? error.message : String(error) }]
        }
        return this.snapshot
      }
    }

    this.snapshot = { config: DEFAULT_CONFIG, source: null, problems: [] }
    return this.snapshot
  }

  /**
   * 파일이 바뀌면 다시 읽는다 (P22-4).
   *
   * 편집기는 저장 한 번에 이벤트를 여러 번 낸다. 묶지 않으면 한 번 저장할
   * 때마다 렌더러가 서너 번 흔들린다.
   */
  watchFiles(): void {
    for (const path of configPaths()) {
      const dir = dirname(path)
      if (!existsSync(dir)) continue
      try {
        const watcher = watch(dir, (_event, name) => {
          if (name !== 'cvmux.json') return
          if (this.reloadTimer) clearTimeout(this.reloadTimer)
          this.reloadTimer = setTimeout(() => {
            this.reloadTimer = null
            this.onChange(this.load())
          }, 150)
        })
        this.watchers.push(watcher)
      } catch {
        // 감시에 실패해도 `cvmux config reload`로 다시 읽을 수 있다
      }
    }
  }

  reload(): ConfigSnapshot {
    const snapshot = this.load()
    this.onChange(snapshot)
    return snapshot
  }

  dispose(): void {
    if (this.reloadTimer) clearTimeout(this.reloadTimer)
    for (const watcher of this.watchers) watcher.close()
    this.watchers = []
  }

  /**
   * 설정 파일이 없으면 주석이 달린 본보기를 만든다 (P22-1).
   *
   * 빈 `{}`를 던져 주면 무엇을 쓸 수 있는지 알 길이 없다. 기본값을 주석으로
   * 적어 두면 파일 자체가 설명서가 된다.
   */
  ensureFile(): string {
    const path = configPaths()[0]
    if (existsSync(path)) return path

    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, TEMPLATE, 'utf8')
    return path
  }
}

const TEMPLATE = `{
  // cvmux 설정. 주석과 마지막 쉼표를 써도 된다.
  // 값을 지우면 기본값으로 돌아간다. \`cvmux config doctor\`로 확인할 수 있다.

  "terminal": {
    // "fontFamily": "Cascadia Mono, Consolas, monospace",
    // "fontSize": 13,
    // "lineHeight": 1.25,
    // "cursorStyle": "bar",       // bar | block | underline
    // "cursorBlink": true,
    // "scrollback": 10000,
    // "shell": null,              // 비우면 pwsh → powershell → cmd 순으로 찾는다

    // 앱을 다시 켤 때 에이전트 세션을 이어서 띄울지. \`cvmux hooks setup\` 참고
    // "autoResumeAgentSessions": true
  },

  "sidebar": {
    // "width": 264,
    // "fontSize": 13
  },

  // 터미널 색. #rrggbb 형태만 받는다
  "theme": {
    // "background": "#0d1016",
    // "foreground": "#d3d9e3",
    // "blue": "#7aa2f7"
  },

  // 단축키. 빈 문자열이면 그 동작의 단축키를 없앤다.
  // 키 이름은 자판 위치(event.code)를 쓴다 — "N", "1", "F5", "Equal", "Minus".
  "keybindings": {
    // "workspace.new": "Ctrl+Shift+N",
    // "view.palette": "Ctrl+Shift+P",
    // "find.session": "Alt+F"
  }
}
`

# cvmux

> claude 좀 대충 쓰지마요 cvmux~

Windows용 터미널 워크스페이스 매니저. PowerShell 세션 여러 개를 한 창에서 돌리고,
**사이드바에서 각 세션이 지금 무엇을 하는지** 한눈에 본다. Claude Code·Codex 같은
에이전트를 여럿 띄워 두고 쓰는 데 맞춰져 있다.

macOS 전용인 [cmux](https://github.com/manaflow-ai/cmux)를 Windows로 옮겨 온 것이다.
macOS를 쓴다면 cmux가 낫다.

```
┌────────────┬──────────────────────────┐
│ ● main     │ PS C:\...\cvmux>         │
│   cvmux    │ npm run dev              │
│   :5173    │                          │
├────────────┤ VITE ready in 412 ms     │
│ ○ feat/api │                          │
│   backend  │                          │
├────────────┤                          │
│ ◍ claude   │                          │
│   agent    │ ← 파란 링 = 확인 필요    │
└────────────┴──────────────────────────┘
```

- **사이드바 신호등** — 실행 중·대기·확인 필요를 구분하고 git 브랜치와 리슨 포트를 붙인다
- **에이전트 알림** — 에이전트가 확인을 기다리면 파란 링과 Windows 토스트. 놓친 것은 알림함에 남는다
- **분할·탭·여러 창**, **트레이 상주** — 창을 닫아도 세션은 계속 돈다
- **복원** — 껐다 켜면 배치·작업 디렉토리·이름이 돌아오고 에이전트 대화도 이어서 뜬다
- **`cvmux` CLI** — 세션 안에서 워크스페이스·pane·입력·화면을 조종한다
- **에이전트끼리 답 넘기기** — 분할선의 ⇄를 켜면 Claude Code와 Codex가 서로의 답을 받아 일한다
- **내장 브라우저** — 에이전트가 자기가 고친 화면을 직접 조작해 확인한다
- 명령 팔레트 · 전체 세션 검색 · 설정 파일 · 자동 업데이트 · 한글 UTF-8 · 트루컬러

## 설치

[Releases](https://github.com/iseungsang01/cvmux/releases/latest)에서
`cvmux-x.y.z-setup.exe`를 받아 실행한다. 관리자 권한 없이 사용자 폴더에 설치되고,
그 뒤 업데이트는 앱이 알아서 받는다. 서명하지 않은 설치 파일이라 SmartScreen이 한 번
경고한다 — "추가 정보 → 실행".

Windows 10 1809 이상이 필요하다(ConPTY).

## 사이드바

사이드바 한 줄이 워크스페이스 하나다. 표시는 세션 상태를 말한다.

| 표시 | 상태 | 뜻 |
|------|------|----|
| 🟢 초록 점 (펄스) | 실행 중 | 출력이 흐르는 중 |
| ⚪ 회색 빈 원 | 대기 | 프롬프트에서 대기 |
| 🔵 파란 링 (점선) | 입력 대기 **추정** | 출력이 멎었는데 프롬프트가 아니다 |
| 🔵 파란 링 + 점 | **확인 필요** | 프로세스가 직접 알림을 보냈다 |
| ⬜ 사각형 | 종료됨 | 종료 코드와 함께 |
| ◌ 작은 점선 원 | 꺼져 있음 | 복원만 해 두었다 — 누르면 켜진다 |

점선은 cvmux의 추측이고, 실선 + 점은 프로세스가 직접 한 말이다.

- 제목 아래에 **git 브랜치**(변경이 있으면 점, `↑2 ↓1`)와 **리슨 포트**(`:5173`)가 붙는다.
  포트는 세션이 띄운 프로세스 전체에서 찾으므로 `npm run dev`가 연 것도 잡힌다
- 제목은 **더블클릭**해서 바꾸고, 줄은 끌어서 순서를 바꾼다
- 셸 통합이 작업 디렉토리를 따라가므로 `cd`하면 저장소와 브랜치도 바뀐다
  (프로필은 건드리지 않는다. `CVMUX_NO_SHELL_INTEGRATION=1`로 끈다)

## 창·분할·탭

- **분할** — `Alt+Shift+=` 오른쪽, `Alt+Shift+-` 아래. 경계는 끌어서 조정한다.
  가장 손이 필요한 pane이 사이드바에 대표로 올라온다
- **탭** — `Ctrl+Shift+T`로 pane 안에 탭을 더한다. 끌어서 순서를 바꾼다
- **창** — `Ctrl+Alt+N`. 모니터마다 창을 두고 워크스페이스를 옮길 수 있다
- **트레이** — 창을 닫아도(X) 앱은 트레이에 남고 세션은 계속 돈다.
  완전히 끄는 것은 트레이 메뉴의 "종료"뿐이다

**복원.** 껐다 켜면 배치·작업 디렉토리·이름이 돌아온다. 이전 화면은 되살리지 않고
셸은 빈 화면에서 시작한다. 셸은 **처음 보이는 세션만** 바로 뜨고, 나머지는
"꺼져 있음"으로 기다리다 누르는 순간 켜진다. 늘 켜 둘 줄은 마우스를 올리고 **📌**로
고정한다.

## 단축키

| 키 | 동작 |
|----|------|
| `Ctrl+Shift+N` | 새 세션 (보고 있던 디렉토리에서) |
| `Ctrl+Alt+N` | 새 창 |
| `Alt+Shift+=` / `Alt+Shift+-` | 오른쪽 / 아래로 분할 |
| `Ctrl+Shift+W` | pane 닫기 (마지막 pane이면 세션 전체) |
| `Ctrl+Shift+T` | 이 pane에 새 탭 |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | 다음 / 이전 탭 |
| `Ctrl+Alt+1` ~ `8` | 세션 전환 |
| `Ctrl+Shift+B` | 사이드바 접기/펴기 |
| `Alt+Shift+B` | 오른쪽 사이드바 (로그·할 일·세션·찾기) |
| `Ctrl+Shift+P` | 명령 팔레트 |
| `Ctrl+Shift+I` / `Ctrl+Shift+U` | 알림함 / 읽지 않은 알림으로 이동 |
| `Alt+F` / `Ctrl+Shift+F` | 이 화면에서 / 모든 세션에서 찾기 |
| `Ctrl+V` | 붙여넣기 (클립보드에 이미지만 있으면 그대로 세션에 전달) |
| `Enter` (종료된 pane에서) | 같은 디렉토리에서 재시작 |

전부 `Shift`나 `Alt`가 붙는다 — `Ctrl+C`·`Ctrl+W` 같은 키는 셸의 몫이다.
설정의 `keybindings`에서 바꿀 수 있다.

## 에이전트와 함께 쓰기

**훅 설치** — Claude Code라면 한 줄이면 된다.

```powershell
cvmux hooks setup      # 설치 (status / uninstall)
```

확인을 기다릴 때 알림이 오고, 대화 id가 기록돼 앱을 껐다 켜면 그 셸에서
`claude --resume <id>`가 이어서 뜬다(`terminal.autoResumeAgentSessions: false`로 끈다).
Codex는 `cvmux hooks setup --agent codex`. 그 밖의 에이전트는 훅에
`cvmux hooks record --agent <이름>` 한 줄을 직접 건다 — 이어서 띄우기는
claude · codex · gemini · copilot · cursor · codebuddy · factory · qoder를 안다.

**옆 에이전트에게 답 넘기기** — 화면을 나눠 왼쪽에 Claude Code, 오른쪽에 Codex를
띄우고 분할선 가운데의 **⇄**를 누른다. 누를 때마다 끔 → 오른쪽으로(→) →
왼쪽으로(←) → 양쪽(⇄)으로 바뀐다. 켜 두면 한쪽이 답을 끝낼 때마다 그 답이 옆
입력창에 들어가 보내진다.

```powershell
cvmux hooks setup                  # Claude Code
cvmux hooks setup --agent codex    # Codex — 그다음 Codex 안에서 /hooks로 한 번 승인
```

- 넘기는 것은 에이전트가 훅으로 알려 준 **마지막 답**이다(화면을 긁지 않는다)
- 옆 칸이 셸 프롬프트면 넣지 않는다 — 답이 명령으로 실행되면 안 된다
- 옆 에이전트가 일하는 중이거나 권한을 묻는 중이면 끝날 때까지 기다린다
- 사람 입력 없이 10번 이어지면 스스로 꺼진다(`relay.maxAutoTurns`). 한 번 끼어들면 다시 센다
- 켜 둔 연결은 앱을 다시 켜도 남는다

**알림 보내기** — 스크립트나 훅에서:

```powershell
cvmux notify --title "빌드" "배포 준비 완료"
```

터미널 알림 시퀀스(OSC 9 / 777 / 99, BEL)도 알아듣는다. 훅이 없어도 출력이 멎으면
"입력 대기(추정)"로 표시된다.

**사이드바에 쓰기** — 에이전트가 자기 진행 상황을 직접 적는다.

```powershell
cvmux set-status --name build "테스트 12/40"
cvmux set-progress 0.3 --text "browser.test.ts"
cvmux log --level warn "느린 테스트 3개를 건너뜁니다"
cvmux todo add "테스트 통과시키기"
```

**내장 브라우저** — 터미널 옆에 브라우저 pane을 띄우고 에이전트가 조작한다.
스냅샷이 요소마다 이름을 붙이고, 조작은 그 이름을 가리킨다.

```powershell
cvmux browser open localhost:5173
cvmux browser snapshot          # - textbox "이름" [e2] ...
cvmux browser fill e2 --value "승상"
cvmux browser click e3
cvmux browser screenshot        # PNG를 base64로
```

## CLI

세션 안에서는 `cvmux`가 바로 잡힌다(세션 PATH에만 얹는다). 세션 안의
`$env:CVMUX_SESSION_ID`가 자기 세션이다.

```powershell
cvmux new-workspace C:\repo            # 그 디렉토리에서 새 워크스페이스
cvmux new-split down                   # 아래로 분할
cvmux send --session 2 "npm test" --enter
cvmux read-screen --lines 40           # 화면을 텍스트로
cvmux events --name session.notify     # 이벤트를 줄 단위 JSON으로
```

대상은 `workspace:2` 같은 참조·순번·id로 가리키고, 생략하면 지금 보고 있는 것이다.
전체 명령은 `cvmux --help`(앱이 꺼져 있어도 답한다), 프로토콜은 [POLICY.md](./POLICY.md)의 P20.

## 설정

`%APPDATA%\cvmux\cvmux.json`. 처음 실행할 때 주석 달린 본보기를 만들어 둔다.
저장하면 바로 반영된다(셸만 다음 세션부터). 주석과 마지막 쉼표를 써도 된다.

```jsonc
{
  "terminal": {
    "fontFamily": "Cascadia Mono, Consolas, monospace",
    "fontSize": 14,
    "scrollback": 10000,
    "shell": null,             // 비우면 pwsh → powershell → cmd 순으로 찾는다
    "gpuRendering": false      // true면 WebGL로 그린다 — 메모리를 수백 MB 더 쓴다
  },
  "sidebar": { "width": 300 },
  "theme": { "background": "#0d1016", "blue": "#7aa2f7" },
  "keybindings": { "view.palette": "Alt+Shift+P" },
  "relay": { "maxAutoTurns": 10 },   // 옆 에이전트에게 자동으로 넘기는 연속 횟수 상한
  "update": { "enabled": true }
}
```

값이 잘못되면 그 값만 기본값으로 돌아간다. 무엇이 무시됐는지는
`cvmux config doctor`가 알려 준다(`config path`, `config init`도 있다).

## 메모리

셸 하나는 conhost까지 80MB 남짓이라, 복원한 세션은 볼 때 켠다(위 "복원").
앱 자체는 세션 6개를 켜 둔 기준 200MB 안팎이다. 터미널은 기본으로 DOM 렌더러로
그린다 — WebGL(`gpuRendering`)은 박스 문자가 끊김 없이 이어지는 대신 GPU 쪽
메모리를 250MB 남짓 더 쓴다.

## 업데이트

설치본은 GitHub 릴리스를 보고 스스로 갱신한다. 켠 뒤 20초, 그 뒤 6시간마다 확인해
**조용히 내려받기만** 하고, 설치는 타이틀바의 "업데이트 준비됨"이나 트레이 메뉴에서
직접 누른다(실행 중인 세션 수를 보여 주고 묻는다).

```powershell
cvmux update status     # 지금 상태
cvmux update check      # 지금 확인
cvmux update install    # 준비된 것을 설치 — 앱이 종료된다
```

바뀐 것은 [CHANGELOG.md](./CHANGELOG.md)에 있다.

## 개발

Node 18+.

```powershell
npm install
npm run dev        # 개발 모드 (HMR)
npm test           # 회귀 테스트
npm run typecheck
npm run package    # 설치 파일 → release/
```

npm 11부터 install 스크립트가 기본 차단된다. 설치 중 경고가 뜨면
`npm approve-scripts node-pty esbuild` 뒤 `npm rebuild node-pty`.

**릴리스** — [CHANGELOG.md](./CHANGELOG.md) 맨 위에 새 버전 항목을 쓰고:

```powershell
npm version patch -m "%s — 한 줄 요약"
git push --follow-tags     # CI가 설치 파일을 빌드·검사해 릴리스에 올린다
```

엣지 케이스마다 어떻게 동작해야 하는지는 [POLICY.md](./POLICY.md)에 규칙 ID(`P4-9` 등)로
적혀 있고, 코드 주석에 같은 ID가 달려 있다.

```
src/
  core/      Electron에 기대지 않는 알맹이 — PTY, 상태 판정, 저장, 설정
  main/      Electron 메인 — PTY 소유, IPC, 제어 소켓, 창, 브라우저, 트레이
  renderer/  React UI, xterm 수명 관리
  preload/   contextBridge API
  cli/       cvmux 명령줄 도구
  shared/    main ↔ renderer 계약, 정책 상수, 소켓 프로토콜
tests/       회귀 테스트
```

## 라이선스

[GPL-3.0-or-later](./LICENSE). cvmux는 [cmux](https://github.com/manaflow-ai/cmux)
(GPL-3.0-or-later)에서 파생된 저작물을 포함한다. 자세한 것은 [NOTICE.md](./NOTICE.md).

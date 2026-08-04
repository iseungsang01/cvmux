# cvmux

> claude 좀 대충 쓰지마요 cvmux~

Windows용 터미널 워크스페이스 매니저. 여러 PowerShell 세션을 동시에 돌리고,
**왼쪽 사이드바에서 각 세션이 지금 무엇을 하고 있는지 한눈에 보는 것**이 목적이다.

[cmux](https://github.com/manaflow-ai/cmux)에서 아이디어를 가져왔다. cmux는 Swift와
libghostty로 짜인 **macOS 전용** 앱이라 Windows 빌드가 없고, 그래서 이걸 만들었다.
macOS를 쓴다면 cvmux 대신 cmux를 받는 편이 낫다 — 훨씬 완성도가 높다
(`brew tap manaflow-ai/cmux && brew install --cask cmux`).

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

핵심만 추리면:

- **사이드바 신호등** — 세션마다 실행 중·대기·확인 필요를 구분해 보여준다.
  git 브랜치와 리슨 포트도 따라붙는다
- **트레이 상주** — 창을 닫아도 앱은 트레이에 남고 세션은 계속 돈다.
  완전히 끄는 것은 트레이 메뉴의 '종료'뿐이다
- **에이전트 알림** — Claude Code 같은 CLI가 확인을 기다리면 파란 링과 토스트로 알려준다
- 분할 창 · 세션 영속성 · 한글 UTF-8 · 트루컬러

## 설치와 실행

Node 18+ 와 Windows 10 1809(빌드 17763) 이상이 필요하다. ConPTY를 쓰기 때문이다.

```powershell
npm install
npm run dev      # 개발 모드로 바로 실행 (HMR)
```

그 밖의 스크립트:

```powershell
npm run build    # 프로덕션 빌드
npm start        # 빌드 결과 실행
npm test         # 회귀 테스트 (상태 감지 + pane 레이아웃)
npm run typecheck
npm run package  # Windows 설치 프로그램 생성 → release/
```

`npm run package`는 `release/cvmux-0.1.0-setup.exe`를 만든다. 설치하면 시작 메뉴와
바탕화면에 바로가기가 생기고, 그때부터는 런처 PowerShell 없이 바로 띄울 수 있다.
관리자 권한은 필요 없다(사용자 폴더에 설치). 서명하지 않은 설치 파일이라 SmartScreen이
한 번 경고하는데, "추가 정보 → 실행"으로 넘어가면 된다.

`node-pty`는 N-API 모듈이라 Electron용 재빌드가 필요 없다. 단 npm 11부터 install
스크립트가 기본 차단되므로 설치 중 경고가 뜨면 다음을 실행한다.

```powershell
npm approve-scripts node-pty esbuild
npm rebuild node-pty
```

## 상태 표시

이 앱의 핵심. 사이드바의 인디케이터가 세션 상태를 나타낸다.

| 표시 | 상태 | 판정 근거 |
|------|------|----------|
| 🟢 초록 점 (펄스) | 실행 중 | 출력이 흐르는 중 |
| ⚪ 회색 빈 원 | 대기 | 프롬프트에서 대기 |
| 🔵 파란 링 (점선) | 입력 대기 **추정** | 출력이 멎었는데 프롬프트가 아님 |
| 🔵 파란 링 + 점 | **확인 필요** | 프로세스가 명시적으로 알림을 보냄 |
| ⬜ 사각형 | 종료됨 | 종료 코드와 함께 표시 |

**확실한 신호와 추측을 구분한다.** 점선 링은 휴리스틱으로 짐작한 것이고,
실선 링 + 점은 프로세스가 직접 "나 좀 봐줘"라고 말한 것이다.

사이드바 한 줄은 **세 가지만** 답한다 — 무엇인가(제목), 어디인가(저장소 이름),
지금 어떤가(상태). 그 아래에 **git 브랜치**(변경사항이 있으면 점, 앞서거나 뒤처지면
`↑2 ↓1`, rebase 중이면 배지)와 **리슨 중인 포트**(`:5173`)가 보조로 붙는다. 포트는
셸이 아니라 **세션이 띄운 프로세스 트리 전체**를 훑어서 찾으므로 `npm run dev`가 연
포트도 잡힌다.

제목은 **더블클릭해서 바꿀 수 있다**. 지은 이름은 다음에 켤 때도 남는다.

한때 마지막 출력 줄을 미리보기로 흘려보냈지만 걷어냈다. 에이전트 CLI 안에서는
**사용자가 치고 있는 글자가 그대로 사이드바에 새어 나왔고**, 그건 세션의 상태가
아니라 소음이었기 때문이다.

**셸 통합.** 세션이 시작할 때 프로필의 프롬프트를 감싸 작업 디렉토리(OSC 7)와
프롬프트 경계([OSC 133](https://gitlab.freedesktop.org/Per_Bothner/specifications/blob/master/proposals/prompts-data-model.md))를
심는다. `cd`로 옮겨 다녀도 사이드바의 저장소와 git 정보가 따라오고, 상태 판정도
휴리스틱 대신 셸이 직접 알려주는 신호를 쓴다. 프로필 파일은 건드리지 않는다 —
이 세션 안에서만 유효하다 (`CVMUX_NO_SHELL_INTEGRATION=1`로 끌 수 있다).

## 트레이 상주

창을 닫아도(X) 앱은 트레이에 남고 **세션은 계속 돈다** — 창은 세션을 들여다보는
유리창일 뿐이라 닫는다고 안에 있는 것이 사라지지는 않는다. 완전히 끄는 것은
트레이 메뉴의 '종료'뿐이고, 그때 실행 중인 세션이 있으면 확인을 묻는다.

**세션 영속성** — 앱을 껐다 켜면 작업 디렉토리·제목·스크롤백이 돌아온다.
복원된 내용 뒤에는 `── 이전 세션 (복원됨) ──` 구분선을 그어, 그게 죽은 텍스트이고
새 셸이 그 자리에 섰다는 사실을 감추지 않는다.

## 분할 창

사이드바 한 줄이 워크스페이스이고 그 안에 pane을 여럿 둘 수 있다. 분할 키는
Windows Terminal과 같고(`Alt+Shift+=` 오른쪽, `Alt+Shift+-` 아래), 경계는 드래그로
조정할 수 있으며 각 칸은 최소 120px까지만 줄어든다.

여러 pane 중 **가장 손이 필요한 pane**이 사이드바 대표로 올라온다. 실행 중인
pane 하나가 확인을 기다리는 pane을 가려서는 안 되기 때문이다.

## 에이전트에서 알림 보내기

cvmux는 터미널 알림 시퀀스(OSC 9 / OSC 777 / OSC 99 / BEL)를 감지한다.
AI 에이전트가 작업을 마치거나 확인을 기다릴 때 이걸 쏘면 사이드바에 파란 링이 뜬다.
보고 있지 않은 세션이라면 **Windows 토스트 알림**도 함께 뜨고, 클릭하면 그 세션으로
이동한다.

```powershell
# 가장 간단한 형태
$e = [char]27; $b = [char]7
Write-Host -NoNewline "$e]9;빌드가 끝났습니다$b"

# 제목 + 본문
Write-Host -NoNewline "$e]777;notify;Claude Code;검토가 필요합니다$b"
```

헬퍼 스크립트도 있다.

```powershell
.\scripts\cvmux-notify.ps1 "테스트 12개 통과"
.\scripts\cvmux-notify.ps1 -Title "빌드" "배포 준비 완료"
```

**왜 `Write-Host`인가.** 에이전트 훅이나 파이프라인에서는 stdout이 캡처돼 터미널까지
도달하지 못하는 경우가 있다. `Write-Host`는 stdout 리다이렉트와 무관하게 콘솔로 직접
쓴다 — PTY로 실측해 확인했다.

Claude Code라면 `~/.claude/settings.json` 에 훅을 건다. `Notification`은 Claude가
입력을 기다릴 때, `Stop`은 응답을 마쳤을 때 발생한다.

```json
{
  "hooks": {
    "Notification": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "powershell -NoProfile -Command \"$e=[char]27;$b=[char]7;Write-Host -NoNewline \\\"$e]777;notify;Claude Code;확인이 필요합니다$b\\\"\""
          }
        ]
      }
    ]
  }
}
```

훅이 없어도 상관없다. 출력이 멎었는데 프롬프트가 아니면 cvmux가 알아서 "입력 대기(추정)"로
표시한다. 훅은 그 추측을 확신으로 바꿔줄 뿐이다.

세션 안에서는 `$env:CVMUX`가 `1`이고 `$env:CVMUX_SESSION_ID`에 세션 ID가 들어 있으므로
cvmux 안에서 도는지 구분할 수 있다.

## 단축키

| 키 | 동작 |
|----|------|
| `Ctrl+Shift+N` | 새 세션 (보고 있던 작업 디렉토리를 물려받음) |
| `Alt+Shift+=` | 오른쪽으로 분할 |
| `Alt+Shift+-` | 아래로 분할 |
| `Ctrl+Shift+W` | 현재 pane 닫기 (마지막 pane이면 세션 전체) |
| `Ctrl+Alt+1` ~ `8` | 세션 전환 |
| `Ctrl+Shift+B` | 사이드바 접기/펴기 |
| `Ctrl+V` | 붙여넣기 (클립보드에 이미지만 있으면 그대로 세션에 전달) |
| `Enter` (종료된 pane에서) | 같은 디렉토리에서 재시작 |
| 사이드바 제목 더블클릭 | 이름 바꾸기 |

전부 `Shift`나 `Alt`가 붙어 있는 이유가 있다. `Ctrl+C`, `Ctrl+N`, `Ctrl+B`, `Ctrl+W`는
PSReadLine과 bash가 쓰는 키라 앱이 가로채면 안 된다. 터미널이 우선권을 갖는다.

## 색상

트루컬러(24비트)를 완전히 지원한다. 세션에는 `TERM=xterm-256color`와
`COLORTERM=truecolor`가 설정된다.

한 가지 함정이 있다. **다른 에이전트 CLI 안에서 cvmux를 실행하면** 그 CLI가 자기 자식
셸에 심어둔 `NO_COLOR=1`을 Electron이 상속하고, 그게 PTY까지 흘러 세션 안의 모든 도구가
흑백이 된다. 실제로 이 프로젝트를 만들다가 겪었다.

cvmux 세션은 색을 완전히 지원하는 **새 터미널**이므로 런처의 색상 정책을 물려받지 않는다.
세션 환경에서 `NO_COLOR`를 제거한다(같은 조건에서 Node의 `getColorDepth()`가 `1` → `24`로
바뀌는 것을 확인했다). 정말로 색을 끄고 싶으면 `CVMUX_NO_COLOR=1`로 명시하면 된다.

## 동작 정책

엣지 케이스에서 어떻게 행동해야 하는지를 [POLICY.md](./POLICY.md)에 규칙으로 정리해 두었다.
셸이 죽었을 때, 출력이 초당 수 MB로 쏟아질 때, 창을 리사이즈할 때, vim이 떠 있을 때,
한글 코드페이지에서 출력이 깨질 때 각각 무엇을 해야 하는지가 규칙 ID(`P4-9` 같은)로 적혀 있고,
구현 코드에 같은 ID가 주석으로 달려 있어 서로 추적할 수 있다.

```powershell
# 어떤 정책이 어디에 구현됐는지 찾기
Select-String -Path src\*\*.ts,src\*\*\*.tsx -Pattern 'P\d+-\d+'
```

핵심만 추리면:

- **세션은 조용히 사라지지 않는다** — 셸이 죽어도 항목이 남고 종료 코드를 보여준다
- **출력은 유실되지 않는다** — 리사이즈·세션 전환·렌더러 재시작 어디서도
- **추측은 표시하되 단정하지 않는다** — 확실한 신호와 휴리스틱을 시각적으로 구분
- **터미널이 우선권을 갖는다** — 앱 단축키는 셸이 안 쓰는 조합만
- **실패는 세션 단위로 격리된다** — 한 세션의 PTY 크래시가 앱을 죽이지 않는다

## 그 밖의 기능

- 다중 세션 생성/전환/종료/재시작, 세션당 프로세스 트리 정리
- OSC 0/2 제목, OSC 7 작업 디렉토리 반영
- 전체화면 TUI(vim/less) 감지 시 휴리스틱 자동 비활성화
- 한글 UTF-8 출력 (세션 한정 인코딩 부트스트랩, 프로필은 건드리지 않음)
- WebGL 렌더링 + 컨텍스트 손실 시 자동 폴백, DPI 변경 대응
- 대용량 붙여넣기 확인, bracketed paste

**아직 안 되는 것** — PR 상태 표시(네트워크 호출과 인증이 필요해 이번 범위에서 제외),
인앱 브라우저와 SSH(cmux에는 있지만 이 프로젝트 범위 밖).

## 구조

```
src/
  core/                Electron에 기대지 않는 알맹이
    ansi-parser.ts     증분 ANSI/OSC 파서 (청크 경계에 걸린 시퀀스 처리)
    session-state.ts   상태 판정 엔진 (P4)
    pty-manager.ts     PTY 생명주기, 프로세스 트리 정리, 출력 배칭
    store.ts           세션·배치 영속성 (P16/P17)
  main/                Electron 메인 프로세스 — PTY를 직접 소유한다
    ipc.ts             렌더러 ↔ PtyManager 중계
    tray.ts            트레이 상주 (P18)
  preload/             contextBridge 화이트리스트 API
  renderer/            React UI
    terminal-host.ts   xterm 인스턴스 수명 관리 (React 바깥)
  shared/              main ↔ renderer 계약, 정책 상수
tests/                 상태 감지 엔진 회귀 테스트
```

## 라이선스

[GPL-3.0-or-later](./LICENSE).

cvmux는 [cmux](https://github.com/manaflow-ai/cmux)(GPL-3.0-or-later)에서
파생된 저작물을 포함하므로 같은 라이선스를 따른다. 무엇을 어떤 형태로
가져왔는지는 [NOTICE.md](./NOTICE.md)에 적어 두었다.

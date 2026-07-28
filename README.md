# cvmux

> claude 좀 대충 쓰지마요 cvmux~

Windows용 터미널 워크스페이스 매니저. 여러 PowerShell 세션을 동시에 돌리고,
**왼쪽 사이드바에서 각 세션이 지금 무엇을 하고 있는지 한눈에 보는 것**이 목적이다.

[cmux](https://github.com/manaflow-ai/cmux)에서 아이디어를 가져왔다.

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

## 왜 cmux를 그냥 쓰지 않는가

cmux는 **macOS 전용**이다. Swift + AppKit으로 짜였고 터미널 렌더링을 libghostty에
의존한다. README에도 "macOS only, for now"라고 적혀 있다. Windows 빌드는 없다.

macOS를 쓴다면 cvmux 대신 cmux를 받는 편이 낫다 — 훨씬 완성도가 높다.

```bash
brew tap manaflow-ai/cmux && brew install --cask cmux
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

각 항목에는 상태 외에 작업 디렉토리, **git 브랜치**(변경사항이 있으면 점, 앞서거나
뒤처지면 `↑2 ↓1`, rebase 중이면 배지), **리슨 중인 포트**(`:5173`), 그리고 마지막 출력
줄이 함께 뜬다. 포트는 셸이 아니라 **세션이 띄운 프로세스 트리 전체**를 훑어서 찾으므로
`npm run dev`가 연 포트도 잡힌다.

## 에이전트에서 알림 보내기

cvmux는 터미널 알림 시퀀스(OSC 9 / OSC 777 / OSC 99 / BEL)를 감지한다.
AI 에이전트가 작업을 마치거나 확인을 기다릴 때 이걸 쏘면 사이드바에 파란 링이 뜬다.

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
쓴다 — 네 가지 방식을 PTY로 실측해 확인했다(`Write-Host`, `[Console]::Write`, 각각
`1>$null` 리다이렉트 상태 포함, 전부 도달).

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

## 색상

cvmux는 트루컬러(24비트)를 완전히 지원한다. 세션에는 `TERM=xterm-256color`와
`COLORTERM=truecolor`가 설정된다.

한 가지 함정이 있다. **다른 에이전트 CLI 안에서 cvmux를 실행하면** 그 CLI가 자기 자식
셸에 심어둔 `NO_COLOR=1`을 Electron이 상속하고, 그게 PTY까지 흘러 세션 안의 모든 도구가
흑백이 된다. 실제로 이 프로젝트를 만들다가 겪었다 — Node의 `getColorDepth()`가 `1`(흑백)을
반환했다.

cvmux 세션은 색을 완전히 지원하는 **새 터미널**이므로 런처의 색상 정책을 물려받지 않는다.
세션 환경에서 `NO_COLOR`를 제거한다(같은 조건에서 `colorDepth`가 `1` → `24`로 바뀌는 것을
확인했다). 정말로 색을 끄고 싶으면 `CVMUX_NO_COLOR=1`로 명시하면 된다.

셸이 [OSC 133 셸 통합](https://gitlab.freedesktop.org/Per_Bothner/specifications/blob/master/proposals/prompts-data-model.md)을
지원하면 프롬프트 정규식 대신 그 신호를 쓰므로 상태 판정이 정확해진다.

## 단축키

| 키 | 동작 |
|----|------|
| `Ctrl+Shift+N` | 새 세션 (활성 세션의 작업 디렉토리를 물려받음) |
| `Ctrl+Shift+W` | 현재 세션 닫기 |
| `Ctrl+Alt+1` ~ `8` | 세션 전환 |
| `Ctrl+Shift+B` | 사이드바 접기/펴기 |
| `Enter` (종료된 세션에서) | 같은 디렉토리에서 재시작 |

전부 `Shift`나 `Alt`가 붙어 있는 이유가 있다. `Ctrl+C`, `Ctrl+N`, `Ctrl+B`, `Ctrl+W`는
PSReadLine과 bash가 쓰는 키라 앱이 가로채면 안 된다. 터미널이 우선권을 갖는다.

## 실행

```powershell
npm install
npm run dev     # 개발 (HMR)
npm run build   # 프로덕션 빌드
npm start       # 빌드 결과 실행
npm test        # 상태 감지 엔진 회귀 테스트
npm run typecheck
```

Node 18+ 와 Windows 10 1809(빌드 17763) 이상이 필요하다. ConPTY를 쓰기 때문이다.

`node-pty`는 N-API 모듈이라 Electron용 재빌드가 필요 없다 — Electron 43 / Node 24 환경에서
그대로 로드되는 것을 확인했다. 단 npm 11부터 install 스크립트가 기본 차단되므로
설치 중 경고가 뜨면 다음을 실행한다.

```powershell
npm approve-scripts node-pty esbuild
npm rebuild node-pty
```

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

## 구현 범위

**되는 것**

- 다중 세션 생성/전환/종료/재시작, 세션당 프로세스 트리 정리
- 사이드바 상태 표시, 마지막 출력 줄 미리보기, 작업 디렉토리 표시
- **git 브랜치 · 변경 여부 · ahead/behind · rebase 등 진행 중 작업 표시**
- **리슨 포트 자동 감지** (`:5173` 형태, 세션이 띄운 프로세스 트리 전체가 대상)
- **Windows 토스트 알림** — 보고 있지 않은 세션이 알림을 보낼 때만, 클릭하면 그 세션으로 이동
- OSC 9/777/99/BEL 알림 감지, OSC 133 셸 통합, OSC 0/2 제목, OSC 7 디렉토리
- 전체화면 TUI(vim/less) 감지 시 휴리스틱 자동 비활성화
- 한글 UTF-8 출력 (세션 한정 인코딩 부트스트랩, 프로필은 건드리지 않음)
- WebGL 렌더링 + 컨텍스트 손실 시 자동 폴백, DPI 변경 대응
- 대용량 붙여넣기 확인, bracketed paste

**아직 안 되는 것 (3차)**

- 분할 창
- 세션 영속성 (앱 재시작 시 복원 — 현재는 렌더러 재로드까지만)
- PR 상태 (네트워크 호출과 인증이 필요해 이번 범위에서 제외)
- 인앱 브라우저, SSH (cmux에는 있지만 이 프로젝트 범위 밖)

## 구조

```
src/
  main/                Electron 메인 프로세스
    ansi-parser.ts     증분 ANSI/OSC 파서 (청크 경계에 걸린 시퀀스 처리)
    session-state.ts   상태 판정 엔진 (P4)
    pty-manager.ts     PTY 생명주기, 프로세스 트리 정리, IPC 배칭
    ipc.ts             IPC 배선
  preload/             contextBridge 화이트리스트 API
  renderer/            React UI
    terminal-host.ts   xterm 인스턴스 수명 관리 (React 바깥)
  shared/              main ↔ renderer 계약, 정책 상수
tests/                 상태 감지 엔진 회귀 테스트
```

## 라이선스

MIT

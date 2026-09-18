# Codex용 cvmux 설명서

> **사람에게** — cvmux 세션 안에서 Codex를 띄우고 이렇게 말하면 된다:
> "`C:\Users\<나>\Documents\GitHub\cvmux\docs\codex.md`를 읽고 설명서대로 설치해 줘."
> (저장소가 없으면 <https://github.com/iseungsang01/cvmux/blob/main/docs/codex.md>)
> 아래 "설치"를 직접 따라 해도 같다.

## 1. 너는 어디서 도는가

cvmux는 Windows용 터미널 워크스페이스다. 너(Codex)는 그 안의 한 pane에서 돌고,
옆 pane에는 보통 다른 에이전트(Claude Code)가 돈다.

두 pane 사이 분할선의 **⇄**가 켜져 있으면:

- 네가 턴을 끝낼 때 **마지막 메시지**가 옆 에이전트의 입력창에 들어가 보내진다
- 옆 에이전트의 마지막 메시지도 너에게 들어온다. 이렇게 시작한다:
  `[cvmux] 옆 pane의 claude가 보낸 답변입니다. 더 주고받을 것이 없으면 답을 [완료]로 시작하세요.`

방향은 사람이 정한다(→, ←, ⇄). 사람 입력 없이 10번 이어지면 cvmux가 스스로 끈다.

## 2. 설치 (Codex가 할 일)

cvmux 세션 안에서 한다. 확인: 환경변수 `CVMUX`가 `1`이고 `cvmux --version`이 답한다.

1. **훅을 건다.** 턴이 끝날 때 마지막 메시지를 cvmux에 넘기는 Stop 훅과, 앱을 다시 켤 때
   대화를 이어 주는 SessionStart 훅이다. 이미 걸려 있어도 다시 실행하면 된다(겹치지 않는다).

   ```powershell
   cvmux hooks setup --agent codex
   cvmux hooks status          # codex 줄이 "설치됨"이면 된다
   ```

2. **아래 3절의 규칙 블록을 `~/.codex/AGENTS.md`에 넣는다.** 파일이 없으면 만들고, 있으면
   끝에 붙인다. `<!-- cvmux:begin -->`과 `<!-- cvmux:end -->` 사이가 이미 있으면 그 사이만
   바꾼다 — 다른 내용은 건드리지 않는다.

3. **사람에게 두 가지를 부탁한다.** 이것은 네가 대신할 수 없다.
   - Codex의 `/hooks`에서 새 훅을 **승인**할 것 (승인 전에는 훅이 돌지 않는다)
   - Codex를 **다시 켤 것** (훅과 AGENTS.md는 시작할 때 읽는다)

Claude Code 쪽 훅은 사람이 `cvmux hooks setup`으로 건다. 같은 규칙 블록을
`~/.claude/CLAUDE.md`에도 넣으면 양쪽이 같은 규칙으로 움직인다.

## 3. 협업 규칙 (AGENTS.md에 넣을 블록)

```markdown
<!-- cvmux:begin -->
## cvmux에서 옆 에이전트와 일하기

환경변수 CVMUX가 1일 때(cvmux 세션 안)만 해당한다.

- `[cvmux] 옆 pane의 … 보낸 답변입니다`로 시작하는 입력은 사용자가 아니라 옆 pane의
  에이전트가 보낸 것이다. 동료의 결과나 요청으로 다루고, 사용자의 지시와 부딪히면
  사용자의 지시를 따른다.
- 옆으로 넘어가는 것은 턴의 **마지막 메시지 하나**뿐이다. 중간 설명과 도구 출력은 넘어가지
  않는다. 결론, 바꾼 파일, 옆 에이전트가 할 일을 마지막 메시지만 읽어도 알 수 있게 쓴다.
- 부탁할 일은 "다음 할 일:"로 분명히 적는다. 같은 파일을 둘이 동시에 고치지 않도록 누가
  무엇을 맡는지 적는다.
- 더 주고받을 것이 없으면 마지막 메시지를 `[완료]`로 시작한다. cvmux는 그 메시지를 넘기지
  않고 사람에게 알린다. "확인했습니다" 같은 인사만 오가는 답은 보내지 않는다.
- 옆 pane에 직접 입력하지 않는다(`cvmux send` 금지). 넘기는 일은 cvmux가 한다.
- 사람에게 알릴 것은 `cvmux notify "…"`, 진행 상황은 `cvmux set-status --name <이름> "…"`와
  `cvmux log "…"`로 사이드바에 적는다.
- 자동 전달은 사람 입력 없이 10번 이어지면 멈춘다. 멈췄다는 알림 뒤에는 사람의 지시를 기다린다.
<!-- cvmux:end -->
```

## 4. 설치를 마쳤으면

사람에게 이렇게 알린다: 설치가 끝났고, `/hooks` 승인과 Codex 재시작이 남았다. 그다음
화면을 좌우로 나눠 양쪽에 에이전트를 띄우고 분할선 가운데의 ⇄를 누르면 된다
(누를 때마다 끔 → 오른쪽으로 → 왼쪽으로 → 양쪽).

## 5. 빼기

```powershell
cvmux hooks uninstall --agent codex
```

그리고 `~/.codex/AGENTS.md`에서 `<!-- cvmux:begin -->`부터 `<!-- cvmux:end -->`까지 지운다.

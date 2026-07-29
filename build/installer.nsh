; cvmux 설치 프로그램 사용자 정의 (POLICY.md P20-15)
;
; 세션을 들고 있는 데몬은 설치 폴더의 cvmux.exe를 ELECTRON_RUN_AS_NODE로 다시
; 부른 프로세스다. 그래서 데몬이 살아 있는 동안에는 Windows가 그 실행 파일을
; 잠그고, 새 버전이 덮어써지지 않는다 — 설치는 성공한 것처럼 보이는데 앱은
; 그대로인 상황이 여기서 나온다.
;
; electron-builder의 기본 절차는 설치 폴더에서 도는 프로세스를 그냥 죽인다.
; 그러면 파일 잠금은 풀리지만 데몬이 자기 몫을 못 한다 — 셸과 그 자식들이
; 고아로 남고, 마지막 작업 디렉토리와 화면도 저장되지 않는다.
;
; 그래서 죽이기 전에 스스로 물러날 기회를 준다. `--quit-daemon`은 떠 있는 창을
; 내보내고, 데몬에게 세션 정리와 저장을 맡긴 뒤, 다 끝나면 종료한다. 그래도
; 남아 있는 것이 있으면 기본 절차가 이어받는다.

; customCheckAppRunning을 정의하면 electron-builder가 기본 검사에 필요한
; 선언들을 넣지 않는다. 그 절차를 뒤에서 그대로 다시 쓰므로 여기서 갖춘다.
!include "getProcessInfo.nsh"
Var pid

!macro customCheckAppRunning
  ${if} ${FileExists} "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
    DetailPrint "실행 중인 cvmux 세션을 정리하는 중…"
    ;
    ; 여기서 부르는 것은 **지금 깔려 있는** cvmux다. 그 빌드가 `--quit-daemon`을
    ; 모르면 평범한 실행으로 알아듣고 창을 띄운 채 눌러앉아, ExecWait이 사용자가
    ; 그 창을 닫을 때까지 멈춘다 — 설치 프로그램이 통째로 멎는다.
    ;
    ; `--daemon-only`를 함께 넘겨 그 길을 막는다. 이 인자를 아는 빌드는 창도
    ; 트레이도 만들지 않고 곧바로 물러나므로, 어느 버전을 만나도 ExecWait이
    ; 매달리지 않는다. 새 빌드는 `--quit-daemon`을 먼저 보므로 영향이 없다.
    ;
    ExecWait '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --quit-daemon --daemon-only' $0
  ${endIf}

  ; 응답하지 않는 프로세스가 남아 있을 수 있다 — 확인과 강제 종료는 기본 절차에 맡긴다
  !insertmacro IS_POWERSHELL_AVAILABLE
  !insertmacro _CHECK_APP_RUNNING
!macroend

@echo off
rem cvmux CLI (P20-1)
rem
rem 설치본에서는 앱 옆에 놓이고, 개발 중에는 저장소의 bin/ 에서 돈다.
rem 두 자리 모두 이 파일 하나가 처리한다 - 어느 쪽에서 부르든 같은 CLI가
rem 떠야 하기 때문이다.
rem
rem 설치본에는 Node가 없을 수 있으므로 Electron을 Node로 돌린다.
setlocal
if exist "%~dp0resources\cli\cvmux.mjs" (
  set ELECTRON_RUN_AS_NODE=1
  "%~dp0cvmux.exe" "%~dp0resources\cli\cvmux.mjs" %*
) else (
  node "%~dp0..\out\cli\cvmux.mjs" %*
)
endlocal

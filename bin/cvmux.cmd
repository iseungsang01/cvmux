@echo off
rem cvmux CLI shim for cmd and PowerShell (POLICY.md P20-1).
rem
rem Lives in <install>\bin next to the Git Bash shim "cvmux", and only this
rem folder goes on the session PATH. It must not sit next to cvmux.exe:
rem PATHEXT lists .EXE before .CMD, so "cvmux" would start the app instead.
rem
rem Comments stay ASCII - cmd.exe reads this file in the console code page
rem and misparses UTF-8 lines.
rem
rem Installed builds may have no Node, so Electron runs the CLI as Node.
setlocal
if exist "%~dp0..\resources\cli\cvmux.mjs" (
  set ELECTRON_RUN_AS_NODE=1
  "%~dp0..\cvmux.exe" "%~dp0..\resources\cli\cvmux.mjs" %*
) else (
  node "%~dp0..\out\cli\cvmux.mjs" %*
)
endlocal

<#
.SYNOPSIS
  cvmux 사이드바에 알림을 띄운다.

.DESCRIPTION
  터미널 알림 시퀀스(OSC 777)를 콘솔에 직접 쓴다. cvmux는 이걸 받아 해당 세션에
  파란 링과 미읽음 배지를 붙이고, 창이 뒤에 있으면 Windows 토스트도 띄운다.

  Write-Host를 쓰는 이유: stdout이 리다이렉트되거나 캡처되는 상황(에이전트 훅,
  파이프라인)에서도 콘솔로 직접 나간다. 실측으로 확인했다.

.PARAMETER Message
  알림 본문.

.PARAMETER Title
  알림 제목. 기본값은 실행 중인 세션 이름.

.EXAMPLE
  .\cvmux-notify.ps1 "claude 좀 대충 쓰지마요 cvmux~"

.EXAMPLE
  .\cvmux-notify.ps1 -Title "빌드" "테스트 12개 통과"
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory, Position = 0, ValueFromRemainingArguments)]
  [string[]]$Message,

  [string]$Title = 'cvmux'
)

$text = ($Message -join ' ')
$esc = [char]27
$bel = [char]7

# 제목/본문에 세미콜론이 있으면 OSC 필드 구분자와 충돌한다
$safeTitle = $Title -replace ';', ','
$safeText = $text -replace ';', ','

Write-Host -NoNewline "$esc]777;notify;$safeTitle;$safeText$bel"

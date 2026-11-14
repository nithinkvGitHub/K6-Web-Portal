$ErrorActionPreference = "Stop"

$NodeExe = $null
$NodeCmd = Get-Command node -ErrorAction SilentlyContinue
if ($NodeCmd) {
  $NodeExe = $NodeCmd.Source
} else {
  $CandidatePaths = @(
    "$env:ProgramFiles\nodejs\node.exe",
    "$env:LOCALAPPDATA\Programs\nodejs\node.exe",
    "$env:LOCALAPPDATA\Programs\cursor\resources\app\resources\helpers\node.exe"
  )
  foreach ($Candidate in $CandidatePaths) {
    if ($Candidate -and (Test-Path $Candidate)) {
      $NodeExe = $Candidate
      break
    }
  }
}

if (-not $NodeExe) {
  Write-Error "Node.js binary not found on PATH or standard install locations. Please install Node.js v18+."
}

Set-Location $PSScriptRoot
Write-Host "Starting AIPerf Cloud Orchestrator using Node: $NodeExe" -ForegroundColor Cyan
& $NodeExe "server/index.mjs"

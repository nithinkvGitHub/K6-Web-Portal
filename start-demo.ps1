$ErrorActionPreference = "Stop"
$NodeExe = "node"
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  $FallbackNode = "C:\Users\nithi\AppData\Local\Programs\cursor\resources\app\resources\helpers\node.exe"
  if (Test-Path $FallbackNode) {
    $NodeExe = $FallbackNode
  } else {
    Write-Error "Node.js not found on PATH."
  }
}

Set-Location $PSScriptRoot
& $NodeExe "server/index.mjs"

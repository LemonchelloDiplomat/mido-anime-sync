$ErrorActionPreference = "SilentlyContinue"
$Root = Split-Path -Parent $PSScriptRoot
$DataDir = Join-Path $Root ".local-data"
$PidFile = Join-Path $DataDir "windows-launcher.json"

if (-not (Test-Path $PidFile)) { exit 0 }

try {
  $saved = Get-Content $PidFile -Raw | ConvertFrom-Json
  $processId = [int]$saved.pid
  if (Get-Process -Id $processId -ErrorAction SilentlyContinue) {
    & taskkill.exe /T /F /PID $processId 2>$null | Out-Null
  }
} finally {
  Remove-Item $PidFile -Force
}

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "windows-node.ps1")
$Root = Split-Path -Parent $PSScriptRoot
$DataDir = Join-Path $Root ".local-data"
$PidFile = Join-Path $DataDir "windows-launcher.json"
$StdoutLog = Join-Path $DataDir "launcher.stdout.log"
$StderrLog = Join-Path $DataDir "launcher.stderr.log"
$Url = "http://127.0.0.1:5173/"

function Show-Message([string]$Message, [string]$Title = "mido-anime-sync") {
  try {
    $shell = New-Object -ComObject WScript.Shell
    [void]$shell.Popup($Message, 0, $Title, 0x10)
  } catch {}
}

function Test-Port([int]$Port) {
  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $result = $client.BeginConnect("127.0.0.1", $Port, $null, $null)
    $connected = $result.AsyncWaitHandle.WaitOne(350)
    if ($connected -and $client.Connected) { return $true }
    return $false
  } catch {
    return $false
  } finally {
    $client.Close()
  }
}

try {
  New-Item -ItemType Directory -Force -Path $DataDir | Out-Null

  if (Test-Path $PidFile) {
    try {
      $saved = Get-Content $PidFile -Raw | ConvertFrom-Json
      $existing = Get-Process -Id ([int]$saved.pid) -ErrorAction SilentlyContinue
      if ($existing) {
        Start-Process $Url
        exit 0
      }
    } catch {}
    Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
  }

  $nodePath = Initialize-MidoNodeEnvironment
  $nodeMajor = Get-MidoNodeMajorVersion $nodePath
  if ($nodeMajor -lt 22) { throw "Для запуска требуется Node.js 22 или новее. Сейчас установлена версия $nodeMajor." }
  if (-not (Test-Path (Join-Path $Root "node_modules\vite\bin\vite.js"))) {
    throw "Зависимости не установлены. Один раз запусти Setup-Windows.bat."
  }
  if (Test-Port 5173) { throw "Порт 5173 уже занят. Закрой другой экземпляр приложения или проверь, какая программа использует этот порт." }

  $process = Start-Process -FilePath $nodePath -ArgumentList "scripts/dev.mjs" -WorkingDirectory $Root -WindowStyle Hidden -RedirectStandardOutput $StdoutLog -RedirectStandardError $StderrLog -PassThru

  $ready = $false
  for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Milliseconds 500
    if ($process.HasExited) {
      $details = ""
      if (Test-Path $StderrLog) { $details = (Get-Content $StderrLog -Tail 12 -ErrorAction SilentlyContinue) -join " | " }
      throw "Локальный сервер завершился при запуске. $details"
    }
    try {
      $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 2
      $apiHealth = Invoke-RestMethod -Uri "http://127.0.0.1:3001/api/health" -TimeoutSec 2
      $apiReady = ($apiHealth.ok -eq $true -and $apiHealth.mode -eq "local")
      if ($response.StatusCode -eq 200 -and $apiReady) { $ready = $true; break }
    } catch {}
  }
  if (-not $ready) {
    & taskkill.exe /T /F /PID $process.Id 2>$null | Out-Null
    throw "Приложение не ответило за 30 секунд. Проверь .local-data\launcher.stderr.log."
  }

  @{ pid = $process.Id; startedAt = (Get-Date).ToString("o"); url = $Url } | ConvertTo-Json | Set-Content -Path $PidFile -Encoding UTF8
  Start-Process $Url
} catch {
  Show-Message ($_.Exception.Message + [Environment]::NewLine + "Подробности: .local-data\launcher.stderr.log") "Не удалось запустить mido-anime-sync"
  exit 1
}

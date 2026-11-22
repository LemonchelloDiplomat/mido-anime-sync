$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

function Show-Message([string]$Message, [string]$Title = "mido-anime-sync") {
  try {
    $shell = New-Object -ComObject WScript.Shell
    [void]$shell.Popup($Message, 0, $Title, 0x10)
  } catch {
    Write-Host $Message
  }
}

try {
  $nodeCommand = Get-Command node -ErrorAction SilentlyContinue
  if (-not $nodeCommand) { throw "Node.js 22 или новее не найден. Установи Node.js LTS и повтори настройку." }
  $nodeMajor = [int]((& node -p "Number(process.versions.node.split('.')[0])").Trim())
  if ($nodeMajor -lt 22) { throw "Нужен Node.js 22 или новее. Сейчас установлен Node.js $nodeMajor." }

  Write-Host "Установка зависимостей mido-anime-sync..."
  & npm install
  if ($LASTEXITCODE -ne 0) { throw "npm install завершился с ошибкой. Проверь подключение к интернету и повтори Setup." }

  $envFile = Join-Path $Root ".env.local"
  if (-not (Test-Path $envFile)) {
    Copy-Item (Join-Path $Root ".env.example") $envFile
    Write-Host "Создан .env.local. OAuth-ключи можно настроить позднее."
  }

  $desktop = [Environment]::GetFolderPath("Desktop")
  $wscript = Join-Path $env:WINDIR "System32\wscript.exe"
  $shell = New-Object -ComObject WScript.Shell

  $startShortcut = $shell.CreateShortcut((Join-Path $desktop "mido-anime-sync.lnk"))
  $startShortcut.TargetPath = $wscript
  $startShortcut.Arguments = '"' + (Join-Path $Root "Start-MidoAnimeSync.vbs") + '"'
  $startShortcut.WorkingDirectory = $Root
  $startShortcut.Description = "Запустить локальное приложение mido-anime-sync"
  $startShortcut.Save()

  $stopShortcut = $shell.CreateShortcut((Join-Path $desktop "Остановить mido-anime-sync.lnk"))
  $stopShortcut.TargetPath = $wscript
  $stopShortcut.Arguments = '"' + (Join-Path $Root "Stop-MidoAnimeSync.vbs") + '"'
  $stopShortcut.WorkingDirectory = $Root
  $stopShortcut.Description = "Остановить локальные серверы mido-anime-sync"
  $stopShortcut.Save()

  Write-Host ""
  Write-Host "Готово. Ярлыки запуска и остановки созданы на рабочем столе."
  Write-Host "Для запуска больше не нужно открывать PowerShell или терминал."
  Show-Message "Настройка завершена. Ярлык mido-anime-sync появился на рабочем столе." "mido-anime-sync"
} catch {
  Show-Message $_.Exception.Message "Не удалось настроить mido-anime-sync"
  Write-Error $_
  exit 1
}

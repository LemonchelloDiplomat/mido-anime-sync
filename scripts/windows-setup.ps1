$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "windows-node.ps1")
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

function Show-Message([string]$Message, [string]$Title = "mido-anime-sync", [int]$Icon = 0x10) {
  try {
    $shell = New-Object -ComObject WScript.Shell
    [void]$shell.Popup($Message, 0, $Title, $Icon)
  } catch {
    Write-Host $Message
  }
}

function New-MidoShortcutIcon([string]$SourcePath, [string]$DestinationPath, [bool]$ShowStopBadge = $false) {
  $canvas = [System.Drawing.Bitmap]::new(128, 128, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $graphics = [System.Drawing.Graphics]::FromImage($canvas)
  $backgroundPath = New-Object System.Drawing.Drawing2D.GraphicsPath
  $backgroundBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 27, 29, 48))
  $borderPen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(255, 238, 151, 190), 3)
  $sourceImage = [System.Drawing.Image]::FromFile($SourcePath)

  try {
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $graphics.Clear([System.Drawing.Color]::Transparent)
    $backgroundPath.AddArc(3, 3, 26, 26, 180, 90)
    $backgroundPath.AddArc(99, 3, 26, 26, 270, 90)
    $backgroundPath.AddArc(99, 99, 26, 26, 0, 90)
    $backgroundPath.AddArc(3, 99, 26, 26, 90, 90)
    $backgroundPath.CloseFigure()
    $graphics.FillPath($backgroundBrush, $backgroundPath)
    $graphics.DrawPath($borderPen, $backgroundPath)
    $logoBounds = [System.Drawing.Rectangle]::new(15, 15, 98, 98)
    $graphics.DrawImage($sourceImage, $logoBounds)

    if ($ShowStopBadge) {
      $badgeBounds = [System.Drawing.Rectangle]::new(86, 86, 36, 36)
      $badgeBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 214, 62, 83))
      $badgeBorder = New-Object System.Drawing.Pen([System.Drawing.Color]::White, 3)
      $stopBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
      try {
        $graphics.FillEllipse($badgeBrush, $badgeBounds)
        $graphics.DrawEllipse($badgeBorder, $badgeBounds)
        $stopSquare = [System.Drawing.Rectangle]::new(97, 97, 14, 14)
        $graphics.FillRectangle($stopBrush, $stopSquare)
      } finally {
        $badgeBrush.Dispose()
        $badgeBorder.Dispose()
        $stopBrush.Dispose()
      }
    }

    $iconHandle = $canvas.GetHicon()
    try {
      $icon = [System.Drawing.Icon]::FromHandle($iconHandle)
      $iconStream = [System.IO.File]::Create($DestinationPath)
      try {
        $icon.Save($iconStream)
      } finally {
        $iconStream.Dispose()
        $icon.Dispose()
      }
    } finally {
      [void][MidoShortcutIconNativeMethods]::DestroyIcon($iconHandle)
    }
  } finally {
    $sourceImage.Dispose()
    $borderPen.Dispose()
    $backgroundBrush.Dispose()
    $backgroundPath.Dispose()
    $graphics.Dispose()
    $canvas.Dispose()
  }
}

try {
  $nodePath = Initialize-MidoNodeEnvironment
  $nodeMajor = Get-MidoNodeMajorVersion $nodePath
  if ($nodeMajor -lt 22) { throw "Нужен Node.js 22 или новее. Сейчас установлен Node.js $nodeMajor." }

  $npmPath = Join-Path (Split-Path -Parent $nodePath) "npm.cmd"
  if (-not (Test-Path -LiteralPath $npmPath -PathType Leaf)) {
    $npmCommand = Get-Command npm.cmd -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($npmCommand) { $npmPath = $npmCommand.Source }
  }
  if (-not (Test-Path -LiteralPath $npmPath -PathType Leaf)) {
    throw "npm.cmd не найден рядом с Node.js. Переустанови Node.js с включённым npm."
  }

  Write-Host "Установка зависимостей mido-anime-sync..."
  & $npmPath install
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

  # Build desktop icons from the extension logo on a dark, high-contrast background.
  $logoPath = Join-Path $Root "browser-extension\icons\icon128.png"
  if (Test-Path -LiteralPath $logoPath -PathType Leaf) {
    Add-Type -AssemblyName System.Drawing
    if (-not ("MidoShortcutIconNativeMethods" -as [type])) {
      Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class MidoShortcutIconNativeMethods { [DllImport("user32.dll", SetLastError = true)] public static extern bool DestroyIcon(IntPtr handle); }'
    }

    $iconDirectory = Join-Path $Root ".local-data"
    New-Item -ItemType Directory -Force -Path $iconDirectory | Out-Null
    $startIconPath = Join-Path $iconDirectory "mido-anime-sync-shortcut-v2.ico"
    $stopIconPath = Join-Path $iconDirectory "mido-anime-sync-stop-shortcut-v2.ico"
    New-MidoShortcutIcon $logoPath $startIconPath $false
    New-MidoShortcutIcon $logoPath $stopIconPath $true
    $startShortcut.IconLocation = "$startIconPath,0"
    $stopShortcutIconLocation = "$stopIconPath,0"
  } else {
    Write-Warning "Логотип расширения не найден. Ярлыки будут созданы со стандартными значками."
  }

  $startShortcut.Save()

  $stopShortcut = $shell.CreateShortcut((Join-Path $desktop "Остановить mido-anime-sync.lnk"))
  $stopShortcut.TargetPath = $wscript
  $stopShortcut.Arguments = '"' + (Join-Path $Root "Stop-MidoAnimeSync.vbs") + '"'
  $stopShortcut.WorkingDirectory = $Root
  $stopShortcut.Description = "Остановить локальные серверы mido-anime-sync"
  if ($stopShortcutIconLocation) { $stopShortcut.IconLocation = $stopShortcutIconLocation }
  $stopShortcut.Save()

  Write-Host ""
  Write-Host "Готово. Ярлыки запуска и остановки созданы на рабочем столе."
  Write-Host "Для запуска больше не нужно открывать PowerShell или терминал."
  Show-Message "Настройка завершена. Ярлыки запуска и остановки появились на рабочем столе." "mido-anime-sync" 0x40
} catch {
  Show-Message $_.Exception.Message "Не удалось настроить mido-anime-sync"
  Write-Error $_
  exit 1
}

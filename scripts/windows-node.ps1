function Initialize-MidoNodeEnvironment {
  $nodeCommand = Get-Command node -ErrorAction SilentlyContinue
  if ($nodeCommand) { return $nodeCommand.Source }

  $fnmCommand = Get-Command fnm -ErrorAction SilentlyContinue
  if (-not $fnmCommand) {
    $wingetFnm = Join-Path $env:LOCALAPPDATA "Microsoft\WinGet\Links\fnm.exe"
    if (Test-Path $wingetFnm) { $fnmPath = $wingetFnm }
  } else {
    $fnmPath = $fnmCommand.Source
  }

  if (-not $fnmPath) {
    throw "Node.js 22+ не найден. Не удалось обнаружить FNM или Node.js в PATH."
  }

  $environmentLines = & $fnmPath env --shell powershell 2>$null
  if ($LASTEXITCODE -ne 0) {
    throw "Не удалось получить окружение Node.js от FNM. Проверь установку FNM."
  }

  foreach ($line in $environmentLines) {
    if ($line -match '^\s*\$env:([A-Za-z_][A-Za-z0-9_]*)\s*=\s*"((?:[^"\\]|\\.)*)"\s*$') {
      $name = $matches[1]
      $value = $matches[2] -replace '\\(["\\])', '$1'
      [Environment]::SetEnvironmentVariable($name, $value, "Process")
    }
  }

  $nodeCommand = Get-Command node -ErrorAction SilentlyContinue
  if (-not $nodeCommand) {
    throw "FNM найден, но не удалось активировать Node.js. Проверь fnm default и установленную версию Node.js."
  }

  return $nodeCommand.Source
}

function Get-MidoNodeMajorVersion([string]$NodePath) {
  $versionOutput = & $NodePath -p "Number(process.versions.node.split('.')[0])"
  if ($LASTEXITCODE -ne 0) { throw "Не удалось определить версию Node.js." }
  return [int]$versionOutput.Trim()
}

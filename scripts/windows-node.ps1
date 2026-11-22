function Initialize-MidoNodeEnvironment {
  $nodeCommand = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($nodeCommand) {
    return $nodeCommand.Source
  }

  $candidates = @(
    (Join-Path $env:ProgramFiles "nodejs\node.exe"),
    (Join-Path ${env:ProgramFiles(x86)} "nodejs\node.exe")
  )

  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Leaf)) {
      return $candidate
    }
  }

  throw "Node.js 22+ не найден. Установи Node.js с https://nodejs.org/ и перезапусти Setup-Windows.bat."
}

function Get-MidoNodeMajorVersion([string]$NodePath) {
  $versionOutput = & $NodePath -p "Number(process.versions.node.split('.')[0])"
  if ($LASTEXITCODE -ne 0) { throw "Не удалось определить версию Node.js." }
  return [int]$versionOutput.Trim()
}

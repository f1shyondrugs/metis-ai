# Metis AI Windows one-line installer bootstrap.
# This file is designed to be invoked with:
#   irm https://raw.githubusercontent.com/f1shyondrugs/metis-ai/master/install.ps1 | iex
# It MUST NOT start with param() — that statement is illegal under Invoke-Expression.
# The real installer is downloaded to a temp file and invoked with -File so named
# parameters and prompts work like a normal script.
#
# Uninstall:
#   powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1 uninstall -Yes -KeepData

$ErrorActionPreference = "Stop"
$base = if ($env:METIS_AI_INSTALL_BASE) { $env:METIS_AI_INSTALL_BASE.TrimEnd("/") } else { "https://raw.githubusercontent.com/f1shyondrugs/metis-ai/master" }
$forward = @()
if ($args -and $args.Count -gt 0) { $forward = @($args) }
elseif ($MyInvocation.UnboundArguments -and $MyInvocation.UnboundArguments.Count -gt 0) {
  $forward = @($MyInvocation.UnboundArguments)
}
$isUninstall = $forward.Count -gt 0 -and ([string]$forward[0]).ToLowerInvariant() -eq "uninstall"
if ($isUninstall) {
  $rest = @()
  if ($forward.Count -gt 1) { $rest = @($forward[1..($forward.Count - 1)]) }
  $mapped = @("uninstall")
  for ($i = 0; $i -lt $rest.Count; $i++) {
    switch -Regex ($rest[$i]) {
      "^--yes$" { $mapped += "-Yes" }
      "^--keep-data$" { $mapped += "-KeepData" }
      "^--remove-data$" { $mapped += "-RemoveData" }
      "^--dry-run$" { $mapped += "-DryRun" }
      "^--install-dir$" {
        $mapped += "-InstallDir"
        if ($i + 1 -lt $rest.Count) { $i++; $mapped += $rest[$i] }
      }
      "^--service-name$" {
        $mapped += "-ServiceName"
        if ($i + 1 -lt $rest.Count) { $i++; $mapped += $rest[$i] }
      }
      default { $mapped += $rest[$i] }
    }
  }
  $forward = $mapped
}
$rel = "/install/windows.ps1"
$dest = Join-Path ([System.IO.Path]::GetTempPath()) ("metis-ai-windows-" + [guid]::NewGuid().ToString() + ".ps1")
Invoke-WebRequest -UseBasicParsing -Uri ($base + $rel) -OutFile $dest
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $dest @forward
exit $LASTEXITCODE

param(
  [string]$InstallDir = "",
  [string]$ServiceName = "MetisAI",
  [switch]$KeepData,
  [switch]$RemoveData,
  [switch]$DryRun,
  [switch]$Yes
)
$ErrorActionPreference = "Stop"
if (-not $InstallDir) {
  $runKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
  foreach ($candidate in @($ServiceName, "MetisAI", "metis-ai")) {
    try {
      $existingRun = (Get-ItemProperty -LiteralPath $runKey -Name "$candidate-app" -ErrorAction Stop)."$candidate-app"
      if ($existingRun) {
        $cmdPath = [string]$existingRun.Trim().Trim('"')
        if (Test-Path -LiteralPath $cmdPath) {
          $InstallDir = Split-Path -Parent $cmdPath
          $ServiceName = $candidate
          break
        }
      }
    } catch {}
  }
}
if (-not $InstallDir) { throw "Could not detect the install directory from startup entries. Pass -InstallDir DIR." }
$manifestPath = Join-Path $InstallDir ".metis-ai-install.json"
$manifest = $null
if (Test-Path $manifestPath) {
  $manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
} else {
  $manifest = [pscustomobject]@{ serviceName = $ServiceName; dataDir = ""; installMethod = "native" }
}
if ([IO.Path]::GetFullPath($InstallDir).TrimEnd("\") -eq [IO.Path]::GetPathRoot([IO.Path]::GetFullPath($InstallDir)).TrimEnd("\")) {
  throw "Refusing to remove a filesystem root."
}
if (-not $Yes) {
  $answer = Read-Host "Remove Metis AI installation at $InstallDir? Type 'yes'"
  if ($answer -cne "yes") { Write-Host "Aborted."; exit 0 }
}
function Invoke-Step([scriptblock]$Action, [string]$Description) {
  if ($DryRun) { Write-Host "+ $Description" } else { & $Action }
}
$runKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
$rootNorm = [IO.Path]::GetFullPath($InstallDir).TrimEnd("\")
if ($manifest.installMethod -eq "docker") {
  Invoke-Step { Push-Location $InstallDir; docker compose down; Pop-Location } "docker compose down"
} else {
foreach ($suffix in @("app", "worker", "mcp")) {
  $task = "$($manifest.serviceName)-$suffix"
  Invoke-Step { Remove-ItemProperty -LiteralPath $runKey -Name $task -ErrorAction SilentlyContinue } "Remove startup entry $task"
  Invoke-Step { cmd.exe /c "schtasks /Delete /TN `"$task`" /F >nul 2>&1" } "Delete scheduled task $task"
}
Invoke-Step {
  Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -eq "node.exe" -and $_.CommandLine -and $_.CommandLine.IndexOf($rootNorm, [StringComparison]::OrdinalIgnoreCase) -ge 0 } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
} "Stop running Metis node processes"
}
function Remove-Tree([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return }
  $target = $Path
  if ($target -notlike "\\?\*") { $target = "\\?\$Path" }
  for ($i = 0; $i -lt 8; $i++) {
    cmd.exe /c "rmdir /s /q `"$target`"" | Out-Null
    if (-not (Test-Path -LiteralPath $Path)) { return }
    Start-Sleep -Seconds 2
  }
  throw "Failed to remove $Path"
}
$shouldKeepData = $KeepData -and -not $RemoveData
if (-not $shouldKeepData -and $manifest.dataDir -and ([IO.Path]::GetFullPath($manifest.dataDir) -ne [IO.Path]::GetFullPath($InstallDir))) {
  Invoke-Step { Remove-Tree ([IO.Path]::GetFullPath($manifest.dataDir)) } "Remove data directory"
}
Invoke-Step { Start-Sleep -Seconds 1; Remove-Tree $rootNorm } "Remove installation directory"
Write-Host "Metis AI uninstalled. Data kept: $shouldKeepData"

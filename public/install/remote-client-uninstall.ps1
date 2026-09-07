param(
  [string]$InstallDir = (Split-Path -Parent $MyInvocation.MyCommand.Path)
)
$ErrorActionPreference = "Stop"
& schtasks.exe /Delete /TN "Metis AI Remote Client" /F 2>$null | Out-Null
$runKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
Remove-ItemProperty -Path $runKey -Name "Metis AI Remote Client" -ErrorAction SilentlyContinue
$resolvedDir = (Resolve-Path $InstallDir).Path
Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -in @("node.exe", "powershell.exe") } |
  Where-Object { $_.CommandLine -like "*$resolvedDir*" } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
$escapedDir = $resolvedDir.Replace("'", "''")
$cleanup = "Start-Sleep -Seconds 1; Remove-Item -LiteralPath '$escapedDir' -Recurse -Force -ErrorAction SilentlyContinue"
Start-Process powershell.exe -WindowStyle Hidden -ArgumentList "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", $cleanup
Write-Output "Remote client removal started."


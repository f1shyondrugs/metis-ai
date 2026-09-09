param(
  [Parameter(Mandatory=$true)][string]$Server,
  [Parameter(Mandatory=$true)][string]$EnrollmentToken,
  [ValidateSet('user','admin')][string]$PermissionMode = 'user',
  [string]$InstallDir = "$env:LOCALAPPDATA\MetisAI\RemoteClient"
)
$ErrorActionPreference = 'Stop'

function Refresh-ProcessPath {
  $machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  $env:Path = "$machinePath;$userPath"
}

$nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $nodeCommand -or [int]((& node.exe -p 'parseInt(process.versions.node, 10)') -as [int]) -lt 20) {
  $winget = Get-Command winget.exe -ErrorAction SilentlyContinue
  if (-not $winget) {
    throw 'Node.js 20 or newer is required. Install it from https://nodejs.org/ and run this installer again.'
  }
  Write-Host 'Installing Node.js 22 LTS with winget...'
  & $winget.Source install --id OpenJS.NodeJS.LTS --exact --silent --accept-package-agreements --accept-source-agreements
  if ($LASTEXITCODE -ne 0) { throw "Node.js installation failed with exit code $LASTEXITCODE" }
  Refresh-ProcessPath
  $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
  if (-not $nodeCommand) { throw 'Node.js was installed but is not available in this session. Restart PowerShell and run the installer again.' }
}

if ($PermissionMode -eq 'admin' -and (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator))) {
  Write-Host 'Administrator mode requires a UAC-confirmed installation.'
  $args = "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" -Server `"$Server`" -EnrollmentToken `"$EnrollmentToken`" -PermissionMode admin -InstallDir `"$InstallDir`""
  Start-Process powershell.exe -Verb RunAs -ArgumentList $args -Wait
  exit $LASTEXITCODE
}
if ($PermissionMode -eq 'admin') { $InstallDir = "$env:ProgramFiles\MetisAI\RemoteClient" }
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
$payload = @{ token=$EnrollmentToken; name=$env:COMPUTERNAME; os='windows'; architecture=$env:PROCESSOR_ARCHITECTURE; version='1.0.0'; hostname=$env:COMPUTERNAME; permissionMode=$PermissionMode; capabilities=if ($PermissionMode -eq 'admin') { @('user_files','user_processes','user_directories','system_files','services','disks','admin_processes') } else { @('user_files','user_processes','user_directories') } } | ConvertTo-Json -Compress
$result = Invoke-RestMethod -Uri "$($Server.TrimEnd('/'))/api/remote-clients/enroll" -Method Post -ContentType 'application/json' -Body $payload
$config = @{ server=$Server.TrimEnd('/'); permissionMode=$PermissionMode; clientId=$result.client.id; credential=$result.credential } | ConvertTo-Json
$configPath = Join-Path $InstallDir 'config.json'; Set-Content $configPath $config -Encoding utf8
Invoke-WebRequest "$($Server.TrimEnd('/'))/install/remote-client.mjs" -OutFile (Join-Path $InstallDir 'client.mjs')
Invoke-WebRequest "$($Server.TrimEnd('/'))/install/remote-client-uninstall.ps1" -OutFile (Join-Path $InstallDir 'uninstall.ps1')

Push-Location $InstallDir
try {
  if (-not (Test-Path (Join-Path $InstallDir 'package.json'))) { & npm.cmd init -y | Out-Null }
  & npm.cmd install --omit=dev --no-audit --no-fund ws | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Installing the WebSocket dependency failed with exit code $LASTEXITCODE" }
} finally {
  Pop-Location
}

$runCommand = "@echo off`r`nnode `"%~dp0client.mjs`" --config `"%~dp0config.json`""
Set-Content (Join-Path $InstallDir 'run-client.cmd') $runCommand -Encoding ascii
$taskName = 'Metis AI Remote Client'
$logPath = Join-Path $InstallDir 'client.log'
Remove-Item $logPath -Force -ErrorAction SilentlyContinue
$nodePath = (Get-Command node.exe).Source
$taskCommand = "`"$nodePath`" `"$(Join-Path $InstallDir 'client.mjs')`" --config `"$configPath`""
& schtasks.exe /Create /SC ONLOGON /TN $taskName /TR $taskCommand /F | Out-Null
Start-Process -FilePath $nodePath -ArgumentList @((Join-Path $InstallDir 'client.mjs'), '--config', $configPath) -WorkingDirectory $InstallDir
$connected = $false
for ($attempt = 0; $attempt -lt 15 -and -not $connected; $attempt++) {
  Start-Sleep -Seconds 1
  if (Test-Path $logPath) {
    $connected = (Get-Content $logPath -Raw -ErrorAction SilentlyContinue) -match '\bauthenticated\b'
  }
}
if (-not $connected) { throw "Remote client did not confirm a connection. Check $logPath" }
if ($PermissionMode -eq 'admin') { Write-Warning 'Administrator mode enables only server-approved capabilities; it does not grant implicit elevation.' }
Write-Host "Connection succeeded: Metis AI remote client is authenticated and running in $PermissionMode mode at $InstallDir"

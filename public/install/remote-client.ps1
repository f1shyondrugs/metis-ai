param(
  [Parameter(Mandatory=$true)][string]$Server,
  [Parameter(Mandatory=$true)][string]$EnrollmentToken,
  [ValidateSet('user','admin')][string]$PermissionMode = 'user',
  [string]$InstallDir = "$env:LOCALAPPDATA\MetisAI\RemoteClient"
)
$ErrorActionPreference = 'Stop'
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
Set-Content (Join-Path $InstallDir 'run-client.cmd') "@echo off`r`nnode `"%~dp0client.mjs`" --config `"%~dp0config.json`"" -Encoding ascii
if ($PermissionMode -eq 'admin') { Write-Warning 'Administrator mode enables only server-approved capabilities; it does not grant implicit elevation.' }
Write-Host "Metis AI remote client installed in $PermissionMode mode at $InstallDir"

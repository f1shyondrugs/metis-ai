param(
  [Parameter(Position=0)][string]$Command = "",
  [string]$InstallDir = "",
  [string]$RepoUrl = $env:METIS_AI_REPO_URL,
  [string]$DataDir = "",
  [string]$AgentCwd = "",
  [string]$Port = "3100",
  [Alias("Host")][string]$BindHost = "127.0.0.1",
  [string]$McpPort = "8787",
  [string]$Username = "admin",
  [string]$Password = "",
  [string]$PasswordFile = "",
  [string]$ServiceName = "MetisAI",
  [string]$PublicUrl = "",
  [string]$Version = "",
  [switch]$NonInteractive,
  [switch]$SkipRuntimeInstall,
  [switch]$Native,
  [switch]$ReplaceExisting,
  [switch]$DryRun,
  [switch]$Help,
  [switch]$Yes,
  [switch]$KeepData,
  [switch]$RemoveData
)

$ErrorActionPreference = "Stop"
if ($Help) {
  @"
Usage:
  windows.ps1                         Guided installation
  windows.ps1 -NonInteractive -Password P

This script must be invoked with powershell -File. Do not pipe it to iex;
use install.ps1 for the one-line installer.

Options: -InstallDir, -DataDir, -AgentCwd, -Port, -Host, -McpPort,
         -Username, -Password, -PasswordFile, -ServiceName, -PublicUrl, -Version
         -NonInteractive, -SkipRuntimeInstall, -Native, -ReplaceExisting, -DryRun
         uninstall [-Yes] [-KeepData] [-InstallDir DIR]
"@ | Write-Host
  exit 0
}
if ($Command -eq "uninstall") {
  $selfDir = Split-Path -Parent $MyInvocation.MyCommand.Path
  $uninstaller = Join-Path $selfDir "uninstall.ps1"
  if (-not (Test-Path -LiteralPath $uninstaller)) {
    $uninstaller = Join-Path (Join-Path $selfDir "install") "uninstall.ps1"
  }
  if (-not (Test-Path -LiteralPath $uninstaller)) { throw "Could not find uninstall.ps1 next to windows.ps1." }
  $forward = @()
  if ($InstallDir) { $forward += @("-InstallDir", $InstallDir) }
  if ($ServiceName) { $forward += @("-ServiceName", $ServiceName) }
  if ($KeepData) { $forward += "-KeepData" }
  if ($RemoveData) { $forward += "-RemoveData" }
  if ($DryRun) { $forward += "-DryRun" }
  if ($Yes) { $forward += "-Yes" }
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $uninstaller @forward
  exit $LASTEXITCODE
}
if (-not $RepoUrl) { $RepoUrl = "https://github.com/f1shyondrugs/metis-ai.git" }
if (-not $InstallDir) {
  $InstallDir = if ($env:METIS_AI_INSTALL_DIR) { $env:METIS_AI_INSTALL_DIR } else { Join-Path $HOME "metis-ai" }
}

function Ask([string]$Prompt, [string]$Default) {
  if ($NonInteractive) { return $Default }
  $value = Read-Host "$Prompt [$Default]"
  if ([string]::IsNullOrWhiteSpace($value)) { return $Default }
  return $value
}
function Get-DefaultPublicHost {
  $ip = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object { $_.IPAddress -notlike "127.*" -and $_.IPAddress -notlike "169.254.*" } |
    Select-Object -First 1 -ExpandProperty IPAddress
  if ($ip) { return $ip }
  return "127.0.0.1"
}
function Require-Command([string]$Name) {
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) { throw "$Name is required." }
}
function Refresh-Path {
  $env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" +
    [Environment]::GetEnvironmentVariable("Path", "User")
}
function Get-NodeMajor {
  $node = Get-Command node -ErrorAction SilentlyContinue
  if (-not $node) { return 0 }
  try { return [int]((& $node.Source -p "process.versions.node.split('.')[0]")) } catch { return 0 }
}
function Confirm-Install([string]$Name) {
  if ($NonInteractive) { return $true }
  $answer = Read-Host "$Name is missing or too old. Install/update it automatically now? (Y/n)"
  return [string]::IsNullOrWhiteSpace($answer) -or $answer -match "^(y|yes)$"
}

if ($PasswordFile) {
  if (-not (Test-Path -LiteralPath $PasswordFile -PathType Leaf)) { throw "Password file is not readable: $PasswordFile" }
  $Password = (Get-Content -LiteralPath $PasswordFile -Raw).TrimEnd("`r", "`n")
}

$port = $Port
$mcpPort = $McpPort
$username = $Username
$serviceName = $ServiceName
$dataDir = if ($DataDir) { $DataDir } else { Join-Path $InstallDir "data" }
$agentCwd = if ($AgentCwd) { $AgentCwd } else { $HOME }

if (-not $NonInteractive) {
  $InstallDir = Ask "Installation directory" $InstallDir
  $dataDir = if ($DataDir) { $DataDir } else { Join-Path $InstallDir "data" }
  $dataDir = Ask "Data directory" $dataDir
  $agentCwd = Ask "Agent workspace directory" $agentCwd
  $port = Ask "Web application port" $port
  $hostMode = (Ask "Host web application on local network? (y/N)" "n").Trim().ToLowerInvariant()
  $aiChatHost = if (@("y", "yes", "1", "true") -contains $hostMode) { "0.0.0.0" } else { "127.0.0.1" }
  $mcpPort = Ask "MCP gateway port" $mcpPort
  $username = Ask "Initial username" $username
  $passwordSecure = Read-Host "Initial password" -AsSecureString
  $passwordAgain = Read-Host "Confirm password" -AsSecureString
  $passwordPlain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($passwordSecure))
  $passwordAgainPlain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($passwordAgain))
  if ($passwordPlain.Length -lt 8 -or $passwordPlain -cne $passwordAgainPlain) { throw "Passwords must match and contain at least 8 characters." }
  $serviceName = Ask "Task prefix" $serviceName
} else {
  $aiChatHost = if ($BindHost) { $BindHost } else { "127.0.0.1" }
  $passwordPlain = $Password
  if ([string]::IsNullOrEmpty($passwordPlain) -or $passwordPlain.Length -lt 8) {
    throw "-Password is required and must contain at least 8 characters with -NonInteractive."
  }
}

$publicHost = if ($aiChatHost -eq "0.0.0.0") { Get-DefaultPublicHost } else { "127.0.0.1" }
$publicUrl = if ($PublicUrl) { $PublicUrl } else { "http://$publicHost`:$port" }

$portNumber = 0
$mcpPortNumber = 0
if (-not [int]::TryParse($port, [ref]$portNumber) -or $portNumber -lt 1 -or $portNumber -gt 65535) {
  throw "Web port must be a number between 1 and 65535."
}
if (-not [int]::TryParse($mcpPort, [ref]$mcpPortNumber) -or $mcpPortNumber -lt 1 -or $mcpPortNumber -gt 65535) {
  throw "MCP port must be a number between 1 and 65535."
}
if ($serviceName -notmatch '^[A-Za-z0-9][A-Za-z0-9_-]*$') {
  throw "Service name may contain letters, numbers, underscores and hyphens."
}

$existingServiceDir = ""
try {
  $existingRun = (Get-ItemProperty -LiteralPath "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run" -Name "$serviceName-app" -ErrorAction Stop)."$serviceName-app"
  if ($existingRun) {
    $cmdPath = [string]$existingRun.Trim().Trim('"')
    if (Test-Path -LiteralPath $cmdPath) { $existingServiceDir = Split-Path -Parent $cmdPath }
  }
} catch {}

if ($DryRun) {
  Write-Host "Dry run; no files or services will be changed."
  Write-Host "  os:            windows"
  Write-Host "  install dir:   $InstallDir"
  Write-Host "  data dir:      $dataDir"
  Write-Host "  agent cwd:     $agentCwd"
  Write-Host "  bind:          ${aiChatHost}:${port}"
  Write-Host "  mcp port:      $mcpPort"
  Write-Host "  service name:  $serviceName"
  Write-Host "  public url:    $publicUrl"
  Write-Host "  username:      $username"
  Write-Host "  native:        $Native"
  if ($existingServiceDir) { Write-Host "  existing:      $serviceName-app at $existingServiceDir" } else { Write-Host "  existing:      none" }
  exit 0
}

$script:ReplaceDataStash = $null
$script:ReplaceEnvStash = $null

function Get-EnvStashPath([string]$Dir) {
  $full = [IO.Path]::GetFullPath($Dir).TrimEnd('\')
  return Join-Path (Split-Path -Parent $full) (".$(Split-Path -Leaf $full).metis-keep-env")
}

function Get-EnvKey([string]$Line) {
  $trim = $Line.Trim()
  if (-not $trim -or $trim.StartsWith('#')) { return "" }
  $idx = $trim.IndexOf('=')
  if ($idx -lt 1) { return "" }
  return $trim.Substring(0, $idx)
}

function Save-ExistingEnv([string]$Dir) {
  $src = Join-Path $Dir ".env"
  if (-not (Test-Path -LiteralPath $src)) { return }
  $script:ReplaceEnvStash = Get-EnvStashPath $Dir
  Copy-Item -LiteralPath $src -Destination $script:ReplaceEnvStash -Force
  Write-Host "Kept previous .env at $($script:ReplaceEnvStash)"
}

function Adopt-EnvStash([string]$Dir) {
  if ($script:ReplaceEnvStash -and (Test-Path -LiteralPath $script:ReplaceEnvStash)) { return }
  $candidate = Get-EnvStashPath $Dir
  if (Test-Path -LiteralPath $candidate) {
    $script:ReplaceEnvStash = $candidate
    return
  }
  Save-ExistingEnv $Dir
}

function Merge-PreservedEnv([string]$Dest) {
  if (-not $script:ReplaceEnvStash -or -not (Test-Path -LiteralPath $script:ReplaceEnvStash) -or -not (Test-Path -LiteralPath $Dest)) { return }
  $structural = @{}
  foreach ($key in @(
    'AI_CHAT_ROOT', 'AI_CHAT_INSTALL_DIR', 'METIS_NODE_BIN', 'METIS_NODE_HOME',
    'CHAT_DATA_DIR', 'METIS_DATA_DIR', 'AGENT_CWD', 'METIS_WORKSPACE',
    'AI_CHAT_MCP_STATE_DIR', 'METIS_DOCKER', 'AI_CHAT_SERVICE_NAME'
  )) { $structural[$key] = $true }
  $oldLines = [ordered]@{}
  foreach ($line in Get-Content -LiteralPath $script:ReplaceEnvStash) {
    $k = Get-EnvKey $line
    if ($k) { $oldLines[$k] = $line }
  }
  $used = @{}
  $out = New-Object System.Collections.Generic.List[string]
  foreach ($line in Get-Content -LiteralPath $Dest) {
    $k = Get-EnvKey $line
    if ($k -and -not $structural.ContainsKey($k) -and $oldLines.Contains($k)) {
      $out.Add([string]$oldLines[$k])
      $used[$k] = $true
    } else {
      $out.Add($line)
      if ($k) { $used[$k] = $true }
    }
  }
  foreach ($k in $oldLines.Keys) {
    if (-not $used.ContainsKey($k) -and -not $structural.ContainsKey($k)) {
      $out.Add([string]$oldLines[$k])
    }
  }
  $utf8NoBom = New-Object System.Text.UTF8Encoding $false
  [IO.File]::WriteAllText($Dest, (($out -join [Environment]::NewLine).TrimEnd() + [Environment]::NewLine), $utf8NoBom)
  Remove-Item -LiteralPath $script:ReplaceEnvStash -Force
  $script:ReplaceEnvStash = $null
  Write-Host "Merged previous .env into $Dest (old values kept, new keys added)."
}

function Get-ExistingDataDir([string]$Dir) {
  $envFile = Join-Path $Dir ".env"
  if (Test-Path -LiteralPath $envFile) {
    $line = Get-Content -LiteralPath $envFile | Where-Object { $_ -match '^CHAT_DATA_DIR=' } | Select-Object -First 1
    if ($line) {
      $value = $line.Substring('CHAT_DATA_DIR='.Length).Trim().Trim('"')
      if ($value) { return $value }
    }
  }
  $manifestPath = Join-Path $Dir ".metis-ai-install.json"
  if (Test-Path -LiteralPath $manifestPath) {
    try {
      $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
      if ($manifest.dataDir) { return [string]$manifest.dataDir }
    } catch {}
  }
  $nested = Join-Path $Dir "data"
  if (Test-Path -LiteralPath $nested) { return $nested }
  return ""
}

function Test-PathInside([string]$Inner, [string]$Outer) {
  $innerFull = [IO.Path]::GetFullPath($Inner).TrimEnd('\')
  $outerFull = [IO.Path]::GetFullPath($Outer).TrimEnd('\')
  return ($innerFull -eq $outerFull) -or $innerFull.StartsWith($outerFull + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)
}

function Uninstall-DetectedInstall([string]$Dir) {
  if (-not $Dir -or $Dir -eq [IO.Path]::GetPathRoot($Dir) -or $Dir -eq $HOME) {
    throw "Refusing to uninstall an unsafe install directory: $Dir"
  }
  Write-Host "Uninstalling existing Metis AI at $Dir (data kept)."
  $data = Get-ExistingDataDir $Dir
  $runKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
  foreach ($suffix in @("app", "worker", "mcp")) {
    $task = "$serviceName-$suffix"
    Remove-ItemProperty -LiteralPath $runKey -Name $task -ErrorAction SilentlyContinue
    cmd.exe /c "schtasks /Delete /TN `"$task`" /F >nul 2>&1" | Out-Null
  }
  $rootNorm = [IO.Path]::GetFullPath($Dir).TrimEnd('\')
  Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -eq "node.exe" -and $_.CommandLine -and $_.CommandLine.IndexOf($rootNorm, [StringComparison]::OrdinalIgnoreCase) -ge 0 } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Save-ExistingEnv $Dir
  if ($data -and (Test-Path -LiteralPath $data) -and (Test-PathInside $data $Dir)) {
    $parent = Split-Path -Parent $rootNorm
    $script:ReplaceDataStash = Join-Path $parent (".$(Split-Path -Leaf $rootNorm).metis-keep-data")
    if (Test-Path -LiteralPath $script:ReplaceDataStash) { Remove-Item -LiteralPath $script:ReplaceDataStash -Recurse -Force }
    Move-Item -LiteralPath $data -Destination $script:ReplaceDataStash
    Write-Host "Kept nested data at $($script:ReplaceDataStash)"
  }
  Start-Sleep -Seconds 1
  if (Test-Path -LiteralPath $rootNorm) {
    cmd.exe /c "rmdir /s /q `"\\?\$rootNorm`"" | Out-Null
  }
}

function Restore-StashedData([string]$Dest) {
  if (-not $script:ReplaceDataStash -or -not (Test-Path -LiteralPath $script:ReplaceDataStash)) { return }
  $destParent = Split-Path -Parent $Dest
  if ($destParent) { New-Item -ItemType Directory -Force -Path $destParent | Out-Null }
  if (Test-Path -LiteralPath $Dest) { Remove-Item -LiteralPath $Dest -Recurse -Force }
  Move-Item -LiteralPath $script:ReplaceDataStash -Destination $Dest
  $script:ReplaceDataStash = $null
  Write-Host "Restored kept data to $Dest"
}

if ($existingServiceDir) {
  $existingFull = [IO.Path]::GetFullPath($existingServiceDir)
  $installFull = [IO.Path]::GetFullPath($InstallDir)
  $same = $existingFull -eq $installFull
  $choice = ""
  if ($ReplaceExisting) {
    $choice = "r"
  } elseif ($NonInteractive) {
    if ($same) { $choice = "u" }
  } else {
    Write-Host "Existing Metis AI detected."
    Write-Host "  service:   $serviceName-app"
    Write-Host "  directory: $existingServiceDir"
    Write-Host "[u] Upgrade that install"
    Write-Host "[r] Replace it (uninstall, keep data, then continue)"
    Write-Host "[n] Uninstall and exit (keeps data)"
    Write-Host "[a] Abort"
    $choice = Read-Host "Choice [u/r/n/a]"
  }
  switch -Regex ($choice) {
    '^[rR]$' {
      $InstallDir = $existingServiceDir
      if (-not $DataDir) { $dataDir = Join-Path $InstallDir "data" }
      Uninstall-DetectedInstall $InstallDir
      $existingServiceDir = ""
    }
    '^[uU]$' {
      $InstallDir = $existingServiceDir
      Write-Host "Existing Metis AI install detected: $serviceName-app is registered in $InstallDir. Upgrading in place."
    }
    '^[aA]$' {
      Write-Host "Aborted."
      exit 0
    }
    '^[nN]$' {
      $self = $MyInvocation.MyCommand.Path
      $forward = @("uninstall", "-InstallDir", $existingServiceDir, "-Yes", "-KeepData")
      if ($DryRun) { $forward += "-DryRun" }
      & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $self @forward
      exit $LASTEXITCODE
    }
    default {
      throw "Metis AI is already installed as $serviceName-app in $existingServiceDir. Re-run and choose upgrade/replace/uninstall, or pass -ReplaceExisting."
    }
  }
}

$useDocker = $false
if (-not $Native) {
  $docker = Get-Command docker -ErrorAction SilentlyContinue
  if ($docker) {
    try {
      & docker info | Out-Null
      & docker compose version | Out-Null
      if ($LASTEXITCODE -eq 0) { $useDocker = $true }
    } catch { $useDocker = $false }
  }
}

if (-not $SkipRuntimeInstall) {
  if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    throw "winget is required to install Git and Node.js automatically."
  }
  if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    if (-not (Confirm-Install "Git")) { throw "git is required." }
    winget install --id Git.Git --accept-source-agreements --accept-package-agreements
  }
  if (-not $useDocker -and (Get-NodeMajor) -lt 22) {
    if (-not (Confirm-Install "Node.js 22 or newer")) { throw "Node.js 22 or newer is required." }
    winget install --id OpenJS.NodeJS.LTS --source winget --accept-source-agreements --accept-package-agreements
  }
  Refresh-Path
}
Require-Command git
if (-not $useDocker -and (Get-NodeMajor) -lt 22) { throw "Node.js 22 or newer is required." }

if (Test-Path (Join-Path $InstallDir ".git")) {
  git -C $InstallDir pull --ff-only
} elseif ((Test-Path $InstallDir) -and (Get-ChildItem -Force $InstallDir | Select-Object -First 1)) {
  throw "Installation directory exists and is not a Metis AI checkout: $InstallDir"
} else {
  New-Item -ItemType Directory -Force -Path (Split-Path $InstallDir) | Out-Null
  git clone $RepoUrl $InstallDir
}
if ($Version -and $Version -ne "latest") {
  if ($Version -notmatch '^v\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$') {
    throw "Version must be latest or a v-prefixed SemVer tag, for example v1.0.0."
  }
  git -C $InstallDir fetch --tags --force
  git -C $InstallDir checkout --force $Version
}
Restore-StashedData $dataDir

function Get-PnpmCommand {
  $existing = (Get-Command pnpm.cmd -ErrorAction SilentlyContinue).Source
  if ($existing) { return [string]$existing }
  $runtimePrefix = Join-Path $InstallDir ".runtime"
  $candidates = @(
    (Join-Path $runtimePrefix "pnpm.cmd"),
    (Join-Path $runtimePrefix "node_modules\.bin\pnpm.cmd")
  )
  foreach ($candidate in $candidates) {
    if (Test-Path -LiteralPath $candidate) { return [string]$candidate }
  }
  $npmCommand = (Get-Command npm.cmd -ErrorAction SilentlyContinue).Source
  if (-not $npmCommand) { throw "npm is required to install pnpm without Administrator access." }
  New-Item -ItemType Directory -Force -Path $runtimePrefix | Out-Null
  & $npmCommand install --global --prefix $runtimePrefix pnpm@9 | Out-Null
  $env:Path = "$runtimePrefix;$runtimePrefix\node_modules\.bin;" + $env:Path
  foreach ($candidate in $candidates) {
    if (Test-Path -LiteralPath $candidate) { return [string]$candidate }
  }
  $refreshed = (Get-Command pnpm.cmd -ErrorAction SilentlyContinue).Source
  if ($refreshed) { return [string]$refreshed }
  throw "pnpm is required."
}
$pnpmCommand = $null
$nodeBin = $null
if (-not $useDocker) {
  $pnpmCommand = [string](Get-PnpmCommand)
  $nodeBin = (Get-Command node).Source
}

$randomHex = { -join (1..32 | ForEach-Object { "{0:x2}" -f (Get-Random -Maximum 256) }) }
$chatPassword = & $randomHex
$secretsKey = & $randomHex
$mcpToken = & $randomHex

New-Item -ItemType Directory -Force -Path $dataDir, $agentCwd | Out-Null
Adopt-EnvStash $InstallDir
$dockerEnv = ""
if ($useDocker) {
  $dockerEnv = @"
METIS_WORKSPACE=$agentCwd
METIS_DATA_DIR=$dataDir
AI_CHAT_BIND=$aiChatHost
METIS_DOCKER=1
AGENT_CWD=/workspace
CHAT_DATA_DIR=/data
METIS_AI_BOOTSTRAP_USERNAME=$username
METIS_AI_BOOTSTRAP_PASSWORD=$passwordPlain
METIS_AI_BOOTSTRAP_OPTIONAL=1
"@
} else {
  $dockerEnv = "METIS_NODE_BIN=$nodeBin"
}
$envLines = @"
APP_NAME=Metis AI
PORT=$port
AI_CHAT_HOST=$aiChatHost
CHAT_USERNAME=$username
CHAT_PASSWORD=$chatPassword
CHAT_DATA_DIR=$dataDir
AGENT_CWD=$agentCwd
AI_CHAT_ROOT=$InstallDir
AI_CHAT_INSTALL_DIR=$InstallDir
AI_CHAT_PUBLIC_URL=$publicUrl
AI_CHAT_INTERNAL_ORIGIN=http://127.0.0.1:$port
AI_CHAT_SERVICE_NAME=$serviceName
AI_CHAT_WORKER_CONCURRENCY=25
AI_CHAT_MCP_STATE_DIR=$(Join-Path $dataDir "mcp-state")
AI_CHAT_INTERNAL_URL=http://127.0.0.1:$port/api/internal/mcp-question
AI_CHAT_WORKSPACE_URL=http://127.0.0.1:$port/api/internal/mcp-workspace
AI_CHAT_CHAT_URL=http://127.0.0.1:$port/api/internal/mcp-chat
AI_CHAT_NOTES_URL=http://127.0.0.1:$port/api/internal/mcp-notes
AI_CHAT_MEMORY_URL=http://127.0.0.1:$port/api/internal/mcp-memory
AI_CHAT_BROWSER_URL=http://127.0.0.1:$port/api/internal/browser
AI_CHAT_AGENT_STATE_URL=http://127.0.0.1:$port/api/internal/mcp-agent-state
AI_CHAT_SUBAGENT_URL=http://127.0.0.1:$port/api/internal/mcp-subagent
AI_CHAT_AUTOMATION_URL=http://127.0.0.1:$port/api/internal/mcp-automation
AI_CHAT_FILE_URL=http://127.0.0.1:$port/api/internal/mcp-file
AI_CHAT_SECRETS_KEY=$secretsKey
MCP_PORT=$mcpPort
MCP_PUBLIC_URL=http://127.0.0.1:$mcpPort
MCP_BEARER_TOKEN=$mcpToken
MCP_ALLOW_REMOTE_ADMIN=false
MCP_ENABLE_REMOTE_SERVERS=false
MCP_ENABLE_OPTIONAL_SERVERS=false
$dockerEnv
"@
$utf8NoBom = New-Object System.Text.UTF8Encoding $false
[System.IO.File]::WriteAllText((Join-Path $InstallDir ".env"), $envLines.Trim() + [Environment]::NewLine, $utf8NoBom)
Merge-PreservedEnv (Join-Path $InstallDir ".env")
$mergedEnv = Join-Path $InstallDir ".env"
foreach ($line in Get-Content -LiteralPath $mergedEnv) {
  $k = Get-EnvKey $line
  if (-not $k) { continue }
  $v = $line.Substring($k.Length + 1).Trim().Trim('"')
  if ($k -eq 'PORT' -and $v -match '^[0-9]+$') { $port = $v }
  if ($k -eq 'MCP_PORT' -and $v -match '^[0-9]+$') { $mcpPort = $v }
}

if ($useDocker) {
  Push-Location $InstallDir
  try {
    docker compose up -d --build
  } finally {
    Pop-Location
  }
} else {
Push-Location $InstallDir
try {
  $previousNodeEnv = $env:NODE_ENV
  Remove-Item Env:NODE_ENV -ErrorAction SilentlyContinue
  & $pnpmCommand install --frozen-lockfile
  $env:METIS_AI_BOOTSTRAP_USERNAME = $username
  $env:METIS_AI_BOOTSTRAP_PASSWORD = $passwordPlain
  $env:METIS_AI_BOOTSTRAP_OPTIONAL = "1"
  & $pnpmCommand exec tsx scripts/bootstrap-user.ts
  & $pnpmCommand build
} finally {
  if ($null -ne $previousNodeEnv) { $env:NODE_ENV = $previousNodeEnv }
  Pop-Location
  Remove-Item Env:METIS_AI_BOOTSTRAP_USERNAME -ErrorAction SilentlyContinue
  Remove-Item Env:METIS_AI_BOOTSTRAP_PASSWORD -ErrorAction SilentlyContinue
  Remove-Item Env:METIS_AI_BOOTSTRAP_OPTIONAL -ErrorAction SilentlyContinue
}

$runner = Join-Path $InstallDir "run-service.ps1"
@"
`$ErrorActionPreference = "Stop"
Get-Content -LiteralPath (Join-Path `$PSScriptRoot ".env") | Where-Object { `$_ -and -not `$_.StartsWith("#") } | ForEach-Object {
  `$pair = `$_ -split "=", 2
  if (`$pair.Count -eq 2) { [Environment]::SetEnvironmentVariable(`$pair[0].Trim([char]0xFEFF), `$pair[1], "Process") }
}
Set-Location `$PSScriptRoot
`$node = `$env:METIS_NODE_BIN
if (-not `$node -or -not (Test-Path -LiteralPath `$node)) { `$node = (Get-Command node).Source }
& `$node @args
"@ | Set-Content -LiteralPath $runner -Encoding ascii

$runKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
New-Item -Path $runKey -Force | Out-Null
$powershellExe = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
foreach ($suffix in @("app", "worker", "mcp")) {
  $taskName = "$serviceName-$suffix"
  $targetArgs = switch ($suffix) {
    "app" { @("node_modules/tsx/dist/cli.mjs", "server.mjs") }
    "worker" { @("node_modules/tsx/dist/cli.mjs", "worker.ts") }
    default { @("lib/mcp-core/gateway-core.mjs") }
  }
  $cmdPath = Join-Path $InstallDir "run-$suffix.cmd"
  $cmdArgs = ($targetArgs | ForEach-Object { "`"$_`"" }) -join " "
  @(
    "@echo off",
    "cd /d `"%~dp0`"",
    "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"%~dp0run-service.ps1`" $cmdArgs"
  ) -join "`r`n" | Set-Content -LiteralPath $cmdPath -Encoding ascii
  Set-ItemProperty -Path $runKey -Name $taskName -Value "`"$cmdPath`""
  Start-Process -FilePath $powershellExe -WorkingDirectory $InstallDir -WindowStyle Hidden -ArgumentList (@("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $runner) + $targetArgs)
}
}

for ($attempt = 0; $attempt -lt 45; $attempt++) {
  try {
    Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$port/api/status" -TimeoutSec 2 | Out-Null
    break
  } catch {
    if ($attempt -eq 44) { throw "The application did not become healthy." }
    Start-Sleep -Seconds 1
  }
}
for ($attempt = 0; $attempt -lt 20; $attempt++) {
  try {
    Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$mcpPort/health" -TimeoutSec 2 | Out-Null
    break
  } catch {
    if ($attempt -eq 19) { throw "The MCP gateway did not become healthy on port $mcpPort." }
    Start-Sleep -Seconds 1
  }
}

$manifest = @{
  installDir = $InstallDir
  dataDir = $dataDir
  agentCwd = $agentCwd
  serviceName = $serviceName
  host = $aiChatHost
  os = "windows"
  installMethod = $(if ($useDocker) { "docker" } else { "native" })
  createdAt = [DateTime]::UtcNow.ToString("o")
} | ConvertTo-Json -Compress
Set-Content -LiteralPath (Join-Path $InstallDir ".metis-ai-install.json") -Value $manifest -Encoding utf8
Copy-Item -LiteralPath (Join-Path $InstallDir "install/uninstall.ps1") -Destination (Join-Path $InstallDir "uninstall.ps1") -Force
if ($aiChatHost -eq "0.0.0.0") {
  Write-Host "Warning: the web application is reachable on the local network. Use strong credentials and a firewall or trusted TLS reverse proxy."
}
Write-Host "`nMetis AI installed successfully."
Write-Host "Open: $publicUrl"
Write-Host "Uninstall: $(Join-Path $InstallDir 'uninstall.ps1') -InstallDir `"$InstallDir`" -KeepData"

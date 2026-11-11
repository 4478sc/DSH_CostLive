# VM-backed dashboard: one SSH forward, one existing host->VM push loop.
[CmdletBinding()]
param([switch]$Ensure, [switch]$Open)
$ErrorActionPreference = 'Stop'
$Repo = Split-Path -Parent $PSScriptRoot
$ConfigPath = Join-Path $Repo 'config/vm-dashboard.local.json'
if (-not (Test-Path $ConfigPath)) { throw 'Copy config/vm-dashboard.example.json to config/vm-dashboard.local.json and configure your VM.' }
$Config = Get-Content -Raw $ConfigPath | ConvertFrom-Json
$VmHost = [string]$Config.host
$VmUser = [string]$Config.user
$Key = [Environment]::ExpandEnvironmentVariables([string]$Config.keyPath)
$PushLoop = [Environment]::ExpandEnvironmentVariables([string]$Config.pushLoop)
if (-not [IO.Path]::IsPathRooted($PushLoop)) { $PushLoop = [IO.Path]::GetFullPath((Join-Path $Repo $PushLoop)) }
if ($VmHost -notmatch '^[a-zA-Z0-9.-]+$' -or $VmUser -notmatch '^[a-zA-Z0-9_-]+$') { throw 'Invalid SSH target' }
if (-not (Test-Path $Key) -or -not (Test-Path $PushLoop)) { throw 'SSH key or host push loop is missing' }
$Out = Join-Path $Repo 'out'
New-Item -ItemType Directory -Force $Out | Out-Null
$Lock = Join-Path $Out 'vm-dashboard.pid'
function Existing-Supervisor {
  if (-not (Test-Path $Lock)) { return $false }
  $Raw = (Get-Content $Lock -TotalCount 1).Trim()
  if ($Raw -notmatch '^\d+$') { return $false }
  $Proc = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $Raw) -ErrorAction SilentlyContinue
  return $Proc -and $Proc.CommandLine -like '*vm-dashboard.ps1*'
}
if ($Ensure -or $Open) {
  Start-Process -FilePath 'powershell.exe' -ArgumentList ('-NoProfile -ExecutionPolicy Bypass -File "' + $PushLoop + '"') -WindowStyle Hidden | Out-Null
  if (-not (Existing-Supervisor)) {
    $LaunchArgs = '-NoProfile -ExecutionPolicy Bypass -File "' + $PSCommandPath + '"'
    Start-Process -FilePath 'powershell.exe' -ArgumentList $LaunchArgs -WindowStyle Hidden | Out-Null
  }
  if ($Open) { Start-Process 'http://127.0.0.1:4173/' }
  exit 0
}
$Mutex = New-Object System.Threading.Mutex($false, 'DSH_CostLive_VmDashboard')
if (-not $Mutex.WaitOne(0)) { exit 0 }
[IO.File]::WriteAllText($Lock, [string]$PID)
# The existing push loop has its own mutex and remains the only session uploader.
function Ensure-Uploader {
  # The uploader's own mutex rejects duplicate starts. Periodic restart heals exits.
  Start-Process -FilePath 'powershell.exe' -ArgumentList ('-NoProfile -ExecutionPolicy Bypass -File "' + $PushLoop + '"') -WindowStyle Hidden | Out-Null
}
Ensure-Uploader
try {
  while ($true) {
    Ensure-Uploader
    $Listener = Get-NetTCPConnection -LocalPort 4173 -State Listen -ErrorAction SilentlyContinue
    if ($Listener) { Write-Warning 'Port 4173 is occupied; refusing to replace an unrelated service.'; Start-Sleep -Seconds 15; continue }
    & "$env:SystemRoot/System32/OpenSSH/ssh.exe" -N -L '127.0.0.1:4173:127.0.0.1:4173' -i $Key -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=3 -o ConnectTimeout=8 ($VmUser + '@' + $VmHost)
    Start-Sleep -Seconds 5
  }
} finally { $Mutex.ReleaseMutex(); $Mutex.Dispose() }

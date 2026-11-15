# VM-backed dashboard: one SSH forward, one existing host->VM push loop.
# Windowless startup (2026-11-16): every console child is created with
# CREATE_NO_WINDOW via tools/hidden-launch.ps1, and the scheduled tasks enter
# this chain through tools/launch-hidden.vbs. '-WindowStyle Hidden' alone still
# showed a Windows Terminal window on the measured host; see
# docs/host-sync-windowless.md for the measurement and the regression tests.
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
# The launcher ships with this repo, so main never depends on a helper that a
# deployment happens to keep next to its own push loop (config.pushLoop may point
# outside the repo, and that external copy is only for that deployment).
$Helper = Join-Path $PSScriptRoot 'hidden-launch.ps1'
if (-not (Test-Path $Helper)) { throw ('Missing windowless launcher helper: ' + $Helper) }
. $Helper
$Out = Join-Path $Repo 'out'
New-Item -ItemType Directory -Force $Out | Out-Null
$Lock = Join-Path $Out 'vm-dashboard.pid'
$SupervisorMutex = 'DSH_CostLive_VmDashboard'
$UploaderMutex = 'DSH_CostLive_VmPushLoop'

function Test-SupervisorRunning { return (Test-ProcessMutex -Name $SupervisorMutex) }
function Test-UploaderRunning { return (Test-ProcessMutex -Name $UploaderMutex) }

# Probe before starting: the old code started a push loop unconditionally on
# every tick and after every failed forward, so an offline VM got a new console
# (and a new window) every ~14 s.
function Start-Uploader {
  if (Test-UploaderRunning) { return $false }
  [void](Start-HiddenPowerShell -ScriptPath $PushLoop)
  return $true
}
function Start-Supervisor {
  if (Test-SupervisorRunning) { return $false }
  [void](Start-HiddenPowerShell -ScriptPath $PSCommandPath)
  return $true
}

if ($Ensure -or $Open) {
  [void](Start-Uploader)
  [void](Start-Supervisor)
  if ($Open) { Start-Process 'http://127.0.0.1:4173/' }
  exit 0
}

$Mutex = New-Object System.Threading.Mutex($false, $SupervisorMutex)
if (-not $Mutex.WaitOne(0)) { exit 0 }
[IO.File]::WriteAllText($Lock, [string]$PID)
$Log = Join-Path $Out 'vm-dashboard.log'
function Write-Log([string]$Text) {
  try {
    if ((Test-Path $Log) -and ((Get-Item $Log).Length -gt 1048576)) { Move-Item -Force $Log ($Log + '.old') }
    Add-Content -LiteralPath $Log -Value ((Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + ' ' + $Text) -Encoding utf8
  } catch { }
}

# The existing push loop has its own mutex and remains the only session uploader.
# Forward retry backoff: 5, 10, 20, 40, 60 s capped (Get-NextRetryDelay); a
# forward that stayed up for at least a minute resets the ramp. The old loop
# retried roughly every 13 s for ever while the VM was off (14 s spawn storm,
# measured 2026-11-16).
$BackoffStart = 5
$BackoffMax = 60
$HealthyRunSeconds = 60
$backoff = $BackoffStart
$Ssh = Join-Path $env:SystemRoot 'System32\OpenSSH\ssh.exe'
$SshArgs = @(
  '-N', '-L', '127.0.0.1:4173:127.0.0.1:4173', '-i', $Key, '-o', 'BatchMode=yes',
  '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ExitOnForwardFailure=yes',
  '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3', '-o', 'ConnectTimeout=8',
  ($VmUser + '@' + $VmHost)
)
$SshCommandLine = ($SshArgs | ForEach-Object { ConvertTo-NativeArgument $_ }) -join ' '

try {
  Write-Log ('supervisor start pid=' + $PID)
  while ($true) {
    # Heal the uploader only when its mutex says it is really gone.
    if (-not (Test-UploaderRunning)) {
      [void](Start-HiddenPowerShell -ScriptPath $PushLoop)
      Write-Log 'uploader restarted (mutex absent)'
    }
    $Listener = Get-NetTCPConnection -LocalPort 4173 -State Listen -ErrorAction SilentlyContinue
    if ($Listener) { Write-Log 'port 4173 busy; refusing to replace an unrelated service'; Start-Sleep -Seconds 15; continue }
    $startedAt = Get-Date
    $exit = $null
    try {
      $run = Start-HiddenProcess -FilePath $Ssh -Arguments $SshCommandLine -Wait
      $exit = $run.ExitCode
    } catch {
      Write-Log ('ssh launch failed: ' + $_.Exception.Message)
    }
    $ran = [int](((Get-Date) - $startedAt).TotalSeconds)
    if ($ran -ge $HealthyRunSeconds) { $backoff = $BackoffStart }
    $step = Get-NextRetryDelay -Current $backoff -Start $BackoffStart -Max $BackoffMax
    $backoff = $step.Next
    Write-Log ('ssh forward exited code=' + $exit + ' after ' + $ran + 's; retry in ' + $step.Delay + 's')
    Start-Sleep -Seconds $step.Delay
  }
} finally { $Mutex.ReleaseMutex(); $Mutex.Dispose() }

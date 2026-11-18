# VM-backed dashboard: one SSH forward, one existing host->VM push loop.
# Windowless startup (2026-11-16): every console child is created with
# CREATE_NO_WINDOW via tools/hidden-launch.ps1, and the scheduled tasks enter
# this chain through tools/launch-hidden.vbs. '-WindowStyle Hidden' alone still
# showed a Windows Terminal window on the measured host; see
# docs/host-sync-windowless.md for the measurement and the regression tests.
#
# Watchdog (2026-11-19): the supervisor used to probe the uploader's mutex only,
# and it blocked for hours inside the SSH forward, so a loop stuck on a hung
# ssh.exe kept the mutex held and nothing ever noticed. It now waits for the
# forward in bounded slices and, between slices, judges the uploader by its
# heartbeat file: fresh -> leave it alone; stale while the mutex is still held
# -> verify pid + start time + command line, kill that tree, restart; no
# heartbeat yet -> wait out the startup grace first. Thresholds come from
# Get-HeartbeatPolicy, so they always stay above the upload's own bound. See
# docs/host-sync-watchdog.md.
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

function Get-ConfigValue([string]$Name, $Default) {
  if ($null -eq $Config.PSObject.Properties[$Name]) { return $Default }
  $value = $Config.PSObject.Properties[$Name].Value
  if ($null -eq $value) { return $Default }
  if ($value -is [string] -and [string]::IsNullOrWhiteSpace($value)) { return $Default }
  return $value
}

# Optional watchdog settings. heartbeatPath is the only one a deployment must
# add; without it the supervisor keeps the old mutex-only behaviour.
$UploadTimeoutSeconds = [int](Get-ConfigValue 'uploadTimeoutSeconds' 120)
if ($UploadTimeoutSeconds -lt 10) { $UploadTimeoutSeconds = 10 }
$HeartbeatPath = [string](Get-ConfigValue 'heartbeatPath' '')
if (-not [string]::IsNullOrWhiteSpace($HeartbeatPath)) {
  $HeartbeatPath = [Environment]::ExpandEnvironmentVariables($HeartbeatPath)
  if (-not [IO.Path]::IsPathRooted($HeartbeatPath)) { $HeartbeatPath = [IO.Path]::GetFullPath((Join-Path $Repo $HeartbeatPath)) }
}
$PolicyArgs = @{
  OperationTimeoutSeconds = $UploadTimeoutSeconds
  IntervalSeconds         = 20
  MarginSeconds           = 30
  StaleSeconds            = [int](Get-ConfigValue 'heartbeatStaleSeconds' 0)
  StartupGraceSeconds     = [int](Get-ConfigValue 'startupGraceSeconds' 0)
}
$Policy = Get-HeartbeatPolicy @PolicyArgs
$MinSecondsBetweenRestarts = [int](Get-ConfigValue 'minSecondsBetweenRestarts' 60)
$WatchdogTickSeconds = [int](Get-ConfigValue 'watchdogTickSeconds' 20)

$script:HeartbeatEnabled = -not [string]::IsNullOrWhiteSpace($HeartbeatPath)
$script:HeartbeatPath = $HeartbeatPath
$script:StaleSeconds = [int]$Policy.StaleSeconds
$script:StartupGraceSeconds = [int]$Policy.StartupGraceSeconds
$script:MinSecondsBetweenRestarts = $MinSecondsBetweenRestarts
$script:PushLoop = $PushLoop
$script:UploadLoopPattern = [regex]::Escape((Split-Path -Leaf $PushLoop))
$script:SupervisorStartedAt = Get-Date
$script:LastUploaderStartAt = $null
$script:LastWatchdogAction = ''

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

# One decision per tick, with the state the decision needs. Mutex-only healing
# remains for deployments that configure no heartbeat file.
function Invoke-UploaderWatchdog {
  $mutex = Test-UploaderRunning
  if (-not $script:HeartbeatEnabled) {
    if ($mutex -eq $false) {
      if (Start-Uploader) {
        $script:LastUploaderStartAt = Get-Date
        Write-Log 'uploader started (mutex absent)'
      }
    }
    return
  }
  $heartbeat = Read-Heartbeat -Path $script:HeartbeatPath
  $sinceRestart = -1.0
  if ($null -ne $script:LastUploaderStartAt) { $sinceRestart = ((Get-Date) - $script:LastUploaderStartAt).TotalSeconds }
  $supervisorAge = ((Get-Date) - $script:SupervisorStartedAt).TotalSeconds
  $decisionArgs = @{
    MutexPresent             = ($mutex -eq $true)
    Heartbeat                = $heartbeat
    StaleSeconds             = $script:StaleSeconds
    StartupGraceSeconds      = $script:StartupGraceSeconds
    SupervisorAgeSeconds     = $supervisorAge
    SinceLastRestartSeconds  = $sinceRestart
    MinSecondsBetweenRestarts = $script:MinSecondsBetweenRestarts
  }
  $decision = Test-WatchdogAction @decisionArgs
  if ($decision.Action -eq 'none' -and $decision.Action -ne $script:LastWatchdogAction) {
    Write-Log ('watchdog: ' + $decision.Reason)
  }
  $script:LastWatchdogAction = $decision.Action
  if ($decision.Action -eq 'reclaim') {
    if ([int]$heartbeat.Pid -le 0 -or $null -eq $heartbeat.StartedAt) {
      Write-Log ('watchdog: ' + $decision.Reason + '; heartbeat records no pid/start time, not killing anything')
      return
    }
    $snapshot = Get-ProcessSnapshot
    if ($null -eq $snapshot) {
      Write-Log ('watchdog: ' + $decision.Reason + '; process snapshot unavailable, not killing anything')
      return
    }
    $actual = Get-ProcessIdentity -ProcessId ([int]$heartbeat.Pid) -Snapshot $snapshot
    $expected = [pscustomobject]@{ Pid = [int]$heartbeat.Pid; StartedAt = $heartbeat.StartedAt; Name = '' }
    if (-not (Test-ProcessIdentity -Expected $expected -Actual $actual -CommandLinePattern $script:UploadLoopPattern)) {
      Write-Log ('watchdog: ' + $decision.Reason + '; pid ' + $heartbeat.Pid + ' no longer matches the recorded upload loop (recycled pid?), not killing anything')
      return
    }
    $killed = Stop-ProcessTree -RootId ([int]$heartbeat.Pid) -Snapshot $snapshot
    Write-Log ('watchdog: ' + $decision.Reason + '; reclaimed pid=' + $heartbeat.Pid + ' killed=' + $killed.Stopped + ' exited=' + $killed.Exited)
    $released = $false
    for ($i = 0; $i -lt 60; $i += 1) {
      if ((Test-UploaderRunning) -eq $false) { $released = $true; break }
      Start-Sleep -Milliseconds 100
    }
    if (-not $released) {
      Write-Log 'watchdog: uploader mutex still held after reclaim; next tick retries'
      return
    }
    if (Start-Uploader) {
      $script:LastUploaderStartAt = Get-Date
      Write-Log 'uploader started (after reclaim)'
    }
    return
  }
  if ($decision.Action -eq 'restart') {
    if ($mutex -ne $false) {
      Write-Log ('watchdog: ' + $decision.Reason + '; mutex probe says ' + [string]$mutex + ', waiting')
      return
    }
    if (Start-Uploader) {
      $script:LastUploaderStartAt = Get-Date
      Write-Log ('uploader started (' + $decision.Reason + ')')
    }
  }
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
  $watchdogState = 'watchdog=mutex-only'
  if ($script:HeartbeatEnabled) {
    $watchdogState = ('watchdog=heartbeat path=' + $script:HeartbeatPath + ' stale=' + $script:StaleSeconds + 's grace=' + $script:StartupGraceSeconds + 's uploadTimeout=' + $UploadTimeoutSeconds + 's')
  }
  Write-Log ('supervisor start pid=' + $PID + ' ' + $watchdogState)
  while ($true) {
    Invoke-UploaderWatchdog
    $Listener = Get-NetTCPConnection -LocalPort 4173 -State Listen -ErrorAction SilentlyContinue
    if ($Listener) { Write-Log 'port 4173 busy; refusing to replace an unrelated service'; Start-Sleep -Seconds 15; continue }
    $startedAt = Get-Date
    $exit = $null
    try {
      # Not -Wait: a bounded slice lets the watchdog run while a long-lived
      # forward keeps running (a -Wait with no slice is what hid the stall).
      $proc = Start-HiddenProcess -FilePath $Ssh -Arguments $SshCommandLine
      $run = Wait-HiddenProcessExit -Process $proc -TickSeconds $WatchdogTickSeconds -OnTick { Invoke-UploaderWatchdog }
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

# Windowless process helpers for the host->VM sync chain (2026-11-16).
#
# Why this file exists: 'powershell.exe -WindowStyle Hidden' still creates a
# console, and because Windows Terminal is the default terminal on the measured
# host the console shows up as a visible window. Every console child of this
# chain is therefore created with CREATE_NO_WINDOW (.NET CreateNoWindow), which
# gives the child no console window at all. Measured A/B proof, deployment notes
# and the regression tests are in docs/host-sync-windowless.md and
# test/host-sync.tests.ps1.
#
# This module ships with the repo so a checkout is self-contained: tools/ and
# docs/ only ever name this file, and no deployment needs to add its own copy.
# It also holds the retry ramp shared by the SSH forward loop, so that sequence
# can be replayed by a test instead of being read out of a while loop.
#
# It also holds the bounded-wait and watchdog primitives (2026-11-19): a hidden
# child that hangs used to be waited on for ever. A stray ssh.exe held an
# established channel for 1 h 41 min, the upload loop waited on it with no
# bound, its single-instance mutex stayed held and a supervisor that only probes
# that mutex had nothing to act on. See docs/host-sync-watchdog.md.
#
# ASCII only: PowerShell 5.1 reads a BOM-less .ps1 as ANSI.

# The one place a hidden child is described. Split out so the test can assert
# UseShellExecute=false + CreateNoWindow=true without starting anything.
function New-HiddenStartInfo {
  param(
    [Parameter(Mandatory = $true)][string]$FilePath,
    [string]$Arguments = '',
    [string]$WorkingDirectory = ''
  )
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $FilePath
  $psi.Arguments = $Arguments
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  if (-not [string]::IsNullOrWhiteSpace($WorkingDirectory)) { $psi.WorkingDirectory = $WorkingDirectory }
  return $psi
}

function Start-HiddenProcess {
  param(
    [Parameter(Mandatory = $true)][string]$FilePath,
    [string]$Arguments = '',
    [string]$WorkingDirectory = '',
    [switch]$Wait,
    [int]$TimeoutSeconds = 0
  )
  $psi = New-HiddenStartInfo -FilePath $FilePath -Arguments $Arguments -WorkingDirectory $WorkingDirectory
  $proc = [System.Diagnostics.Process]::Start($psi)
  if (-not $Wait) { return $proc }
  if ($TimeoutSeconds -gt 0) {
    if (-not $proc.WaitForExit($TimeoutSeconds * 1000)) {
      # Kill() only reaps the direct child. An ssh.exe or scp.exe it left behind
      # keeps the TCP channel and the single-instance mutex alive, which is the
      # state that made the 2026-11-19 stall invisible to the supervisor.
      $killed = Stop-ProcessTree -RootId $proc.Id
      return [pscustomobject]@{ ExitCode = -1; TimedOut = $true; Stopped = $killed.Stopped; TreeGone = $killed.Exited }
    }
  } else {
    $proc.WaitForExit()
  }
  return [pscustomobject]@{ ExitCode = $proc.ExitCode; TimedOut = $false; Stopped = 0; TreeGone = $true }
}

# Quote one argument the way CreateProcess/CommandLineToArgvW expects it, so a
# path that contains spaces (or quotes) survives intact. No shell is involved.
function ConvertTo-NativeArgument {
  param([Parameter(Mandatory = $true)][AllowEmptyString()][string]$Value)
  if ($Value.Length -eq 0) { return '""' }
  if ($Value -notmatch '[\s"]') { return $Value }
  $sb = New-Object System.Text.StringBuilder
  [void]$sb.Append('"')
  $slashes = 0
  foreach ($ch in $Value.ToCharArray()) {
    if ($ch -eq '\') { $slashes++; continue }
    if ($ch -eq '"') {
      [void]$sb.Append(('\' * ($slashes * 2 + 1)) + '"')
      $slashes = 0
      continue
    }
    if ($slashes -gt 0) { [void]$sb.Append('\' * $slashes); $slashes = 0 }
    [void]$sb.Append($ch)
  }
  if ($slashes -gt 0) { [void]$sb.Append('\' * ($slashes * 2)) }
  [void]$sb.Append('"')
  return $sb.ToString()
}

function Start-HiddenPowerShell {
  param(
    [Parameter(Mandatory = $true)][string]$ScriptPath,
    [string[]]$ArgumentList = @(),
    [switch]$Wait,
    [int]$TimeoutSeconds = 0
  )
  $exe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  if (-not (Test-Path $exe)) { $exe = 'powershell.exe' }
  $parts = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (ConvertTo-NativeArgument $ScriptPath))
  foreach ($a in $ArgumentList) { $parts += (ConvertTo-NativeArgument $a) }
  return Start-HiddenProcess -FilePath $exe -Arguments ($parts -join ' ') -Wait:$Wait -TimeoutSeconds $TimeoutSeconds
}

# --- bounded waits, process trees, identity and heartbeats -----------------
#
# Everything in this block is either pure over a snapshot (so a test can replay
# it with synthetic data) or a thin wrapper around Win32_Process / Stop-Process.

function Wait-HiddenProcessExit {
  param(
    [Parameter(Mandatory = $true)]$Process,
    [int]$TimeoutSeconds = 0,
    [int]$TickSeconds = 20,
    [scriptblock]$OnTick = $null
  )
  # Waits in bounded slices so the caller can run a watchdog between them; a
  # -Wait with no slice is exactly what a hung child used to exploit. Timeout 0
  # means "no overall bound, but still tick" (a long-lived SSH forward).
  if ($TickSeconds -lt 1) { $TickSeconds = 1 }
  $startedAt = Get-Date
  while ($true) {
    if ($Process.WaitForExit($TickSeconds * 1000)) {
      return [pscustomobject]@{ ExitCode = $Process.ExitCode; TimedOut = $false; Stopped = 0; TreeGone = $true }
    }
    if ($null -ne $OnTick) {
      try { & $OnTick } catch { }
    }
    if ($TimeoutSeconds -gt 0 -and ((Get-Date) - $startedAt).TotalSeconds -ge $TimeoutSeconds) {
      $killed = Stop-ProcessTree -RootId $Process.Id
      return [pscustomobject]@{ ExitCode = -1; TimedOut = $true; Stopped = $killed.Stopped; TreeGone = $killed.Exited }
    }
  }
}

function Get-ProcessSnapshot {
  # pid -> identity, or $null when the platform cannot provide one. Win32_Process
  # is readable for the caller's own processes without elevation.
  try {
    $items = Get-CimInstance -ClassName Win32_Process -ErrorAction Stop |
      Select-Object ProcessId, ParentProcessId, Name, CreationDate, CommandLine, ExecutablePath
  } catch {
    return $null
  }
  $map = @{}
  foreach ($item in $items) {
    $map[[int]$item.ProcessId] = [pscustomobject]@{
      Pid            = [int]$item.ProcessId
      ParentId       = [int]$item.ParentProcessId
      Name           = [string]$item.Name
      StartedAt      = $item.CreationDate
      CommandLine    = [string]$item.CommandLine
      ExecutablePath = [string]$item.ExecutablePath
    }
  }
  return $map
}

function Get-ProcessParentMap {
  param($Snapshot)
  $map = @{}
  if ($null -eq $Snapshot) { return $map }
  foreach ($id in $Snapshot.Keys) { $map[[int]$id] = [int]$Snapshot[$id].ParentId }
  return $map
}

function Get-ProcessTreeOrder {
  # Leaf-first kill order: every child appears before its parent, so a dying
  # parent cannot re-parent a still-running ssh.exe out of the tree it was
  # supposed to take down.
  param(
    [Parameter(Mandatory = $true)][int]$RootId,
    [Parameter(Mandatory = $true)][hashtable]$ParentMap
  )
  $children = @{}
  foreach ($id in $ParentMap.Keys) {
    $parent = [int]$ParentMap[$id]
    if (-not $children.ContainsKey($parent)) { $children[$parent] = New-Object System.Collections.ArrayList }
    [void]$children[$parent].Add([int]$id)
  }
  $order = New-Object System.Collections.ArrayList
  $seen = @{}
  $queue = New-Object System.Collections.Queue
  $queue.Enqueue($RootId)
  while ($queue.Count -gt 0) {
    $id = [int]$queue.Dequeue()
    if ($seen.ContainsKey($id)) { continue }
    $seen[$id] = $true
    [void]$order.Add($id)
    if ($children.ContainsKey($id)) {
      foreach ($child in $children[$id]) { $queue.Enqueue([int]$child) }
    }
  }
  $ids = @($order.ToArray())
  [array]::Reverse($ids)
  return $ids
}

function Stop-ProcessTree {
  # Terminates one identified process and its descendants. It never selects a
  # target by image name: the caller passes a pid it has already verified.
  param(
    [Parameter(Mandatory = $true)][int]$RootId,
    [int]$WaitSeconds = 10,
    $Snapshot = $null
  )
  $map = $Snapshot
  if ($null -eq $map) { $map = Get-ProcessSnapshot }
  if ($null -eq $map) {
    # No snapshot (not Windows): only the caller-identified pid, never a match.
    $stoppedRoot = 0
    try { Stop-Process -Id $RootId -Force -ErrorAction Stop; $stoppedRoot = 1 } catch { }
    $gone = -not [bool](Get-Process -Id $RootId -ErrorAction SilentlyContinue)
    return [pscustomobject]@{ Stopped = $stoppedRoot; Exited = $gone }
  }
  $ids = Get-ProcessTreeOrder -RootId $RootId -ParentMap (Get-ProcessParentMap -Snapshot $map)
  $stopped = 0
  foreach ($id in $ids) {
    try { Stop-Process -Id $id -Force -ErrorAction Stop; $stopped += 1 } catch { }
  }
  $deadline = (Get-Date).AddSeconds($WaitSeconds)
  while ((Get-Date) -lt $deadline) {
    if (-not (Get-Process -Id $RootId -ErrorAction SilentlyContinue)) { break }
    Start-Sleep -Milliseconds 100
  }
  $gone = -not [bool](Get-Process -Id $RootId -ErrorAction SilentlyContinue)
  return [pscustomobject]@{ Stopped = $stopped; Exited = $gone }
}

function Get-ProcessIdentity {
  param([Parameter(Mandatory = $true)][int]$ProcessId, $Snapshot = $null)
  $map = $Snapshot
  if ($null -eq $map) { $map = Get-ProcessSnapshot }
  if ($null -eq $map) { return $null }
  if (-not $map.ContainsKey($ProcessId)) { return $null }
  return $map[$ProcessId]
}

function Test-ProcessIdentity {
  # $true only when the recorded identity still describes the live process:
  # same pid, same start time (1 s tolerance), same image when both are known
  # and, when given, a command line that matches. A recycled pid belongs to a
  # newer process, so it never passes and the watchdog refuses to kill it.
  param($Expected, $Actual, [string]$CommandLinePattern = '')
  if ($null -eq $Expected -or $null -eq $Actual) { return $false }
  if ([int]$Expected.Pid -ne [int]$Actual.Pid) { return $false }
  if ($null -eq $Expected.StartedAt -or $null -eq $Actual.StartedAt) { return $false }
  $skew = [Math]::Abs(([datetime]$Expected.StartedAt - [datetime]$Actual.StartedAt).TotalSeconds)
  if ($skew -gt 1) { return $false }
  if (-not [string]::IsNullOrWhiteSpace($Expected.Name) -and -not [string]::IsNullOrWhiteSpace($Actual.Name)) {
    if ($Expected.Name -ne $Actual.Name) { return $false }
  }
  if (-not [string]::IsNullOrWhiteSpace($CommandLinePattern)) {
    if ([string]::IsNullOrWhiteSpace($Actual.CommandLine)) { return $false }
    if ($Actual.CommandLine -notmatch $CommandLinePattern) { return $false }
  }
  return $true
}

function Write-Heartbeat {
  # One line, last-writer-wins: the mtime is the liveness signal and the text
  # carries the identity the watchdog must verify before it kills anything.
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][AllowEmptyString()][string]$Text
  )
  try {
    $dir = Split-Path -Parent $Path
    if (-not [string]::IsNullOrWhiteSpace($dir) -and -not (Test-Path -LiteralPath $dir)) {
      New-Item -ItemType Directory -Force -Path $dir | Out-Null
    }
    [IO.File]::WriteAllText($Path, $Text, (New-Object Text.UTF8Encoding($false)))
    return $true
  } catch {
    return $false
  }
}

function Read-Heartbeat {
  # Parses '<time> pid=<n> [started=<iso>] ...'. Age is clamped at 0 so a clock
  # step backwards cannot make a dead heartbeat look fresh for ever.
  param([Parameter(Mandatory = $true)][string]$Path)
  $result = [pscustomobject]@{ Present = $false; AgeSeconds = $null; Pid = 0; StartedAt = $null; Raw = '' }
  if (-not (Test-Path -LiteralPath $Path)) { return $result }
  try {
    $result.Raw = (Get-Content -LiteralPath $Path -Raw -ErrorAction Stop).Trim()
    $age = ((Get-Date) - (Get-Item -LiteralPath $Path).LastWriteTime).TotalSeconds
  } catch {
    return $result
  }
  $result.Present = $true
  if ($age -lt 0) { $age = 0 }
  $result.AgeSeconds = $age
  if ($result.Raw -match 'pid=(\d+)') { $result.Pid = [int]$Matches[1] }
  if ($result.Raw -match 'started=(\S+)') {
    try { $result.StartedAt = [datetime]::Parse($Matches[1], [Globalization.CultureInfo]::InvariantCulture) } catch { $result.StartedAt = $null }
  }
  return $result
}

function Get-HeartbeatPolicy {
  # Thresholds derived from the upload's own bound, never below it: a watchdog
  # that fires inside a legitimate transfer turns a slow upload into a restart
  # loop. Stale = bound + one idle interval + margin. The startup grace sits
  # above the stale threshold: a fresh loop writes its first heartbeat only
  # after its first upload finished, and an old file may still be on disk.
  param(
    [int]$OperationTimeoutSeconds = 120,
    [int]$IntervalSeconds = 20,
    [int]$MarginSeconds = 30,
    [int]$StaleSeconds = 0,
    [int]$StartupGraceSeconds = 0
  )
  $staleFloor = $OperationTimeoutSeconds + $IntervalSeconds + $MarginSeconds
  $stale = $staleFloor
  if ($StaleSeconds -gt 0) { $stale = [Math]::Max($StaleSeconds, $staleFloor) }
  $graceFloor = $staleFloor + $IntervalSeconds
  $grace = $graceFloor
  if ($StartupGraceSeconds -gt 0) { $grace = [Math]::Max($StartupGraceSeconds, $graceFloor) }
  return [pscustomobject]@{
    OperationTimeoutSeconds = $OperationTimeoutSeconds
    IntervalSeconds         = $IntervalSeconds
    StaleSeconds            = $stale
    StartupGraceSeconds     = $grace
  }
}

function Test-WatchdogAction {
  # Turns "mutex held? heartbeat age?" into one decision. Restarts are gated by
  # the backoff window and by the startup grace, so a supervisor that is itself
  # just starting, or that just restarted the loop, cannot spawn a storm.
  #   none    : leave it alone (healthy, in grace, or in backoff)
  #   restart : no live owner (mutex gone) - start one
  #   reclaim : owner is held but the heartbeat is stale - verify, kill, restart
  param(
    [bool]$MutexPresent = $false,
    $Heartbeat = $null,
    [int]$StaleSeconds = 210,
    [int]$StartupGraceSeconds = 160,
    [double]$SupervisorAgeSeconds = 0,
    [double]$SinceLastRestartSeconds = -1,
    [int]$MinSecondsBetweenRestarts = 60
  )
  $fresh = $false
  if ($null -ne $Heartbeat -and $Heartbeat.Present -and $null -ne $Heartbeat.AgeSeconds) {
    if ([double]$Heartbeat.AgeSeconds -le $StaleSeconds) { $fresh = $true }
  }
  if ($fresh) {
    return [pscustomobject]@{ Action = 'none'; Reason = ('heartbeat fresh ({0:N0}s)' -f [double]$Heartbeat.AgeSeconds) }
  }
  if ($SinceLastRestartSeconds -ge 0 -and $SinceLastRestartSeconds -lt $MinSecondsBetweenRestarts) {
    return [pscustomobject]@{ Action = 'none'; Reason = ('backoff ({0:N0}s since last restart)' -f $SinceLastRestartSeconds) }
  }
  if ($SupervisorAgeSeconds -lt $StartupGraceSeconds) {
    return [pscustomobject]@{ Action = 'none'; Reason = ('startup grace ({0:N0}s of {1}s)' -f $SupervisorAgeSeconds, $StartupGraceSeconds) }
  }
  if ($null -eq $Heartbeat -or -not $Heartbeat.Present) {
    return [pscustomobject]@{ Action = 'restart'; Reason = 'no heartbeat file' }
  }
  if ($MutexPresent) {
    return [pscustomobject]@{ Action = 'reclaim'; Reason = ('heartbeat stale ({0:N0}s)' -f [double]$Heartbeat.AgeSeconds) }
  }
  return [pscustomobject]@{ Action = 'restart'; Reason = ('heartbeat stale ({0:N0}s), no owner' -f [double]$Heartbeat.AgeSeconds) }
}

# Retry ramp for an offline VM: 5, 10, 20, 40, 60, 60 ... s. The caller resets
# -Current to -Start once a forward stayed healthy, so a flapping VM ramps again
# from 5 s instead of from 60 s. Pure arithmetic: replayable by a test.
function Get-NextRetryDelay {
  param([int]$Current, [int]$Start = 5, [int]$Max = 60)
  if ($Current -lt $Start) { $Current = $Start }
  if ($Current -gt $Max) { $Current = $Max }
  return [pscustomobject]@{ Delay = $Current; Next = [Math]::Min($Current * 2, $Max) }
}

# Cross-process liveness probe for the chain's single-instance mutexes.
# $true  : a live process owns the mutex (do not start a duplicate)
# $false : nobody owns it (start one)
# $null  : the probe itself failed (unknown - the caller decides, never assume dead)
function Test-ProcessMutex {
  param([Parameter(Mandatory = $true)][string]$Name)
  try {
    $m = [System.Threading.Mutex]::OpenExisting($Name)
    $m.Dispose()
    return $true
  } catch [System.Threading.WaitHandleCannotBeOpenedException] {
    return $false
  } catch {
    return $null
  }
}

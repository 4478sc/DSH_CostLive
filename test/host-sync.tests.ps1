# Regression tests for the windowless host->VM sync chain (2026-11-16).
#
# Windows-targeted: the launcher, the mutex probe and the VBS entry only exist on
# Windows. The argument-quoting, retry-ramp and encoding cases are pure string
# work and run on any platform with PowerShell, so the file degrades to a partial
# run instead of a false failure elsewhere.
#
# Run: npm run test:ps
#   or: powershell -NoProfile -ExecutionPolicy Bypass -File test/host-sync.tests.ps1
# Exit code 0 = every executed case passed. No Pester dependency.

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$Tools = Join-Path $Root 'tools'
$Helper = Join-Path $Tools 'hidden-launch.ps1'
$Dash = Join-Path $Tools 'vm-dashboard.ps1'
$Ensure = Join-Path $Tools 'ensure-host-sync.ps1'
$Vbs = Join-Path $Tools 'launch-hidden.vbs'
$OnWindows = ($env:OS -eq 'Windows_NT') -or ([Environment]::OSVersion.Platform -eq 'Win32NT')

$script:Passed = 0
$script:Failed = 0
$script:Skipped = 0

function Pass([string]$Name) {
  $script:Passed += 1
  Write-Host ('ok   ' + $Name)
}
function Fail([string]$Name, [string]$Detail = '') {
  $script:Failed += 1
  $text = 'FAIL ' + $Name
  if ($Detail -ne '') { $text += ' [' + $Detail + ']' }
  Write-Host $text
}
function Skip([string]$Name, [string]$Reason) {
  $script:Skipped += 1
  Write-Host ('skip ' + $Name + ' (' + $Reason + ')')
}
function Assert-True($Condition, [string]$Name) {
  if ($Condition) { Pass $Name } else { Fail $Name 'expected true' }
}
function Assert-Equal($Actual, $Expected, [string]$Name) {
  if ([string]$Actual -ceq [string]$Expected) {
    Pass $Name
  } else {
    Fail $Name ('expected [' + [string]$Expected + '] got [' + [string]$Actual + ']')
  }
}

$Temp = Join-Path ([IO.Path]::GetTempPath()) ('costlive-sync-test-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $Temp -Force | Out-Null
# Stray processes a timeout test may leave behind if the kill itself failed.
$script:StrayPids = @()

try {
  # --- files and encoding -------------------------------------------------
  Assert-True (Test-Path $Helper) 'tools/hidden-launch.ps1 ships with the repo'
  Assert-True (Test-Path $Vbs) 'tools/launch-hidden.vbs ships with the repo'

  foreach ($file in @($Helper, $Dash, $Ensure)) {
    $parseErrors = $null
    [void][System.Management.Automation.Language.Parser]::ParseFile($file, [ref]$null, [ref]$parseErrors)
    $count = 0
    if ($null -ne $parseErrors) { $count = $parseErrors.Count }
    Assert-Equal $count 0 ('parses without errors: ' + (Split-Path -Leaf $file))
    $bytes = [IO.File]::ReadAllBytes($file)
    $nonAscii = @($bytes | Where-Object { $_ -gt 127 })
    Assert-Equal $nonAscii.Count 0 ('ASCII only (PowerShell 5.1 reads BOM-less as ANSI): ' + (Split-Path -Leaf $file))
  }

  # The chain must load the helper from the repo, never from the push loop's
  # directory: a self-contained checkout is the whole point of shipping it.
  $dashText = [IO.File]::ReadAllText($Dash)
  $ensureText = [IO.File]::ReadAllText($Ensure)
  Assert-True ($dashText -match 'Join-Path \$PSScriptRoot ''hidden-launch\.ps1''') 'vm-dashboard loads the in-repo helper'
  Assert-True ($dashText -notmatch 'Split-Path -Parent \$PushLoop') 'vm-dashboard does not resolve a helper next to pushLoop'
  Assert-True ($ensureText -match 'Join-Path \$PSScriptRoot ''hidden-launch\.ps1''') 'ensure-host-sync loads the in-repo helper'

  . $Helper
  foreach ($name in @('New-HiddenStartInfo', 'Start-HiddenProcess', 'Start-HiddenPowerShell', 'Wait-HiddenProcessExit', 'ConvertTo-NativeArgument', 'Test-ProcessMutex', 'Get-NextRetryDelay', 'Get-ProcessSnapshot', 'Get-ProcessParentMap', 'Get-ProcessTreeOrder', 'Stop-ProcessTree', 'Get-ProcessIdentity', 'Test-ProcessIdentity', 'Write-Heartbeat', 'Read-Heartbeat', 'Get-HeartbeatPolicy', 'Test-WatchdogAction')) {
    Assert-True ($null -ne (Get-Command -Name $name -ErrorAction SilentlyContinue)) ('helper exports ' + $name)
  }

  # --- argument quoting (portable) ---------------------------------------
  Assert-Equal (ConvertTo-NativeArgument '') '""' 'quote: empty string'
  Assert-Equal (ConvertTo-NativeArgument 'plain') 'plain' 'quote: no special characters'
  Assert-Equal (ConvertTo-NativeArgument 'C:\Program Files\a.ps1') '"C:\Program Files\a.ps1"' 'quote: space'
  Assert-Equal (ConvertTo-NativeArgument 'C:\a b\') '"C:\a b\\"' 'quote: space and trailing backslash'
  Assert-Equal (ConvertTo-NativeArgument 'a"b') '"a\"b"' 'quote: embedded quote'
  Assert-Equal (ConvertTo-NativeArgument 'a b"c d') '"a b\"c d"' 'quote: space and embedded quote'
  Assert-Equal (ConvertTo-NativeArgument 'x\ y') '"x\ y"' 'quote: backslash before space'
  Assert-Equal (ConvertTo-NativeArgument '\\server\share') '\\server\share' 'quote: UNC path without spaces'
  Assert-Equal (ConvertTo-NativeArgument '\\server\my share\') '"\\server\my share\\"' 'quote: UNC path with spaces and trailing backslash'

  # --- retry ramp (portable) ---------------------------------------------
  $delays = @()
  $current = 5
  for ($i = 0; $i -lt 6; $i += 1) {
    $step = Get-NextRetryDelay -Current $current -Start 5 -Max 60
    $delays += $step.Delay
    $current = $step.Next
  }
  Assert-Equal ($delays -join ',') '5,10,20,40,60,60' 'retry ramp: 5,10,20,40,60,60'
  Assert-Equal (Get-NextRetryDelay -Current 0 -Start 5 -Max 60).Delay 5 'retry ramp: clamps below Start'
  Assert-Equal (Get-NextRetryDelay -Current 600 -Start 5 -Max 60).Delay 60 'retry ramp: clamps above Max'
  Assert-Equal (Get-NextRetryDelay -Current 60 -Start 5 -Max 60).Next 60 'retry ramp: stays capped'

  # --- process tree order (portable) --------------------------------------
  $parentMap = @{ 1 = 0; 2 = 1; 3 = 1; 4 = 2; 5 = 4 }
  $order = Get-ProcessTreeOrder -RootId 1 -ParentMap $parentMap
  Assert-Equal $order.Count 5 'tree order: every process of the tree is listed once'
  $limits = @{}
  for ($i = 0; $i -lt $order.Count; $i += 1) { $limits[[int]$order[$i]] = $i }
  $childrenFirst = $true
  foreach ($id in @(2, 3, 4, 5)) {
    if (-not ($limits[$id] -lt $limits[[int]$parentMap[$id]])) { $childrenFirst = $false }
  }
  Assert-True $childrenFirst 'tree order: every child is killed before its parent'
  Assert-Equal $order[$order.Count - 1] 1 'tree order: the root is killed last'
  Assert-Equal ((Get-ProcessTreeOrder -RootId 99 -ParentMap $parentMap) -join ',') '99' 'tree order: an unknown root yields only itself'
  Assert-Equal ((Get-ProcessTreeOrder -RootId 1 -ParentMap @{}) -join ',') '1' 'tree order: an empty map yields only the root'
  $cycleMap = @{ 1 = 2; 2 = 1 }
  Assert-Equal ((Get-ProcessTreeOrder -RootId 1 -ParentMap $cycleMap | Sort-Object) -join ',') '1,2' 'tree order: a parent cycle terminates'

  # --- process identity (portable) ----------------------------------------
  $expectedIdentity = [pscustomobject]@{ Pid = 42; StartedAt = [datetime]'2026-11-18T23:25:10'; Name = 'ssh.exe' }
  $sameIdentity = [pscustomobject]@{ Pid = 42; StartedAt = [datetime]'2026-11-18T23:25:10.400'; Name = 'ssh.exe'; CommandLine = 'ssh.exe -i key host tar -xzf x' }
  Assert-True (Test-ProcessIdentity -Expected $expectedIdentity -Actual $sameIdentity) 'identity: same pid and start time matches'
  $recycledIdentity = [pscustomobject]@{ Pid = 42; StartedAt = [datetime]'2026-11-19T01:00:00'; Name = 'ssh.exe'; CommandLine = 'ssh.exe other' }
  Assert-True (-not (Test-ProcessIdentity -Expected $expectedIdentity -Actual $recycledIdentity)) 'identity: a recycled pid (newer start time) is rejected'
  $otherImage = [pscustomobject]@{ Pid = 42; StartedAt = [datetime]'2026-11-18T23:25:10'; Name = 'notepad.exe'; CommandLine = 'notepad.exe x' }
  Assert-True (-not (Test-ProcessIdentity -Expected $expectedIdentity -Actual $otherImage)) 'identity: a different image is rejected'
  Assert-True (-not (Test-ProcessIdentity -Expected $expectedIdentity -Actual $null)) 'identity: a missing process is rejected'
  Assert-True (-not (Test-ProcessIdentity -Expected $null -Actual $sameIdentity)) 'identity: no recorded identity never matches'
  Assert-True (-not (Test-ProcessIdentity -Expected $expectedIdentity -Actual $sameIdentity -CommandLinePattern 'push-loop\.ps1')) 'identity: a command line that does not match is rejected'
  Assert-True (Test-ProcessIdentity -Expected $expectedIdentity -Actual $sameIdentity -CommandLinePattern 'tar -xzf') 'identity: a matching command line is accepted'
  $noStart = [pscustomobject]@{ Pid = 42; StartedAt = $null; Name = 'ssh.exe'; CommandLine = 'ssh.exe x' }
  Assert-True (-not (Test-ProcessIdentity -Expected $expectedIdentity -Actual $noStart)) 'identity: a process with no start time is rejected'

  # --- heartbeat thresholds and decisions (portable) ----------------------
  $policy = Get-HeartbeatPolicy -OperationTimeoutSeconds 120 -IntervalSeconds 20 -MarginSeconds 30
  Assert-Equal $policy.StaleSeconds 170 'policy: stale = upload bound + interval + margin'
  Assert-True ($policy.StaleSeconds -gt $policy.OperationTimeoutSeconds) 'policy: stale stays above a legitimate bounded upload'
  Assert-True ($policy.StartupGraceSeconds -gt $policy.StaleSeconds) 'policy: startup grace sits above the stale threshold'
  Assert-True ($policy.StartupGraceSeconds -gt $policy.OperationTimeoutSeconds) 'policy: startup grace stays above a legitimate bounded upload'
  Assert-Equal (Get-HeartbeatPolicy -OperationTimeoutSeconds 120 -IntervalSeconds 20 -StaleSeconds 30).StaleSeconds 170 'policy: a too-small stale override is raised to the floor'
  Assert-Equal (Get-HeartbeatPolicy -OperationTimeoutSeconds 120 -IntervalSeconds 20 -StaleSeconds 600).StaleSeconds 600 'policy: a larger stale override is kept'
  Assert-Equal (Get-HeartbeatPolicy -OperationTimeoutSeconds 120 -IntervalSeconds 20 -StartupGraceSeconds 10).StartupGraceSeconds 190 'policy: a too-small grace override is raised to the floor'

  $freshBeat = [pscustomobject]@{ Present = $true; AgeSeconds = 5.0; Pid = 19136; StartedAt = [datetime]'2026-11-18T18:43:06' }
  $staleBeat = [pscustomobject]@{ Present = $true; AgeSeconds = 6000.0; Pid = 38640; StartedAt = [datetime]'2026-11-18T23:25:10' }
  $missingBeat = [pscustomobject]@{ Present = $false; AgeSeconds = $null; Pid = 0; StartedAt = $null }

  Assert-Equal (Test-WatchdogAction -MutexPresent $true -Heartbeat $freshBeat -SupervisorAgeSeconds 3600).Action 'none' 'watchdog: a fresh heartbeat is left alone'
  Assert-Equal (Test-WatchdogAction -MutexPresent $false -Heartbeat $freshBeat -SupervisorAgeSeconds 3600).Action 'none' 'watchdog: a fresh heartbeat suppresses a second start even without a mutex'
  Assert-Equal (Test-WatchdogAction -MutexPresent $true -Heartbeat $staleBeat -SupervisorAgeSeconds 3600).Action 'reclaim' 'watchdog: a stale heartbeat with a held mutex is reclaimed'
  Assert-Equal (Test-WatchdogAction -MutexPresent $false -Heartbeat $staleBeat -SupervisorAgeSeconds 3600).Action 'restart' 'watchdog: a stale heartbeat with no owner restarts the loop'
  Assert-Equal (Test-WatchdogAction -MutexPresent $true -Heartbeat $missingBeat -SupervisorAgeSeconds 10).Action 'none' 'watchdog: a missing heartbeat inside the startup grace does nothing'
  Assert-Equal (Test-WatchdogAction -MutexPresent $true -Heartbeat $missingBeat -SupervisorAgeSeconds 600).Action 'restart' 'watchdog: a missing heartbeat after the startup grace restarts the loop'
  Assert-Equal (Test-WatchdogAction -MutexPresent $true -Heartbeat $staleBeat -SupervisorAgeSeconds 3600 -SinceLastRestartSeconds 5 -MinSecondsBetweenRestarts 60).Action 'none' 'watchdog: backoff suppresses a restart storm'
  Assert-Equal (Test-WatchdogAction -MutexPresent $true -Heartbeat $staleBeat -SupervisorAgeSeconds 3600 -SinceLastRestartSeconds 120 -MinSecondsBetweenRestarts 60).Action 'reclaim' 'watchdog: the reclaim is allowed once the backoff window passed'
  Assert-Equal (Test-WatchdogAction -MutexPresent $false -Heartbeat $missingBeat -SupervisorAgeSeconds 3600).Action 'restart' 'watchdog: no heartbeat file and no owner restarts the loop'

  if (-not $OnWindows) {
    Skip 'start-info flags' 'Windows only'
    Skip 'exit code and spaced path' 'Windows only'
    Skip 'single instance mutex' 'Windows only'
    Skip 'VBS entry' 'Windows only'
    Skip 'missing helper message' 'Windows only'
  } else {
    # --- windowless start flags ------------------------------------------
    $psi = New-HiddenStartInfo -FilePath 'cmd.exe' -Arguments '/c echo hi'
    Assert-Equal $psi.UseShellExecute $false 'start info: UseShellExecute=false'
    Assert-Equal $psi.CreateNoWindow $true 'start info: CreateNoWindow=true'
    Assert-Equal $psi.FileName 'cmd.exe' 'start info: file name'
    Assert-Equal $psi.Arguments '/c echo hi' 'start info: arguments'

    # --- exit code, spaced path, arguments with spaces -------------------
    $spaced = Join-Path $Temp 'dir with space'
    New-Item -ItemType Directory -Path $spaced -Force | Out-Null
    $probe = Join-Path $spaced 'probe.ps1'
    $probeBody = @'
param([string]$OutPath, [string]$First, [string]$Second)
[IO.File]::WriteAllText($OutPath, ($First + '|' + $Second))
exit 7
'@
    [IO.File]::WriteAllText($probe, $probeBody, (New-Object Text.UTF8Encoding($false)))
    $outFile = Join-Path $spaced 'probe.out'
    $run = Start-HiddenPowerShell -ScriptPath $probe -ArgumentList @('-OutPath', $outFile, '-First', 'a b', '-Second', 'c  d') -Wait -TimeoutSeconds 60
    Assert-Equal $run.ExitCode 7 'hidden PowerShell passes the exit code through'
    Assert-Equal $run.TimedOut $false 'hidden PowerShell returns before the timeout'
    $probeOutput = ''
    if (Test-Path $outFile) { $probeOutput = [IO.File]::ReadAllText($outFile) }
    Assert-Equal $probeOutput 'a b|c  d' 'hidden PowerShell keeps spaced arguments and a spaced script path'

    # --- single instance mutex -------------------------------------------
    $mutexName = 'CostLiveTest_' + [guid]::NewGuid().ToString('N')
    Assert-Equal (Test-ProcessMutex -Name $mutexName) $false 'mutex: absent reports false'
    $holder = Join-Path $Temp 'mutex-holder.ps1'
    $holderBody = @'
param([string]$Name)
$m = New-Object System.Threading.Mutex($false, $Name)
[void]$m.WaitOne(0)
Start-Sleep -Seconds 60
'@
    [IO.File]::WriteAllText($holder, $holderBody, (New-Object Text.UTF8Encoding($false)))
    $holderProc = Start-HiddenPowerShell -ScriptPath $holder -ArgumentList @('-Name', $mutexName)
    $held = $false
    for ($i = 0; $i -lt 100; $i += 1) {
      if (Test-ProcessMutex -Name $mutexName) { $held = $true; break }
      Start-Sleep -Milliseconds 100
    }
    Assert-True $held 'mutex: held by another process reports true'
    try { $holderProc.Kill() } catch { }
    $released = $false
    for ($i = 0; $i -lt 100; $i += 1) {
      if (-not (Test-ProcessMutex -Name $mutexName)) { $released = $true; break }
      Start-Sleep -Milliseconds 100
    }
    Assert-True $released 'mutex: released after the holder exits'

    # --- heartbeat file parsing -------------------------------------------
    $beatFile = Join-Path $Temp 'push-loop.heartbeat'
    Assert-Equal (Read-Heartbeat -Path $beatFile).Present $false 'heartbeat: a missing file reports Present=false'
    Assert-Equal (Read-Heartbeat -Path $beatFile).Pid 0 'heartbeat: a missing file reports no pid'
    $beatText = '2026-11-19 01:06:48 pid=19136 started=2026-11-18T18:43:06.0187211+08:00 exit=0 next=20s'
    Assert-True (Write-Heartbeat -Path $beatFile -Text $beatText) 'heartbeat: write succeeds and creates the directory'
    $beat = Read-Heartbeat -Path $beatFile
    Assert-Equal $beat.Present $true 'heartbeat: an existing file reports Present=true'
    Assert-Equal $beat.Pid 19136 'heartbeat: pid is parsed'
    Assert-True ($null -ne $beat.StartedAt) 'heartbeat: the recorded start time is parsed'
    Assert-Equal ([int]$beat.StartedAt.Year) 2026 'heartbeat: the parsed start time is a real date'
    Assert-True ($beat.AgeSeconds -ge 0 -and $beat.AgeSeconds -lt 120) 'heartbeat: age is measured from the file mtime'
    Assert-Equal $beat.Raw $beatText 'heartbeat: the raw line is kept for the log'

    # --- bounded wait kills the child and the grandchild ------------------
    $treeDir = Join-Path $Temp 'tree'
    New-Item -ItemType Directory -Path $treeDir -Force | Out-Null
    $grandchildBody = @'
param([string]$MarkerDir)
[IO.File]::WriteAllText((Join-Path $MarkerDir 'grandchild.pid'), [string]$PID)
Start-Sleep -Seconds 120
'@
    [IO.File]::WriteAllText((Join-Path $treeDir 'grandchild.ps1'), $grandchildBody, (New-Object Text.UTF8Encoding($false)))
    $childBody = @'
param([string]$Helper, [string]$MarkerDir)
. $Helper
$exe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$gc = Start-HiddenProcess -FilePath $exe -Arguments ('-NoProfile -ExecutionPolicy Bypass -File "' + (Join-Path $MarkerDir 'grandchild.ps1') + '" -MarkerDir "' + $MarkerDir + '"')
[IO.File]::WriteAllText((Join-Path $MarkerDir 'child.pid'), [string]$PID)
[IO.File]::WriteAllText((Join-Path $MarkerDir 'grandchild.pid'), [string]$gc.Id)
Start-Sleep -Seconds 120
'@
    [IO.File]::WriteAllText((Join-Path $treeDir 'child.ps1'), $childBody, (New-Object Text.UTF8Encoding($false)))
    $childPid = 0
    $grandPid = 0
    $run = Start-HiddenPowerShell -ScriptPath (Join-Path $treeDir 'child.ps1') -ArgumentList @('-Helper', $Helper, '-MarkerDir', $treeDir) -Wait -TimeoutSeconds 6
    Assert-Equal $run.TimedOut $true 'bounded wait: a hung child times out instead of blocking for ever'
    Assert-Equal $run.ExitCode -1 'bounded wait: a timeout reports exit -1'
    for ($i = 0; $i -lt 100; $i += 1) {
      $childFile = Join-Path $treeDir 'child.pid'
      $grandFile = Join-Path $treeDir 'grandchild.pid'
      if ((Test-Path $childFile) -and (Test-Path $grandFile)) {
        $childPid = [int]((Get-Content $childFile -Raw).Trim())
        $grandPid = [int]((Get-Content $grandFile -Raw).Trim())
        break
      }
      Start-Sleep -Milliseconds 100
    }
    Assert-True ($childPid -gt 0 -and $grandPid -gt 0) 'bounded wait: the stub reported both pids'
    $script:StrayPids = @($childPid, $grandPid)
    $childGone = $false
    $grandGone = $false
    for ($i = 0; $i -lt 100; $i += 1) {
      $childGone = -not [bool](Get-Process -Id $childPid -ErrorAction SilentlyContinue)
      $grandGone = -not [bool](Get-Process -Id $grandPid -ErrorAction SilentlyContinue)
      if ($childGone -and $grandGone) { break }
      Start-Sleep -Milliseconds 100
    }
    Assert-True $childGone 'bounded wait: the timed-out child is gone'
    Assert-True $grandGone 'bounded wait: the grandchild is gone too (tree kill, not just the direct child)'

    # --- tree kill takes descendants, and only them -----------------------
    $keepDir = Join-Path $treeDir 'keep'
    New-Item -ItemType Directory -Path $keepDir -Force | Out-Null
    $keeper = Start-HiddenPowerShell -ScriptPath (Join-Path $treeDir 'grandchild.ps1') -ArgumentList @('-MarkerDir', $keepDir)
    $keeperPid = $keeper.Id
    $snapshot = Get-ProcessSnapshot
    Assert-True ($null -ne $snapshot) 'snapshot: Win32_Process is readable for the caller own processes'
    if ($null -ne $snapshot) {
      $order = Get-ProcessTreeOrder -RootId $keeperPid -ParentMap (Get-ProcessParentMap -Snapshot $snapshot)
      Assert-Equal ($order[$order.Count - 1]) $keeperPid 'snapshot: the root is killed last'
      $killed = Stop-ProcessTree -RootId $keeperPid -Snapshot $snapshot
      Assert-True ($killed.Stopped -ge 1) 'tree kill: reports at least one stopped process'
      Assert-True $killed.Exited 'tree kill: the root is gone afterwards'
    } else {
      try { $keeper.Kill() } catch { }
    }


    # --- VBS entry --------------------------------------------------------
    $cscript = Join-Path $env:SystemRoot 'System32\cscript.exe'
    $wscript = Join-Path $env:SystemRoot 'System32\wscript.exe'
    if ((Test-Path $cscript) -and (Test-Path $wscript)) {
      & $cscript //nologo $Vbs 2>&1 | Out-Null
      Assert-Equal $LASTEXITCODE 2 'launch-hidden.vbs without arguments exits 2'
      $vbsProbe = Join-Path $Temp 'vbs-probe.ps1'
      $vbsProbeBody = @'
param([string]$OutPath, [string]$Label)
[IO.File]::WriteAllText($OutPath, ('vbs:' + $Label))
'@
      [IO.File]::WriteAllText($vbsProbe, $vbsProbeBody, (New-Object Text.UTF8Encoding($false)))
      $vbsOut = Join-Path $Temp 'vbs.out'
      & $wscript //nologo //B $Vbs $vbsProbe '-OutPath' $vbsOut '-Label' 'a b'
      $vbStarted = $false
      for ($i = 0; $i -lt 200; $i += 1) {
        if (Test-Path $vbsOut) { $vbStarted = $true; break }
        Start-Sleep -Milliseconds 100
      }
      Assert-True $vbStarted 'launch-hidden.vbs starts the target script'
      $vbsText = ''
      if ($vbStarted) { $vbsText = [IO.File]::ReadAllText($vbsOut) }
      Assert-Equal $vbsText 'vbs:a b' 'launch-hidden.vbs forwards arguments containing spaces'
    } else {
      Skip 'VBS entry' 'cscript/wscript not present'
    }

    # --- actionable error when the helper is missing ----------------------
    $fakeRepo = Join-Path $Temp 'repo without helper'
    $fakeTools = Join-Path $fakeRepo 'tools'
    $fakeConfig = Join-Path $fakeRepo 'config'
    New-Item -ItemType Directory -Path $fakeTools -Force | Out-Null
    New-Item -ItemType Directory -Path $fakeConfig -Force | Out-Null
    Copy-Item $Ensure (Join-Path $fakeTools 'ensure-host-sync.ps1') -Force
    $fakeJson = '{ "host": "127.0.0.1", "user": "tester", "keyPath": "key", "pushLoop": "loop.ps1" }'
    [IO.File]::WriteAllText((Join-Path $fakeConfig 'vm-dashboard.local.json'), $fakeJson, (New-Object Text.UTF8Encoding($false)))
    $pwshExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $errorText = ''
    try {
      $errorText = (& $pwshExe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $fakeTools 'ensure-host-sync.ps1') 2>&1 | Out-String)
    } catch {
      $errorText = $_.Exception.Message
    }
    Assert-True ($errorText -match 'Missing windowless launcher helper') 'missing helper fails with the repo path in the message'
    Assert-True ($errorText -notmatch 'WindowStyle Hidden') 'missing helper does not fall back to a console window'
  }
} finally {
  foreach ($stray in $script:StrayPids) {
    if ($stray -gt 0) { try { Stop-Process -Id $stray -Force -ErrorAction SilentlyContinue } catch { } }
  }
  Remove-Item -LiteralPath $Temp -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host ''
Write-Host ('passed=' + $script:Passed + ' failed=' + $script:Failed + ' skipped=' + $script:Skipped)
if ($script:Failed -gt 0) { exit 1 }
exit 0

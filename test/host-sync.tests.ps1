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
  foreach ($name in @('New-HiddenStartInfo', 'Start-HiddenProcess', 'Start-HiddenPowerShell', 'ConvertTo-NativeArgument', 'Test-ProcessMutex', 'Get-NextRetryDelay')) {
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
  Remove-Item -LiteralPath $Temp -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host ''
Write-Host ('passed=' + $script:Passed + ' failed=' + $script:Failed + ' skipped=' + $script:Skipped)
if ($script:Failed -gt 0) { exit 1 }
exit 0

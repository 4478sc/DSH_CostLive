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
      try { $proc.Kill() } catch { }
      return [pscustomobject]@{ ExitCode = -1; TimedOut = $true }
    }
  } else {
    $proc.WaitForExit()
  }
  return [pscustomobject]@{ ExitCode = $proc.ExitCode; TimedOut = $false }
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

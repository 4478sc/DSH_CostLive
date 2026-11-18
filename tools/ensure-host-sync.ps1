# Keep the dashboard's two background mirrors alive.
#
# Idempotent: tools\start-sync.ps1 reuses a loop that is still running, so this
# script is safe to call from the launcher and from a short-interval scheduled
# task (for example every 5 minutes) that heals a loop that died.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\ensure-host-sync.ps1
param(
  [string]$Repo = ''
)

$ErrorActionPreference = 'Continue'
if ([string]::IsNullOrWhiteSpace($Repo)) { $Repo = Split-Path -Parent $PSScriptRoot }
$Repo = [IO.Path]::GetFullPath($Repo)

# VM-backed deployment: keep the forward and host uploader alive; no local accounting.
# This is the single supervisor entry the scheduled tasks call: it never starts a
# second uploader by itself (vm-dashboard.ps1 probes the loop's mutex first).
if (Test-Path (Join-Path $Repo 'config/vm-dashboard.local.json')) {
  $dashboard = Join-Path $PSScriptRoot 'vm-dashboard.ps1'
  # Windowless: the launcher helper ships with the repo, so no deployment has to
  # add a file of its own and no absolute path is required. A missing helper is a
  # broken install, not a reason to fall back to a console window: say so and stop.
  $helper = Join-Path $PSScriptRoot 'hidden-launch.ps1'
  if (-not (Test-Path $helper)) { throw ('Missing windowless launcher helper: ' + $helper) }
  . $helper
  # Bounded: a scheduled task must not sit for ever behind a supervisor that is
  # itself stuck. The timeout path kills the whole tree (including ssh/scp
  # children) instead of only the direct child.
  $run = Start-HiddenPowerShell -ScriptPath $dashboard -ArgumentList @('-Ensure') -Wait -TimeoutSeconds 120
  if ($null -eq $run.ExitCode) { exit 1 }
  if ($run.TimedOut) { throw 'vm-dashboard -Ensure did not finish within 120 s' }
  exit ([int]$run.ExitCode)
}

$startSync = Join-Path $PSScriptRoot 'start-sync.ps1'
$outDir = Join-Path $Repo 'out'
$mirror = Join-Path (Split-Path -Parent $Repo) '.dsh-vm'
$store = Join-Path (Split-Path -Parent $Repo) '.opencode-usage'
$logPath = Join-Path $outDir 'ensure-sync.log'

New-Item -ItemType Directory -Force $outDir | Out-Null

function Note([string]$text) {
  ("[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $text) | Add-Content -Path $logPath -Encoding utf8
}

if (-not (Test-Path $startSync)) { Note "missing launcher: $startSync"; exit 2 }

& powershell -NoProfile -ExecutionPolicy Bypass -File $startSync -Label vm-sync -Cmd (Join-Path $Repo 'dsh-cost-vm-sync.cmd') -LockPath (Join-Path $outDir 'vm-sync.pid') -HeartbeatPath (Join-Path $mirror '.sync-state') 2>&1 | ForEach-Object { Note ("vm-sync: " + $_) }
& powershell -NoProfile -ExecutionPolicy Bypass -File $startSync -Label opencode -Cmd (Join-Path $Repo 'dsh-cost-opencode-sync.cmd') -LockPath (Join-Path $outDir 'opencode-sync.pid') 2>&1 | ForEach-Object { Note ("opencode: " + $_) }

# Surface a silently stalled archive in the log (the page shows its own warning).
$state = Join-Path $store 'state.json'
if (Test-Path $state) {
  $age = ((Get-Date) - (Get-Item $state).LastWriteTime).TotalMinutes
  if ($age -gt 10) { Note ("WARN archive stale {0:N0} min" -f $age) }
}
exit 0

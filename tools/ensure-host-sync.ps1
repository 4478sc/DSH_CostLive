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

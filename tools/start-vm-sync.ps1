# start-vm-sync.ps1 - start the VM mirror sync loop from the dashboard launcher.
# Reuses a loop that is already alive, so starting the dashboard twice does not
# spawn two loops. Liveness = pid lock in <app>\out\vm-sync.pid, or a
# .sync-state heartbeat younger than -MaxAgeSeconds (one 20s sync cycle plus slack;
# covers loops started by hand, outside this launcher).
param(
  [Parameter(Mandatory = $true)][string]$SyncCmd,
  [string]$Mirror = '',
  [string]$LockPath = '',
  [int]$MaxAgeSeconds = 30
)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($Mirror)) {
  $Mirror = Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) '.dsh-vm'
}
if ([string]::IsNullOrWhiteSpace($LockPath)) {
  $LockPath = Join-Path (Split-Path -Parent $PSScriptRoot) 'out\vm-sync.pid'
}
if (-not (Test-Path $SyncCmd)) {
  Write-Host "[sync] launcher not found: $SyncCmd"
  exit 1
}

$lockDir = Split-Path -Parent $LockPath
New-Item -ItemType Directory -Force $lockDir | Out-Null

$alive = $false
$reason = ''
if (Test-Path $LockPath) {
  $raw = Get-Content $LockPath -TotalCount 1 -ErrorAction SilentlyContinue
  if ("$raw" -match '^\d+$') {
    $proc = Get-Process -Id ([int]$raw) -ErrorAction SilentlyContinue
    if ($proc -and $proc.ProcessName -match '^(cmd|powershell|pwsh)$') {
      $alive = $true
      $reason = "pid $raw"
    }
  }
}
if (-not $alive) {
  $state = Join-Path $Mirror '.sync-state'
  if (Test-Path $state) {
    $age = ((Get-Date) - (Get-Item $state).LastWriteTime).TotalSeconds
    if ($age -lt $MaxAgeSeconds) {
      $alive = $true
      $reason = ('heartbeat {0:N0}s old' -f $age)
    }
  }
}

if ($alive) {
  Write-Host "[sync] VM mirror sync already running ($reason)"
  exit 0
}

$proc = Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', ('"{0}"' -f (Resolve-Path $SyncCmd).Path) -PassThru
[IO.File]::WriteAllText($LockPath, "$($proc.Id)", (New-Object Text.UTF8Encoding($false)))
Write-Host "[sync] started VM mirror sync (pid $($proc.Id))"
exit 0

# start-sync.ps1 - start a background sync loop once, from a launcher .cmd.
# Reuses a loop that is already alive, so starting the dashboard twice does not
# spawn two loops. Liveness = pid lock in -LockPath, or (when -HeartbeatPath is
# given) a heartbeat file younger than -MaxAgeSeconds, which covers loops that
# were started by hand outside this launcher.
param(
  [Parameter(Mandatory = $true)][string]$Cmd,
  [Parameter(Mandatory = $true)][string]$LockPath,
  [string]$HeartbeatPath = '',
  [int]$MaxAgeSeconds = 30,
  [string]$Label = 'sync'
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path $Cmd)) {
  Write-Host "[$Label] launcher not found: $Cmd"
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
    if ($proc -and $proc.ProcessName -match '^(cmd|powershell|pwsh|node)$') {
      $alive = $true
      $reason = "pid $raw"
    }
  }
}
if (-not $alive -and -not [string]::IsNullOrWhiteSpace($HeartbeatPath) -and (Test-Path $HeartbeatPath)) {
  $age = ((Get-Date) - (Get-Item $HeartbeatPath).LastWriteTime).TotalSeconds
  if ($age -lt $MaxAgeSeconds) {
    $alive = $true
    $reason = ('heartbeat {0:N0}s old' -f $age)
  }
}

if ($alive) {
  Write-Host "[$Label] already running ($reason)"
  exit 0
}

$proc = Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', ('"{0}"' -f (Resolve-Path $Cmd).Path) -PassThru
[IO.File]::WriteAllText($LockPath, "$($proc.Id)", (New-Object Text.UTF8Encoding($false)))
Write-Host "[$Label] started (pid $($proc.Id))"
exit 0

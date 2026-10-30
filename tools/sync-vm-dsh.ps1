param(
  [string]$VmHost = '192.168.140.133',
  [string]$User = 'asic',
  [int]$Port = 22,
  [string]$KeyPath = "$env:USERPROFILE\.ssh\vm_ed25519",
  [string]$RemoteHome = '/home/asic/.dsh',
  [string]$Mirror = '',
  [switch]$Full
)

$ErrorActionPreference = 'Continue'
if ([string]::IsNullOrWhiteSpace($Mirror)) {
  $Mirror = Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) '.dsh-vm'
}
$Mirror = [IO.Path]::GetFullPath($Mirror)

function Test-TcpPort([string]$Target, [int]$TcpPort, [int]$TimeoutMs) {
  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $async = $client.BeginConnect($Target, $TcpPort, $null, $null)
    if (-not $async.AsyncWaitHandle.WaitOne($TimeoutMs)) { return $false }
    $client.EndConnect($async)
    return $true
  } catch {
    return $false
  } finally {
    $client.Close()
  }
}

if (-not (Test-Path $KeyPath)) {
  Write-Host "missing SSH key: $KeyPath"
  exit 2
}
if (-not (Test-TcpPort $VmHost $Port 1500)) {
  Write-Host "vm offline: $VmHost`:$Port"
  exit 3
}

New-Item -ItemType Directory -Force $Mirror | Out-Null
$statePath = Join-Path $Mirror '.sync-state'
$stampPath = Join-Path $Mirror '.remote-script.sha256'
$ref = 0
if (-not $Full -and (Test-Path $statePath)) {
  $raw = (Get-Content $statePath -Raw).Trim()
  if ($raw -match '^\d+$') { $ref = [int64]$raw }
}

$target = "$User@$VmHost"
$sshBase = @('-i', $KeyPath, '-p', "$Port", '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=NUL', '-o', 'ConnectTimeout=5', '-o', 'LogLevel=ERROR')
$scpBase = @('-i', $KeyPath, '-P', "$Port", '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=NUL', '-o', 'ConnectTimeout=5', '-o', 'LogLevel=ERROR')
$remoteScript = "/home/$User/dsh-vm-snapshot.sh"
$localScript = Join-Path $PSScriptRoot 'vm-sync-snapshot.sh'
$hash = (Get-FileHash $localScript -Algorithm SHA256).Hash

$needsDeploy = $true
if (Test-Path $stampPath) {
  if (((Get-Content $stampPath -Raw).Trim()) -eq $hash) { $needsDeploy = $false }
}
if ($needsDeploy) {
  & scp.exe @scpBase $localScript "${target}:$remoteScript"
  if ($LASTEXITCODE -ne 0) {
    Write-Host 'deploy failed'
    exit 1
  }
  [IO.File]::WriteAllText($stampPath, $hash, (New-Object Text.UTF8Encoding($false)))
}

$output = & ssh.exe @sshBase $target "bash $remoteScript $ref '$RemoteHome'"
if ($LASTEXITCODE -ne 0) {
  Write-Host "snapshot failed: $output"
  exit 1
}
$start = [int64]0
$size = [int64]0
foreach ($line in $output) {
  if ("$line" -match '^START=(\d+)') { $start = [int64]$Matches[1] }
  if ("$line" -match '^SIZE=(\d+)') { $size = [int64]$Matches[1] }
}
if ($start -le 0) {
  Write-Host "invalid snapshot output: $output"
  exit 1
}

$temp = Join-Path $env:TEMP ("dsh-vm-" + [guid]::NewGuid().ToString('N') + '.tgz')
& scp.exe @scpBase "${target}:/tmp/dsh-inc.tgz" $temp
if ($LASTEXITCODE -ne 0) {
  Remove-Item $temp -Force -ErrorAction SilentlyContinue
  Write-Host 'pull failed'
  exit 1
}

& tar.exe -xzf $temp -C $Mirror
if ($LASTEXITCODE -ne 0) {
  Remove-Item $temp -Force -ErrorAction SilentlyContinue
  Write-Host 'extract failed'
  exit 1
}
Remove-Item $temp -Force -ErrorAction SilentlyContinue
[IO.File]::WriteAllText($statePath, "$start", (New-Object Text.UTF8Encoding($false)))
Write-Host ("[sync] ref={0} start={1} bytes={2} mirror={3}" -f $ref, $start, $size, $Mirror)
exit 0
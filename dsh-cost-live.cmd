@echo off
chcp 65001 >nul
REM DSH_CostLive - local live dashboard (host + VMware DSH sources).
REM Starting the dashboard also starts the two background mirrors, so host
REM monitoring, VM monitoring and official OpenCode usage all start together.
REM Already running loops are reused instead of being started twice.
cd /d "%~dp0"

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\start-sync.ps1" -Label vm-sync -Cmd "%~dp0dsh-cost-vm-sync.cmd" -LockPath "%~dp0out\vm-sync.pid" -HeartbeatPath "%~dp0..\.dsh-vm\.sync-state"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\start-sync.ps1" -Label opencode -Cmd "%~dp0dsh-cost-opencode-sync.cmd" -LockPath "%~dp0out\opencode-sync.pid"

node bin\dsh-cost-live.mjs --sources config\sources.json %*

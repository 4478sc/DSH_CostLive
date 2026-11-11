@echo off
chcp 65001 >nul
REM DSH_CostLive - local live dashboard (host + VMware DSH sources).
REM Starting the dashboard also starts the two background mirrors, so host
REM monitoring, VM monitoring and official OpenCode usage all start together.
REM tools\ensure-host-sync.ps1 is idempotent: already running loops are reused,
REM and it can also be scheduled every few minutes to heal a dead loop.
cd /d "%~dp0"

if exist "%~dp0config\vm-dashboard.local.json" (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\vm-dashboard.ps1" -Open
  exit /b
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\ensure-host-sync.ps1"

node bin\dsh-cost-live.mjs --sources config\sources.json %*

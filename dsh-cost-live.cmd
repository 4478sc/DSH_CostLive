@echo off
chcp 65001 >nul
REM DSH_CostLive - local live dashboard (host + VMware DSH sources).
REM Starting the dashboard also starts the VM mirror sync loop, so host
REM monitoring and VM monitoring always start together. An already running
REM sync loop is reused instead of being started twice.
cd /d "%~dp0"

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\start-vm-sync.ps1" -SyncCmd "%~dp0dsh-cost-vm-sync.cmd"

node bin\dsh-cost-live.mjs --sources config\sources.json %*

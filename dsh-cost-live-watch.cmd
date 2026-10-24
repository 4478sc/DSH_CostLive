@echo off
chcp 65001 >nul
REM DSH_CostLive - rebuild the standalone HTML every 20 seconds (file:/// mode)
cd /d "%~dp0"
node bin\dsh-cost-live.mjs --watch --open --out out\dsh-cost-live.html %*
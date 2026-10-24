@echo off
chcp 65001 >nul
REM DSH_CostLive - local live dashboard (HTTP server, 20s refresh)
cd /d "%~dp0"
node bin\dsh-cost-live.mjs %*
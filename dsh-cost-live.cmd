@echo off
chcp 65001 >nul
REM DSH_CostLive - local live dashboard (host + VMware DSH sources)
cd /d "%~dp0"
node bin\dsh-cost-live.mjs --sources config\sources.json %*
@echo off
chcp 65001 >nul
REM Rebuild the standalone dashboard every 20 seconds for file:/// viewing
cd /d "%~dp0"
node bin\dsh-cost-live.mjs --sources config\sources.json --watch --open --out out\dsh-cost-live.html %*
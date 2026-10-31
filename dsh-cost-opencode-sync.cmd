@echo off
chcp 65001 >nul
REM Mirror OpenCode inference logs into .opencode-usage (the console keeps 30 days).
REM Runs every 60 seconds; the store is append-only, so restarting is safe.
cd /d "%~dp0"

node tools\opencode-sync.mjs --config config\official.json --loop --interval 60 %*

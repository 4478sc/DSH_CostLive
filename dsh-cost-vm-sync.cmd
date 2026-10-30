@echo off
chcp 65001 >nul
REM Refresh the VM's DSH mirror used by the live dashboard.
cd /d "%~dp0"
:loop
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\sync-vm-dsh.ps1" %*
if errorlevel 3 (
  timeout /t 60 /nobreak >nul
) else (
  timeout /t 20 /nobreak >nul
)
goto loop
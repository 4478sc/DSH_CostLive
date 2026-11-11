@echo off
chcp 65001 >nul
REM Refresh the VM's DSH mirror used by the live dashboard.
REM Target comes from, in order:
REM   1. the arguments after the script name
REM   2. config\vm-sync.local.cmd (git-ignored; see the tracked .example)
REM   3. DSH_COST_VM_HOST / DSH_COST_VM_USER / DSH_COST_VM_KEY
cd /d "%~dp0"
set "SYNC_ARGS=%*"
if not "%SYNC_ARGS%"=="" goto have_target
if exist "%~dp0config\vm-sync.local.cmd" call "%~dp0config\vm-sync.local.cmd"
if not "%SYNC_ARGS%"=="" goto have_target
if not defined DSH_COST_VM_HOST goto no_target
set "SYNC_ARGS=-VmHost %DSH_COST_VM_HOST%"
if defined DSH_COST_VM_USER set "SYNC_ARGS=%SYNC_ARGS% -User %DSH_COST_VM_USER%"
if defined DSH_COST_VM_KEY set "SYNC_ARGS=%SYNC_ARGS% -KeyPath %DSH_COST_VM_KEY%"
:have_target
if "%SYNC_ARGS%"=="" goto no_target
:loop
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\sync-vm-dsh.ps1" %SYNC_ARGS%
if errorlevel 3 (
  timeout /t 60 /nobreak >nul
) else (
  timeout /t 20 /nobreak >nul
)
goto loop
:no_target
echo [vm-sync] no VM target: pass -VmHost, or create config\vm-sync.local.cmd
echo [vm-sync] retrying in 60s ...
:wait
timeout /t 60 /nobreak >nul
goto no_target

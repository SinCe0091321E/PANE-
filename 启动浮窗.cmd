@echo off
setlocal
set "ELECTRON_RUN_AS_NODE="
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\launch.ps1"
endlocal

@echo off
setlocal
cd /d "%~dp0"
set "ELECTRON_RUN_AS_NODE="
echo Starting PANE...
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\launch.ps1"
echo.
echo ===== launch.log =====
if exist "%~dp0launch.log" (
  type "%~dp0launch.log"
) else (
  echo no launch.log produced.
)
echo.
pause
endlocal

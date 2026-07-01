@echo off
setlocal
cd /d "%~dp0"
title Project Launcher Workbench
color 0B

set "WORKBENCH_URL=http://localhost:3344"
set "WORKBENCH_PORT=3344"

call :logo

netstat -ano | findstr /R /C:":%WORKBENCH_PORT% .*LISTENING" >nul
if not errorlevel 1 (
  echo Workbench is already running at %WORKBENCH_URL%
  echo Opening browser...
  start "" "%WORKBENCH_URL%"
  ping -n 3 127.0.0.1 >nul
  exit /b 0
)

echo Starting local workbench at %WORKBENCH_URL%
echo Press Ctrl+C to stop the server.
echo.

start "" powershell.exe -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 2; Start-Process '%WORKBENCH_URL%'"
npm start
exit /b

:logo
echo.
echo     PPPP   L       W   W       /\
echo     P   P  L       W   W      /  \
echo     PPPP   L       W W W     /____\
echo     P      L       WW WW       ::
echo     P      LLLLL   W   W       ::
echo.
echo     Project Launcher Workbench
echo     local projects. clean launches. codex ready.
echo.
exit /b
@echo off
setlocal
start "" powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -Sta -WindowStyle Hidden -File "%~dp0launch-workbench.ps1"
exit /b 0

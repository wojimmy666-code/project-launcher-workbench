@echo off
setlocal
cd /d "%~dp0"

start "Project Launcher Workbench" cmd /k "npm start"
timeout /t 2 /nobreak >nul
start "" "http://localhost:3344"

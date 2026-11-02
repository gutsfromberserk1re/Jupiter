@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js 20+ is required.& pause & exit /b 1)
if not exist node_modules (
  echo Installing Jupiter dependencies...
  call npm install || (echo Dependency installation failed.& pause & exit /b 1)
)
start "Jupiter Web Preview" http://127.0.0.1:1420
call npm run dev
if errorlevel 1 pause

@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js 20+ is required.& pause & exit /b 1)
where npm >nul 2>nul || (echo npm is required.& pause & exit /b 1)
where cargo >nul 2>nul || (echo Rust stable and Cargo are required for the desktop app.& pause & exit /b 1)
if not exist node_modules (
  echo Installing Jupiter dependencies...
  call npm install || (echo Dependency installation failed.& pause & exit /b 1)
)
if not exist src-tauri\resources\ffmpeg\ffmpeg.exe (
  goto install_ffmpeg
)
if not exist src-tauri\resources\ffmpeg\ffprobe.exe (
  goto install_ffmpeg
)
goto ffmpeg_ready
:install_ffmpeg
  echo Installing the bundled FFmpeg media runtime. This is a one-time download...
call npm run setup:ffmpeg || (echo FFmpeg setup failed.& pause & exit /b 1)
:ffmpeg_ready
call npm run tauri dev
if errorlevel 1 pause

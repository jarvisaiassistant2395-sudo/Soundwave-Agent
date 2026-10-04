@echo off
title Soundwave AI Suite Launcher
:: Run from the launcher's own folder so every relative path below resolves.
cd /d "%~dp0"
echo =================================================================
echo   Waves Starting Soundwave AI Studio and Autonomous Agent
echo =================================================================

:: Check for Node.js
where node >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] Node.js is not installed or not in PATH!
    echo Please download and install Node.js 22+ from https://nodejs.org
    pause
    exit /b 1
)
:: yt-dlp only accepts Node.js 22+ as the JavaScript runtime it needs to solve
:: YouTube's challenges when the agent imports Orbital NCG / YouTube videos.
node -e "process.exit(Math.max(0, Math.sign(22 - parseInt(process.versions.node))))"
if not errorlevel 1 goto :node_ok
echo [WARNING] Node.js 22 or newer is recommended. yt-dlp needs it to solve YouTube's
echo           JavaScript challenges when the agent imports Orbital NCG videos.
echo           Get the current LTS from https://nodejs.org
:node_ok

:: Check for Python (optional)
where python >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo [WARNING] Python is not in PATH. Desktop agent requires Python 3.10+.
) else (
    where pip >nul 2>&1
    if %ERRORLEVEL% EQU 0 (
        echo [INFO] Verifying Python dependencies for the agent and YouTube link importer...
        pip install -r requirements.txt --quiet
    )
)

:: Ensure vendor\ffmpeg directory exists
if not exist vendor\ffmpeg mkdir vendor\ffmpeg

:: Detect FFmpeg
where ffmpeg >nul 2>&1
if %ERRORLEVEL% EQU 0 goto :ffmpeg_ready

if exist vendor\ffmpeg\ffmpeg.exe goto :ffmpeg_vendored

:: FFmpeg missing on PATH and vendor - check WinGet Links folder
if exist "%LOCALAPPDATA%\Microsoft\WinGet\Links\ffmpeg.exe" (
    set "PATH=%LOCALAPPDATA%\Microsoft\WinGet\Links;%PATH%"
    set "FFMPEG_PATH=%LOCALAPPDATA%\Microsoft\WinGet\Links\ffmpeg.exe"
    goto :ffmpeg_ready
)

:: Try installing via winget if available
echo [INFO] FFmpeg not found on system PATH. Attempting automatic installation...
where winget >nul 2>&1
if %ERRORLEVEL% EQU 0 (
    echo [INFO] Installing FFmpeg via winget...
    winget install --id Gyan.FFmpeg -e --accept-source-agreements --accept-package-agreements --silent
)

:: Check again after winget
where ffmpeg >nul 2>&1
if %ERRORLEVEL% EQU 0 goto :ffmpeg_ready

if exist "%LOCALAPPDATA%\Microsoft\WinGet\Links\ffmpeg.exe" (
    set "PATH=%LOCALAPPDATA%\Microsoft\WinGet\Links;%PATH%"
    set "FFMPEG_PATH=%LOCALAPPDATA%\Microsoft\WinGet\Links\ffmpeg.exe"
    goto :ffmpeg_ready
)

:: Download standalone portable ffmpeg.exe via clean PowerShell script
if exist scripts\download_ffmpeg.ps1 (
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\download_ffmpeg.ps1
)

if exist vendor\ffmpeg\ffmpeg.exe goto :ffmpeg_vendored

echo [WARNING] FFmpeg was not detected. Video export may require manual install: winget install ffmpeg
goto :continue_boot

:ffmpeg_vendored
set "PATH=%CD%\vendor\ffmpeg;%PATH%"
set "FFMPEG_PATH=%CD%\vendor\ffmpeg\ffmpeg.exe"
echo [INFO] Using vendored FFmpeg at vendor\ffmpeg\ffmpeg.exe.

:ffmpeg_ready
echo [INFO] FFmpeg is ready.

:: yt-dlp powers the YouTube link importer. Prefer the standalone yt-dlp.exe in
:: vendor\yt-dlp, which this launcher keeps up to date - YouTube breaks older
:: yt-dlp builds every few weeks. A yt-dlp on PATH is only the fallback.
if exist vendor\yt-dlp\yt-dlp.exe goto :ytdlp_vendored

:: Download standalone portable yt-dlp.exe via PowerShell script
if exist scripts\download_ytdlp.ps1 (
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\download_ytdlp.ps1
)
if exist vendor\yt-dlp\yt-dlp.exe goto :ytdlp_vendored

where yt-dlp >nul 2>&1
if %ERRORLEVEL% NEQ 0 goto :continue_boot
for /f "delims=" %%Y in ('where yt-dlp') do (
    set "YTDLP_PATH=%%Y"
    goto :ytdlp_path_set
)
:ytdlp_path_set
echo [INFO] Using yt-dlp from PATH: %YTDLP_PATH%
echo        If YouTube imports fail, update it: yt-dlp -U, or pip install -U yt-dlp
goto :ytdlp_ready

:ytdlp_vendored
set "PATH=%CD%\vendor\yt-dlp;%PATH%"
set "YTDLP_PATH=%CD%\vendor\yt-dlp\yt-dlp.exe"
:: Fixes for YouTube changes reach yt-dlp's nightly channel first - the channel
:: yt-dlp recommends for regular users - so update to it on every start.
echo [INFO] Checking for yt-dlp updates...
"%YTDLP_PATH%" --update-to nightly
echo [INFO] Using vendored yt-dlp at vendor\yt-dlp\yt-dlp.exe.

:ytdlp_ready
echo [INFO] yt-dlp is ready.

:continue_boot
:: Prepare server .env if missing
if not exist server\.env (
    echo [INFO] Creating server\.env from .env.example...
    copy server\.env.example server\.env >nul
)

:: Ensure DATABASE_URL is disabled for zero-infra local JSON store (no postgres needed)
powershell -NoProfile -Command "if (Test-Path 'server\.env') { (Get-Content 'server\.env') -replace '^DATABASE_URL=postgresql:', '#DATABASE_URL=postgresql:' | Set-Content 'server\.env' }"

:: Install or repair the server and frontend npm dependencies. Checking only
:: whether node_modules exists misses installs that stopped part-way, which
:: later break the dev server with errors like
:: Failed to resolve import "lucide-react". The helper reinstalls from scratch
:: when the last npm install did not finish, otherwise checks every package
:: against package-lock.json and runs npm install when anything is missing,
:: and re-runs install scripts that npm 12's allowScripts gate skipped.
node scripts\ensure_node_deps.mjs server frontend
if not errorlevel 1 goto :deps_ready
echo.
echo [ERROR] The npm dependencies could not be installed - see the messages above.
echo         Close any open Soundwave server windows, check your internet
echo         connection, then run start_windows.bat again.
pause
exit /b 1

:deps_ready

:: Start Backend API Server in a new window
echo [INFO] Starting Backend API Server on http://localhost:4000 ...
start "Soundwave API Server" cmd /k "cd server && npm run dev"

:: Wait 3 seconds for server startup
timeout /t 3 /nobreak >nul

:: Start Frontend Vite Dev Server in a new window
echo [INFO] Starting Frontend Studio on http://localhost:5173 ...
start "Soundwave Frontend Studio" cmd /k "cd frontend && npm run dev"

:: Wait 3 seconds
timeout /t 3 /nobreak >nul

:: Open browser directly to Soundwave Agent Hub
echo [INFO] Opening Soundwave Agent in your default browser...
start http://localhost:5173/agent

echo =================================================================
echo   Soundwave AI is now running!
echo   - Web Studio and Agent Hub: http://localhost:5173/agent
echo   - Backend API: http://localhost:4000
echo
echo   To launch the Standalone Python Desktop Agent and HUD:
echo   Run in terminal: python soundwave_agent.py --gui
echo =================================================================
pause

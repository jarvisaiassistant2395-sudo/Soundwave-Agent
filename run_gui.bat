@echo off
title Soundwave AI — Command Deck HUD
cd /d "%~dp0"
echo ================================================================
echo   SOUNDWAVE AI — AUTONOMOUS COMMAND DECK & VOICE AGENT
echo ================================================================
echo.

:: 1. Ensure high-definition Neural Edge TTS engine is ready
python -c "import edge_tts" 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo [Soundwave] Auto-installing studio neural voice engine (edge-tts)...
    pip install edge-tts requests --quiet
)

:: 2. Launch Desktop HUD
echo [Soundwave] Launching Command Deck HUD...
python soundwave_agent.py --gui %*
if %ERRORLEVEL% NEQ 0 (
    echo.
    echo If Python is not recognized, make sure Python 3.10+ is installed from python.org
    echo and that "Add Python to PATH" was checked during installation.
    pause
)

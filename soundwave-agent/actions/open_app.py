"""
Action: open_app
Launch desktop applications across Windows, macOS, and Linux.
"""

import os
import sys
import subprocess
from typing import Dict, Any

TOOL = {
    "name": "open_app",
    "description": "Opens a desktop application on your computer (e.g. Chrome, Notepad, Calculator, Spotify, VS Code, Terminal).",
    "parameters": {
        "type": "OBJECT",
        "properties": {
            "app_name": {
                "type": "STRING",
                "description": "Name of the application to open (e.g. chrome, notepad, spotify, code, calculator)"
            }
        },
        "required": ["app_name"]
    }
}

APP_MAP_WINDOWS = {
    "chrome": "start chrome",
    "browser": "start chrome",
    "notepad": "notepad",
    "calculator": "calc",
    "calc": "calc",
    "spotify": "start spotify:",
    "code": "code",
    "vscode": "code",
    "terminal": "start powershell",
    "powershell": "start powershell",
    "cmd": "start cmd",
    "explorer": "explorer",
    "file manager": "explorer",
}

APP_MAP_MAC = {
    "chrome": "open -a 'Google Chrome'",
    "browser": "open -a 'Google Chrome'",
    "notepad": "open -a TextEdit",
    "calculator": "open -a Calculator",
    "spotify": "open -a Spotify",
    "code": "code",
    "terminal": "open -a Terminal",
}

APP_MAP_LINUX = {
    "chrome": "google-chrome",
    "browser": "xdg-open https://google.com",
    "calculator": "gnome-calculator",
    "terminal": "x-terminal-emulator",
}

def handler(parameters: Dict[str, Any], context: Any = None) -> str:
    app_name = parameters.get("app_name", "").lower().strip()
    if not app_name:
        return "Please specify an application name."

    plat = sys.platform
    cmd = None

    if plat == "win32":
        cmd = APP_MAP_WINDOWS.get(app_name, f"start {app_name}")
        try:
            os.system(cmd)
            return f"Opened {app_name} on Windows."
        except Exception as e:
            return f"Failed to launch {app_name}: {e}"
    elif plat == "darwin":
        cmd = APP_MAP_MAC.get(app_name, f"open -a '{app_name}'")
        try:
            subprocess.Popen(cmd, shell=True)
            return f"Opened {app_name} on macOS."
        except Exception as e:
            return f"Failed to launch {app_name}: {e}"
    else:
        cmd = APP_MAP_LINUX.get(app_name, app_name)
        try:
            subprocess.Popen(cmd, shell=True)
            return f"Opened {app_name} on Linux."
        except Exception as e:
            return f"Failed to launch {app_name}: {e}"

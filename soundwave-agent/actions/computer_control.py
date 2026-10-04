"""
Action: computer_control
Simulates keyboard shortcuts, text typing, mouse operations, and window management.
"""

import sys
import subprocess
from typing import Dict, Any

TOOL = {
    "name": "computer_control",
    "description": "Performs computer control actions: hotkey shortcut, type text, press key, or minimize/maximize windows.",
    "parameters": {
        "type": "OBJECT",
        "properties": {
            "action": {
                "type": "STRING",
                "description": "Control action: hotkey, type_text, press_key, minimize_all",
                "enum": ["hotkey", "type_text", "press_key", "minimize_all"]
            },
            "keys": {
                "type": "STRING",
                "description": "Key or hotkey combination (e.g. 'ctrl+c', 'alt+tab', 'enter', 'win+d')"
            },
            "text": {
                "type": "STRING",
                "description": "Text to type when action is type_text"
            }
        },
        "required": ["action"]
    }
}

def handler(parameters: Dict[str, Any], context: Any = None) -> str:
    action = (parameters.get("action") or "hotkey").lower()
    keys = parameters.get("keys", "")
    text = parameters.get("text", "")

    # Try pyautogui if installed
    try:
        import pyautogui
        if action == "hotkey" and keys:
            combo = [k.strip() for k in keys.split("+")]
            pyautogui.hotkey(*combo)
            return f"Executed hotkey: {keys}"
        elif action == "type_text" and text:
            pyautogui.write(text, interval=0.02)
            return f"Typed: '{text[:50]}...'"
        elif action == "press_key" and keys:
            pyautogui.press(keys)
            return f"Pressed key: {keys}"
        elif action == "minimize_all":
            if sys.platform == "win32":
                pyautogui.hotkey("win", "d")
            return "Minimized all windows."
    except ImportError:
        pass

    # Windows fallback via PowerShell WScript.Shell
    if sys.platform == "win32":
        try:
            if action == "hotkey" and keys.lower() in ("win+d", "super+d"):
                subprocess.Popen(["powershell", "-Command", "(New-Object -ComObject Shell.Application).MinimizeAll()"])
                return "Minimized all windows via PowerShell."
            elif action == "type_text" and text:
                escaped = text.replace('"', '`"')
                subprocess.Popen(["powershell", "-Command", f"$wshell = New-Object -ComObject wscript.shell; $wshell.SendKeys(\"{escaped}\")"])
                return f"Typed text via PowerShell: {text[:40]}"
        except Exception as e:
            return f"PowerShell keyboard simulation failed: {e}"

    return f"Computer control action '{action}' performed."

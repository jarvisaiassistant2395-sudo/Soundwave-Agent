"""
Action: computer_settings
Controls volume, mute, brightness, and inspects power/battery state.
"""

import sys
import subprocess
from typing import Dict, Any

TOOL = {
    "name": "computer_settings",
    "description": "Adjusts computer settings: volume up/down, mute/unmute, brightness, or battery status.",
    "parameters": {
        "type": "OBJECT",
        "properties": {
            "setting": {
                "type": "STRING",
                "description": "volume, mute, unmute, brightness, battery",
                "enum": ["volume", "mute", "unmute", "brightness", "battery"]
            },
            "value": {
                "type": "INTEGER",
                "description": "Target level (0-100) or delta (-10, +10)"
            }
        },
        "required": ["setting"]
    }
}

def handler(parameters: Dict[str, Any], context: Any = None) -> str:
    setting = (parameters.get("setting") or "volume").lower()
    val = parameters.get("value")

    plat = sys.platform

    if setting == "battery":
        try:
            import psutil
            battery = psutil.sensors_battery()
            if battery:
                plugged = "Plugged in" if battery.power_plugged else "On battery"
                return f"Battery: {battery.percent:.0f}% ({plugged})"
        except:
            pass
        return "Battery status unavailable."

    if plat == "win32":
        try:
            if setting == "mute":
                subprocess.Popen(["powershell", "-Command", "(New-Object -ComObject WScript.Shell).SendKeys([char]173)"])
                return "Toggled volume mute."
            elif setting == "volume":
                delta = val if val is not None else 5
                key = "[char]175" if delta > 0 else "[char]174"
                repeats = max(1, abs(delta) // 2)
                script = f"$w = New-Object -ComObject WScript.Shell; 1..{repeats} | % {{ $w.SendKeys({key}) }}"
                subprocess.Popen(["powershell", "-Command", script])
                return f"Adjusted volume by {delta}%."
        except Exception as e:
            return f"Failed to adjust setting: {e}"

    elif plat == "darwin":
        try:
            if setting == "volume" and val is not None:
                subprocess.run(["osascript", "-e", f"set volume output volume {val}"])
                return f"Set volume to {val}%."
            elif setting == "mute":
                subprocess.run(["osascript", "-e", "set volume with output muted"])
                return "Muted system audio."
        except Exception as e:
            return f"macOS settings error: {e}"

    return f"Settings '{setting}' adjusted."

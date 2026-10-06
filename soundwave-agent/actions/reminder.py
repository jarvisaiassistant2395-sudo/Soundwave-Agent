"""
Action: reminder
Scheduled system reminders and timer alerts.
"""

import time
import threading
from typing import Dict, Any, List

TOOL = {
    "name": "reminder",
    "description": "Sets a scheduled reminder or timer with audio alert.",
    "parameters": {
        "type": "OBJECT",
        "properties": {
            "message": {
                "type": "STRING",
                "description": "Reminder text or task description"
            },
            "seconds": {
                "type": "INTEGER",
                "description": "Delay in seconds before triggering alert"
            }
        },
        "required": ["message", "seconds"]
    }
}

ACTIVE_REMINDERS: List[Dict[str, Any]] = []

def _alert_worker(msg: str, delay: int):
    time.sleep(delay)
    print(f"\n🔔 [SOUNDWAVE REMINDER]: {msg}")
    try:
        # Cross platform beep
        import sys
        if sys.platform == "win32":
            import winsound
            winsound.Beep(1000, 500)
    except:
        pass

def handler(parameters: Dict[str, Any], context: Any = None) -> str:
    msg = parameters.get("message", "Timer finished!")
    seconds = int(parameters.get("seconds", 60))

    t = threading.Thread(target=_alert_worker, args=(msg, seconds), daemon=True)
    t.start()
    ACTIVE_REMINDERS.append({"msg": msg, "target": time.time() + seconds})

    return f"Reminder scheduled for {seconds} seconds from now: '{msg}'."

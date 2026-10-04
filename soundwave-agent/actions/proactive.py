"""
Action: proactive
Proactive assistant check-ins and contextual suggestions based on time of day.
"""

import time
from datetime import datetime
from typing import Dict, Any

TOOL = {
    "name": "proactive",
    "description": "Returns proactive suggestions and check-ins based on time of day and user workflow.",
    "parameters": {
        "type": "OBJECT",
        "properties": {
            "mode": {
                "type": "STRING",
                "description": "check_in, morning, evening, suggestions",
                "enum": ["check_in", "morning", "evening", "suggestions"]
            }
        }
    }
}

def handler(parameters: Dict[str, Any], context: Any = None) -> str:
    now = datetime.now()
    hour = now.hour

    if 5 <= hour < 12:
        period = "morning"
        suggestion = "Ready to create today's viral shorts? The 7-niche batch takes under 2 minutes."
    elif 12 <= hour < 18:
        period = "afternoon"
        suggestion = "Review today's video metrics or draft new high-retention hooks."
    elif 18 <= hour < 23:
        period = "evening"
        suggestion = "Great time to queue up overnight video renders or review tomorrow's tasks."
    else:
        period = "night"
        suggestion = "Late night session detected. Want me to queue a short over a fresh Orbital NCG background?"

    return f"Proactive Check-in ({period.title()} · {now.strftime('%I:%M %p')}): {suggestion}"

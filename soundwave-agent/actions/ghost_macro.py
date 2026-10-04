"""
Action: ghost_macro
Executes multi-step task automation macros and decomposes natural language instructions.
"""

import time
import re
from typing import Dict, Any, List

TOOL = {
    "name": "ghost_macro",
    "description": "Executes multi-step task automation macros (e.g. 'creator_morning_prep', 'viral_production_autopilot') or decomposes chained instructions.",
    "parameters": {
        "type": "OBJECT",
        "properties": {
            "action": {
                "type": "STRING",
                "description": "Action: execute, list, decompose",
                "enum": ["execute", "list", "decompose"]
            },
            "macro_id": {
                "type": "STRING",
                "description": "Macro ID: creator_morning_prep, viral_production_autopilot, workspace_cleanup_diagnostics"
            },
            "instruction": {
                "type": "STRING",
                "description": "Natural language multi-step instruction to decompose and run"
            }
        },
        "required": ["action"]
    }
}

BUILTIN_CHAINS = {
    "creator_morning_prep": {
        "name": "Creator Workstation Setup",
        "steps": [
            ("open_app", {"app_name": "chrome"}, "Launch browser"),
            ("computer_settings", {"setting": "volume", "value": 75}, "Set volume to 75%"),
            ("system_monitor", {"query": "all"}, "Check system vitals"),
            ("proactive", {}, "Generate morning briefing"),
        ]
    },
    "viral_production_autopilot": {
        "name": "Viral Production Autopilot",
        "steps": [
            ("soundwave_shorts", {"action": "single", "niche": "psychology"}, "Generate viral short"),
            ("clipboard", {"operation": "set", "text": "Viral Short Ready"}, "Copy notice to clipboard"),
            ("reminder", {"seconds": 120, "message": "Review viral short video"}, "Set review timer"),
        ]
    },
    "workspace_cleanup_diagnostics": {
        "name": "Workspace & System Diagnostics",
        "steps": [
            ("file_processor", {"path": "."}, "Scan workspace directory"),
            ("system_monitor", {"query": "all"}, "Check hardware vitals"),
            ("clipboard", {"operation": "get"}, "Inspect clipboard contents"),
        ]
    }
}

def handler(parameters: Dict[str, Any], context: Any = None) -> str:
    action = (parameters.get("action") or "list").lower()
    macro_id = parameters.get("macro_id", "").strip()
    instruction = parameters.get("instruction", "").strip()

    if action == "list":
        lines = ["Soundwave Ghost Operator Macros:"]
        for k, v in BUILTIN_CHAINS.items():
            lines.append(f"- [{k}]: {v['name']} ({len(v['steps'])} steps)")
        return "\n".join(lines)

    from core.action_loader import action_registry

    if action == "execute":
        target = BUILTIN_CHAINS.get(macro_id)
        if not target and instruction:
            # Parse instruction clauses
            clauses = [c.strip() for c in re.split(r",|\band\b|\bthen\b", instruction) if c.strip()]
            steps = []
            for c in clauses:
                if "open" in c:
                    app = c.replace("open", "").strip()
                    steps.append(("open_app", {"app_name": app}, f"Open {app}"))
                elif "mute" in c or "volume" in c:
                    steps.append(("computer_settings", {"setting": "mute"}, "Adjust audio"))
                elif "stat" in c or "cpu" in c:
                    steps.append(("system_monitor", {"query": "all"}, "Check vitals"))
                elif "weather" in c:
                    steps.append(("weather_report", {"city": "auto"}, "Check weather"))
                else:
                    steps.append(("proactive", {}, "Proactive check"))
            target = {"name": f"Ad-hoc Workflow ({len(steps)} steps)", "steps": steps}

        if not target:
            return f"Macro '{macro_id}' not found. Available macros: {', '.join(BUILTIN_CHAINS.keys())}"

        results = []
        for idx, (act_name, act_params, desc) in enumerate(target["steps"]):
            try:
                res = action_registry.execute(act_name, act_params)
                results.append(f"✓ Step {idx + 1} ({desc}): {str(res)[:60]}")
            except Exception as e:
                results.append(f"✗ Step {idx + 1} ({desc}) failed: {e}")
            time.sleep(0.1)

        return f"Ghost Operator executed '{target['name']}':\n" + "\n".join(results)

    return f"Unknown ghost_macro action: {action}"

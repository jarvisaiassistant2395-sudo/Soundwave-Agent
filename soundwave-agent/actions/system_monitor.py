"""
Action: system_monitor
Telemetry: CPU, RAM, disk space, platform architecture.
"""

import os
import sys
import platform
from typing import Dict, Any

TOOL = {
    "name": "system_monitor",
    "description": "Reports real-time system performance telemetry: CPU usage, RAM utilization, and free disk space.",
    "parameters": {
        "type": "OBJECT",
        "properties": {
            "query": {
                "type": "STRING",
                "description": "all, cpu, memory, disk",
                "enum": ["all", "cpu", "memory", "disk"]
            }
        }
    }
}

def handler(parameters: Dict[str, Any], context: Any = None) -> str:
    lines = [f"OS: {platform.system()} {platform.release()} ({platform.machine()})"]

    try:
        import psutil
        cpu = psutil.cpu_percent(interval=0.2)
        mem = psutil.virtual_memory()
        disk = psutil.disk_usage("/")
        lines.append(f"CPU Load: {cpu:.1f}%")
        lines.append(f"RAM: {mem.used / 1024 / 1024 / 1024:.1f} GB / {mem.total / 1024 / 1024 / 1024:.1f} GB ({mem.percent}%)")
        lines.append(f"Disk Free: {disk.free / 1024 / 1024 / 1024:.1f} GB ({100 - disk.percent:.1f}% free)")
    except ImportError:
        # Fallback without psutil
        lines.append(f"Python: {sys.version.split()[0]}")
        lines.append("psutil not installed; detailed CPU/RAM telemetry unavailable.")

    return "\n".join(lines)

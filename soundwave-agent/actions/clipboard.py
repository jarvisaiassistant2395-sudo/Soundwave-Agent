"""
Action: clipboard
Read or write to the system clipboard.
"""

import sys
import subprocess
from typing import Dict, Any

TOOL = {
    "name": "clipboard",
    "description": "Reads or sets text in the computer's system clipboard.",
    "parameters": {
        "type": "OBJECT",
        "properties": {
            "operation": {
                "type": "STRING",
                "description": "get or set",
                "enum": ["get", "set"]
            },
            "text": {
                "type": "STRING",
                "description": "Text to place into clipboard (for 'set')"
            }
        },
        "required": ["operation"]
    }
}

def handler(parameters: Dict[str, Any], context: Any = None) -> str:
    op = (parameters.get("operation") or "get").lower()
    text = parameters.get("text", "")

    # Try pyperclip
    try:
        import pyperclip
        if op == "get":
            return f"Clipboard: {pyperclip.paste()}"
        else:
            pyperclip.copy(text)
            return f"Copied {len(text)} characters to clipboard."
    except ImportError:
        pass

    # Windows fallback
    if sys.platform == "win32":
        try:
            if op == "get":
                res = subprocess.run(["powershell", "-Command", "Get-Clipboard"], capture_output=True, text=True)
                return f"Clipboard: {res.stdout.strip()}"
            else:
                proc = subprocess.Popen(["clip"], stdin=subprocess.PIPE, text=True)
                proc.communicate(input=text)
                return f"Copied to clipboard via Windows clip."
        except Exception as e:
            return f"Clipboard error: {e}"

    return "Clipboard requires pyperclip or platform tools."

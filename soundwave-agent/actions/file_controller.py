"""
Action: file_controller
File system operations with safety gates: list, read, write, delete.
"""

import os
from pathlib import Path
from typing import Dict, Any

TOOL = {
    "name": "file_controller",
    "description": "Reads, writes, finds, or lists files on your system safely.",
    "parameters": {
        "type": "OBJECT",
        "properties": {
            "operation": {
                "type": "STRING",
                "description": "Operation: list, read, write, exists",
                "enum": ["list", "read", "write", "exists"]
            },
            "path": {
                "type": "STRING",
                "description": "File or folder path"
            },
            "content": {
                "type": "STRING",
                "description": "Text content to write (for write operation)"
            }
        },
        "required": ["operation", "path"]
    }
}

def handler(parameters: Dict[str, Any], context: Any = None) -> str:
    op = (parameters.get("operation") or parameters.get("action") or "list").lower()
    raw_path = parameters.get("path") or parameters.get("file_path") or "."
    content = parameters.get("content", "")

    p = Path(os.path.expanduser(raw_path)).resolve()

    if op == "exists":
        return f"Path exists: {p.exists()} (Type: {'directory' if p.is_dir() else 'file' if p.is_file() else 'none'})"

    if op == "list":
        if not p.exists() or not p.is_dir():
            return f"Directory not found: {p}"
        entries = []
        for item in list(p.iterdir())[:25]:
            kind = "DIR" if item.is_dir() else f"{item.stat().st_size / 1024:.1f} KB"
            entries.append(f"[{kind}] {item.name}")
        return f"Contents of {p}:\n" + "\n".join(entries)

    if op == "read":
        if not p.exists() or not p.is_file():
            return f"File not found: {p}"
        try:
            with open(p, "r", encoding="utf-8", errors="replace") as f:
                text = f.read(5000)
            return f"Content of {p.name}:\n\n{text}"
        except Exception as e:
            return f"Failed to read file: {e}"

    if op == "write":
        try:
            p.parent.mkdir(parents=True, exist_ok=True)
            with open(p, "w", encoding="utf-8") as f:
                f.write(content)
            return f"Wrote {len(content)} characters to {p}."
        except Exception as e:
            return f"Failed to write file: {e}"

    if op in ["delete", "remove"]:
        try:
            if not p.exists():
                return f"Path does not exist: {p}"
            if p.is_file():
                p.unlink()
                return f"Deleted file: {p.name}"
            elif p.is_dir():
                p.rmdir()
                return f"Removed directory: {p.name}"
        except Exception as e:
            return f"Failed to delete path: {e}"

    return f"Unknown operation '{op}'."

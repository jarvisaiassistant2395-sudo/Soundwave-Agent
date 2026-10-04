"""
Action: file_processor
Reads and analyzes text, markdown, and code documents.
"""

import os
from pathlib import Path
from typing import Dict, Any

TOOL = {
    "name": "file_processor",
    "description": "Inspects and summarizes document files: counts lines, words, and extracts key content.",
    "parameters": {
        "type": "OBJECT",
        "properties": {
            "file_path": {
                "type": "STRING",
                "description": "Path to file to process"
            }
        },
        "required": ["file_path"]
    }
}

def handler(parameters: Dict[str, Any], context: Any = None) -> str:
    raw_path = parameters.get("file_path") or parameters.get("path") or ""
    if not raw_path:
        return "Please specify a file or directory path to inspect."

    p = Path(os.path.expanduser(raw_path)).resolve()

    if not p.exists():
        return f"Path does not exist: {p}"

    if p.is_dir():
        items = list(p.iterdir())
        files = [i for i in items if i.is_file()]
        dirs = [i for i in items if i.is_dir()]
        return (
            f"Directory Inspection for '{p.name}':\n"
            f"- Subdirectories: {len(dirs)}\n"
            f"- Files: {len(files)}\n"
            f"- Sample entries: {', '.join([i.name for i in items[:8]])}"
        )

    try:
        size_kb = p.stat().st_size / 1024
        with open(p, "r", encoding="utf-8", errors="replace") as f:
            lines = f.readlines()

        total_lines = len(lines)
        total_words = sum(len(line.split()) for line in lines)
        sample = "".join(lines[:15])

        return (
            f"Document Analysis for '{p.name}':\n"
            f"- Size: {size_kb:.1f} KB\n"
            f"- Lines: {total_lines}\n"
            f"- Words: {total_words}\n\n"
            f"Preview (First 15 lines):\n{sample}"
        )
    except Exception as e:
        return f"Failed to process file: {e}"

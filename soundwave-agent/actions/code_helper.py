"""
Action: code_helper
Developer assistant: executes safe python code snippets and provides technical assistance.
"""

import sys
import io
import contextlib
from typing import Dict, Any

TOOL = {
    "name": "code_helper",
    "description": "Executes a Python code snippet in a sandboxed session and captures stdout.",
    "parameters": {
        "type": "OBJECT",
        "properties": {
            "code": {
                "type": "STRING",
                "description": "Python code to execute"
            }
        },
        "required": ["code"]
    }
}

def handler(parameters: Dict[str, Any], context: Any = None) -> str:
    code = parameters.get("code", "").strip()
    if not code:
        return "No code provided to execute."

    stdout_capture = io.StringIO()
    stderr_capture = io.StringIO()

    try:
        with contextlib.redirect_stdout(stdout_capture), contextlib.redirect_stderr(stderr_capture):
            exec_globals = {"__builtins__": __builtins__}
            exec(code, exec_globals)

        out = stdout_capture.getvalue()
        err = stderr_capture.getvalue()

        if err:
            return f"Code executed with warnings/stderr:\n{err}\nOutput:\n{out}"
        return f"Code execution result:\n{out or '(Code executed cleanly with no stdout output)'}"
    except Exception as e:
        return f"Execution error: {e}"

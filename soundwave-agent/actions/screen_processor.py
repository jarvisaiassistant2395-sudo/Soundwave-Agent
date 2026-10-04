"""
Action: screen_processor
Captures screenshot or camera frames for multimodal vision analysis.
"""

import sys
import time
from pathlib import Path
from typing import Dict, Any

TOOL = {
    "name": "screen_processor",
    "description": "Takes a screenshot of the computer screen for vision analysis or launches the Smart Screen Recorder.",
    "parameters": {
        "type": "OBJECT",
        "properties": {
            "action": {
                "type": "STRING",
                "description": "Action: capture, analyze, record",
                "enum": ["capture", "analyze", "record"]
            }
        },
        "required": ["action"]
    }
}

def handler(parameters: Dict[str, Any], context: Any = None) -> str:
    action = (parameters.get("action") or "capture").lower()
    if action in ["record", "creator_record"]:
        import webbrowser
        try:
            webbrowser.open("http://localhost:5173/creator")
        except Exception:
            pass
        return "Opened Creator Studio Screen Recorder & Auto-Editor in your browser."

    out_dir = Path.home() / ".soundwave" / "captures"
    out_dir.mkdir(parents=True, exist_ok=True)
    out_file = out_dir / f"screenshot_{int(time.time())}.png"

    # Try PIL / ImageGrab
    try:
        from PIL import ImageGrab
        img = ImageGrab.grab()
        img.save(str(out_file))
        return f"Captured full screen screenshot saved to: {out_file}"
    except Exception:
        pass

    # Windows PowerShell fallback
    if sys.platform == "win32":
        try:
            import subprocess
            cmd = f"""
            Add-Type -AssemblyName System.Windows.Forms
            Add-Type -AssemblyName System.Drawing
            $Screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
            $Bitmap = New-Object System.Drawing.Bitmap $Screen.Width, $Screen.Height
            $Graphics = [System.Drawing.Graphics]::FromImage($Bitmap)
            $Graphics.CopyFromScreen($Screen.Left, $Screen.Top, 0, 0, $Bitmap.Size)
            $Bitmap.Save('{str(out_file)}')
            $Graphics.Dispose()
            $Bitmap.Dispose()
            """
            subprocess.run(["powershell", "-Command", cmd], capture_output=True, timeout=10)
            if out_file.exists():
                return f"Captured screen to {out_file}"
        except Exception as e:
            return f"Failed to capture screen: {e}"

    return "Screen capture requires PIL or Windows Forms."

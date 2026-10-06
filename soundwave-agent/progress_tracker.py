"""
Soundwave AI — Real-time Task Journal & Progress Tracker
Generates dynamic HTML status dashboards and persists execution state.
"""

import os
import json
import time
import platform
import subprocess
from pathlib import Path
from datetime import datetime
from typing import Dict, Any, Optional

STEPS = [
    ("check_server", "System & Server Check"),
    ("draft_script", "Viral Script & Hooks Generation"),
    ("synth_voice", "Neural Voice Synthesis (Edge TTS)"),
    ("align_subtitles", "Word-Level Subtitle Alignment"),
    ("select_background", "Orbital NCG Background Import (YouTube link importer)"),
    ("composite_video", "FFmpeg Vertical Video Compositor (9:16 60fps)"),
    ("verify_export", "MP4 Integrity & Duration Check"),
    ("complete_download", "Completed & Ready for Download"),
]

STATE_FILE = Path.home() / ".soundwave_state.json"
PROGRESS_FILE = Path.home() / ".soundwave_progress.log"
JOURNAL_FILE = Path.home() / ".soundwave_journal.jsonl"

def get_html_path() -> Path:
    """Return the destination path for the live progress HTML file."""
    candidates = [
        Path.cwd() / "soundwave_live_progress.html",
        Path(__file__).parent.parent / "soundwave_live_progress.html",
        Path.home() / "Downloads" / "soundwave_live_progress.html",
        Path.home() / ".soundwave_live_progress.html",
    ]
    for c in candidates:
        try:
            c.parent.mkdir(parents=True, exist_ok=True)
            return c
        except:
            continue
    return candidates[0]

def update_state(
    step_idx: int,
    status_msg: str,
    topic: str = "",
    voice: str = "en-US-JennyNeural",
    script: str = "",
    download_url: Optional[str] = None,
    extra: Optional[Dict[str, Any]] = None,
) -> Path:
    """Save execution state, append to journal, and render the live HTML."""
    now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    step_name = STEPS[min(step_idx, len(STEPS) - 1)][1] if step_idx > 0 else "Idle"

    state = {
        "step": step_idx,
        "total_steps": len(STEPS),
        "step_name": step_name,
        "progress": f"{step_idx}/{len(STEPS)}",
        "status": status_msg,
        "last_update": now_str,
        "heartbeat": time.time(),
        "topic": topic,
        "voice": voice,
        "script": script,
        "download_url": download_url,
        "extra": extra or {},
    }

    try:
        with open(STATE_FILE, "w", encoding="utf-8") as f:
            json.dump(state, f, indent=2)
    except:
        pass

    try:
        with open(PROGRESS_FILE, "a", encoding="utf-8") as f:
            f.write(f"[{now_str}] Step {step_idx}/{len(STEPS)} ({step_name}) — {status_msg}\n")
    except:
        pass

    try:
        with open(JOURNAL_FILE, "a", encoding="utf-8") as f:
            f.write(json.dumps({"time": time.time(), "step": step_idx, "name": step_name, "status": status_msg}) + "\n")
    except:
        pass

    return render_html_dashboard(state)

def render_html_dashboard(state: Dict[str, Any]) -> Path:
    """Generate a sleek, responsive HTML dashboard that refreshes every 2 seconds."""
    html_path = get_html_path()
    current_step = state.get("step", 0)
    step_name = state.get("step_name", "Standby")
    progress = state.get("progress", "0/8")
    status = state.get("status", "System ready")
    topic = state.get("topic", "")
    voice = state.get("voice", "en-US-JennyNeural")
    script = state.get("script", "")
    download_url = state.get("download_url")

    steps_markup = ""
    for idx, (code, title) in enumerate(STEPS, start=1):
        if idx < current_step:
            cls = "done"
            icon = "✓"
        elif idx == current_step:
            cls = "current"
            icon = "●"
        else:
            cls = "pending"
            icon = "○"
        steps_markup += f'<div class="step {cls}"><span class="step-icon">{icon}</span> <b>{idx}/{len(STEPS)} {title}</b></div>\n'

    log_tail = ""
    try:
        if PROGRESS_FILE.exists():
            with open(PROGRESS_FILE, "r", encoding="utf-8") as f:
                lines = f.readlines()[-15:]
                log_tail = "".join(f"<div class='log-line'>{l.strip()}</div>" for l in lines)
    except:
        pass

    download_section = ""
    if download_url:
        download_section = f"""
        <div class="card success-card">
          <h2>🎉 Short Rendered & Ready!</h2>
          <p>Your video was rendered in 9:16 vertical format (60 FPS, TikTok #8B5CF6 captions).</p>
          <a href="{download_url}" class="button" target="_blank">Download MP4</a>
        </div>
        """

    html_content = f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Soundwave Agent — {progress} {step_name}</title>
  <meta http-equiv="refresh" content="2">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    * {{ box-sizing: border-box; margin: 0; padding: 0; }}
    body {{ background: #0A0F1C; color: #E2E8F0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Inter, sans-serif; padding: 24px; line-height: 1.5; }}
    .container {{ max-width: 840px; margin: 0 auto; }}
    header {{ display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid #1E293B; padding-bottom: 16px; margin-bottom: 24px; }}
    h1 {{ font-size: 20px; font-weight: 700; color: #FFFFFF; display: flex; align-items: center; gap: 8px; }}
    .status-badge {{ background: #8B5CF622; color: #C084FC; border: 1px solid #8B5CF666; padding: 4px 12px; border-radius: 9999px; font-size: 12px; font-weight: 600; }}
    .card {{ background: #111827; border: 1px solid #1F2937; border-radius: 14px; padding: 20px; margin-bottom: 20px; }}
    .success-card {{ border-color: #10B98144; background: #064E3B18; }}
    .step {{ padding: 10px 14px; margin: 6px 0; border-radius: 8px; display: flex; align-items: center; gap: 10px; font-size: 14px; }}
    .step.done {{ background: #10B98115; border: 1px solid #10B98133; color: #6EE7B7; }}
    .step.current {{ background: #3B82F620; border: 1px solid #3B82F655; color: #93C5FD; font-weight: 600; animation: pulse 1.5s infinite; }}
    .step.pending {{ background: #1E293B40; border: 1px solid #1E293B88; color: #64748B; }}
    .step-icon {{ width: 20px; height: 20px; display: inline-flex; align-items: center; justify-content: center; border-radius: 50%; font-size: 11px; }}
    @keyframes pulse {{ 0% {{ opacity: 1; }} 50% {{ opacity: 0.75; }} 100% {{ opacity: 1; }} }}
    pre {{ background: #070B14; border: 1px solid #1E293B; border-radius: 8px; padding: 14px; font-size: 13px; color: #CBD5E1; white-space: pre-wrap; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }}
    .log-box {{ background: #070B14; border: 1px solid #1E293B; border-radius: 8px; padding: 12px; max-height: 220px; overflow-y: auto; font-family: monospace; font-size: 11px; color: #94A3B8; }}
    .log-line {{ padding: 2px 0; }}
    .button {{ display: inline-block; background: linear-gradient(135deg, #06B6D4, #8B5CF6); color: #FFF; text-decoration: none; padding: 10px 20px; border-radius: 8px; font-weight: 600; font-size: 14px; margin-top: 12px; }}
    .tag {{ display: inline-block; font-size: 11px; background: #1E293B; padding: 2px 8px; border-radius: 4px; color: #94A3B8; margin-right: 6px; }}
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>🌊 Soundwave Agent — Live Monitor</h1>
      <span class="status-badge">{progress} · {step_name}</span>
    </header>

    {download_section}

    <div class="card">
      <h3 style="font-size: 15px; margin-bottom: 12px;">Current Operation</h3>
      <p style="font-size: 14px; color: #38BDF8; font-weight: 600; margin-bottom: 8px;">{status}</p>
      <div>
        <span class="tag">Topic: {topic or 'Viral Niche'}</span>
        <span class="tag">Voice: {voice}</span>
        <span class="tag">Preset: TikTok #8B5CF6</span>
        <span class="tag">Aspect: 9:16 Portrait 60fps</span>
      </div>
      {f'<div style="margin-top: 14px;"><h4 style="font-size: 12px; color: #64748B; margin-bottom: 6px;">SCRIPT</h4><pre>{script}</pre></div>' if script else ''}
    </div>

    <div class="card">
      <h3 style="font-size: 15px; margin-bottom: 12px;">Pipeline Progress</h3>
      {steps_markup}
    </div>

    <div class="card">
      <h3 style="font-size: 15px; margin-bottom: 8px;">Real-time Log Tail</h3>
      <div class="log-box">{log_tail or 'Waiting for logs...'}</div>
    </div>
  </div>
</body>
</html>"""

    try:
        with open(html_path, "w", encoding="utf-8") as f:
            f.write(html_content)
    except:
        pass

    return html_path

def open_in_browser(path: Path) -> bool:
    """Launch the live progress file in the user's default browser."""
    try:
        sys_name = platform.system()
        if sys_name == "Windows":
            os.startfile(str(path))
        elif sys_name == "Darwin":
            subprocess.Popen(["open", str(path)])
        else:
            subprocess.Popen(["xdg-open", str(path)])
        return True
    except:
        return False

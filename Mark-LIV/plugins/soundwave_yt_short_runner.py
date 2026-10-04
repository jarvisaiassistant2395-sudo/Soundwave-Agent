"""
Soundwave AI — Autonomous Viral Shorts Runner Plugin
Original, commercial-ready video short generator for Soundwave AI.
"""

import sys
from pathlib import Path

# Add soundwave-agent to path
root_agent = Path(__file__).resolve().parent.parent.parent / "soundwave-agent"
if root_agent.exists() and str(root_agent) not in sys.path:
    sys.path.insert(0, str(root_agent))

try:
    from short_runner import generate_single_short, generate_all_niches_batch, ensure_server_running
    from plugins.shorts_plugin import run
except ImportError:
    pass

PLUGIN = {
    "name": "soundwave_yt_short_runner",
    "description": "Soundwave AI Viral Short Generator — creates 9:16 vertical shorts with TTS voiceover, TikTok #8B5CF6 subtitles, and Orbital NCG gameplay backgrounds (an unused youtube.com/@OrbitalNCG video per short, imported via the YouTube link importer) in 1 click or batch across all 7 niches.",
    "parameters": {
        "type": "OBJECT",
        "properties": {
            "action": {
                "type": "STRING",
                "description": "generate_yt_short, batch_all, check_site, open_progress",
                "enum": ["generate_yt_short", "batch_all", "generate_all_niches", "check_site", "open_progress"]
            },
            "topic": {"type": "STRING", "description": "Topic e.g. psychology, facts, history, finance, ai, motivation, horror"},
            "voice": {"type": "STRING", "description": "Voice Jenny default en-US-JennyNeural"},
            "resolution": {"type": "STRING", "description": "720p or 1080p", "enum": ["720p", "1080p"]}
        },
        "required": ["action"]
    }
}

def run(parameters, player=None, session_memory=None):
    action = (parameters.get("action") or "generate_yt_short").lower()
    topic = parameters.get("topic") or "psychology"
    voice = parameters.get("voice") or "en-US-JennyNeural"
    resolution = parameters.get("resolution") or "720p"

    if action in ("batch_all", "generate_all_niches", "batch_viral", "all_niches"):
        from short_runner import generate_all_niches_batch
        res = generate_all_niches_batch(voice=voice, resolution=resolution)
        return f"Soundwave Agent: Batch complete. Generated {len(res)} shorts in Downloads/ or exports/."

    if action == "check_site":
        from short_runner import ensure_server_running
        ok = ensure_server_running()
        return f"Soundwave Server Status: {'ONLINE (Port 4000)' if ok else 'OFFLINE (Start with cd server && npm run dev)'}"

    from short_runner import generate_single_short
    out_file = generate_single_short(topic=topic, voice=voice, resolution=resolution, open_browser=True)
    if out_file:
        return f"Soundwave Agent: Video rendered and saved to {out_file}."
    return "Soundwave Agent: Failed to generate video. Please verify the Soundwave server is running on port 4000."

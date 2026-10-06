"""
Soundwave AI — Autonomous Shorts Runner Plugin
"""

from typing import Dict, Any, Optional
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent))

from plugins.base_plugin import SoundwavePlugin
from short_runner import generate_single_short, generate_all_niches_batch, ensure_server_running
from progress_tracker import get_html_path, open_in_browser

class ShortsRunnerPlugin(SoundwavePlugin):
    def __init__(self):
        super().__init__(
            name="soundwave_shorts_runner",
            description="Autonomous vertical video generator for Soundwave AI. Creates viral shorts in 1 click or batch."
        )

    def get_manifest(self) -> Dict[str, Any]:
        return {
            "name": self.name,
            "description": self.description,
            "parameters": {
                "type": "OBJECT",
                "properties": {
                    "action": {
                        "type": "STRING",
                        "description": "Action: generate_short, batch_all, check_server, open_progress",
                        "enum": ["generate_short", "batch_all", "check_server", "open_progress"]
                    },
                    "topic": {
                        "type": "STRING",
                        "description": "Niche or custom topic (psychology, facts, history, finance, ai, motivation, horror)"
                    },
                    "voice": {
                        "type": "STRING",
                        "description": "Narrator voice (default: en-US-JennyNeural)"
                    },
                    "resolution": {
                        "type": "STRING",
                        "description": "Resolution: 720p or 1080p",
                        "enum": ["720p", "1080p"]
                    }
                },
                "required": ["action"]
            }
        }

    def execute(self, parameters: Dict[str, Any], context: Optional[Dict[str, Any]] = None) -> str:
        action = (parameters.get("action") or "generate_short").lower()

        if action == "check_server":
            running = ensure_server_running()
            return f"Soundwave Server Status: {'ONLINE (Port 4000)' if running else 'OFFLINE (Run: cd server && npm run dev)'}"

        if action == "open_progress":
            html_path = get_html_path()
            open_in_browser(html_path)
            return f"Opened live progress dashboard at {html_path}"

        voice = parameters.get("voice") or "en-US-JennyNeural"
        resolution = parameters.get("resolution") or "720p"

        if action == "batch_all":
            results = generate_all_niches_batch(voice=voice, resolution=resolution)
            return f"Batch generation complete. Successfully created {len(results)} videos in exports/ or Downloads/."

        topic = parameters.get("topic") or "psychology"
        out_file = generate_single_short(topic=topic, voice=voice, resolution=resolution, open_browser=True)
        if out_file:
            return f"Viral short generated successfully! Saved to: {out_file}"
        else:
            return "Failed to complete video export. Check server logs."

def run(parameters: Dict[str, Any], player: Any = None, session_memory: Any = None) -> str:
    """Standard run entrypoint for assistant host systems."""
    plugin = ShortsRunnerPlugin()
    return plugin.execute(parameters, {"player": player, "memory": session_memory})

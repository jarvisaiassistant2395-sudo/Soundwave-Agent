"""
Soundwave AI — Viral Script Engine Plugin
Original, commercial-ready viral short script generator for Soundwave AI.
"""

import sys
from pathlib import Path

# Add soundwave-agent to path
root_agent = Path(__file__).resolve().parent.parent.parent / "soundwave-agent"
if root_agent.exists() and str(root_agent) not in sys.path:
    sys.path.insert(0, str(root_agent))

try:
    from viral_engine import generate_viral_script, list_niches, list_hooks, NICHES
    from plugins.viral_plugin import PLUGIN, run
except ImportError:
    # Standalone fallback definition
    PLUGIN = {
        "name": "soundwave_viral_engine",
        "description": "Generates 2026 viral hooks and scripts across 7 proven niches (psychology, facts, history, finance, ai, motivation, horror).",
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "action": {"type": "STRING", "description": "generate, list_niches, list_hooks"},
                "topic": {"type": "STRING", "description": "psychology, facts, history, finance, ai, motivation, horror"},
                "style": {"type": "STRING", "description": "curiosity_gap, contrarian, stakes_warning, listicle, direct_callout, story_cold_open"}
            },
            "required": ["action"]
        }
    }

    def run(parameters, player=None, session_memory=None):
        topic = parameters.get("topic") or "psychology"
        return f"Soundwave Viral Engine: generating script for {topic}."

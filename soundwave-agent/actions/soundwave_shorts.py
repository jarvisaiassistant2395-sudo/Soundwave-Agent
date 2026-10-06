"""
Action: soundwave_shorts
Autonomous vertical video generator (Shorts, TikTok, Reels) powered by Soundwave AI.
"""

import sys
from pathlib import Path
from typing import Dict, Any

sys.path.insert(0, str(Path(__file__).parent.parent))
from short_runner import generate_single_short, generate_all_niches_batch

TOOL = {
    "name": "soundwave_shorts",
    "description": "Generates complete, high-retention faceless viral shorts with research-backed hooks, neural voiceover, and TikTok subtitles.",
    "parameters": {
        "type": "OBJECT",
        "properties": {
            "action": {
                "type": "STRING",
                "description": "single or batch",
                "enum": ["single", "batch"]
            },
            "niche": {
                "type": "STRING",
                "description": "psychology, facts, history, finance, ai, motivation, horror"
            },
            "voice": {
                "type": "STRING",
                "description": "Narrator voice (default: en-US-JennyNeural)"
            }
        },
        "required": ["action"]
    }
}

def handler(parameters: Dict[str, Any], context: Any = None) -> str:
    action = (parameters.get("action") or "single").lower()
    voice = parameters.get("voice") or "en-US-GuyNeural"

    if action == "batch":
        res = generate_all_niches_batch(voice=voice)
        return f"Batch production complete. Created {len(res)} viral shorts in your Downloads folder."

    niche = parameters.get("niche") or "psychology"
    out = generate_single_short(topic=niche, voice=voice, open_browser=True)
    if out:
        return f"Successfully generated viral short! Saved to: {out.name}"
    return "Failed to generate short. Make sure the Soundwave AI server is running on port 4000."

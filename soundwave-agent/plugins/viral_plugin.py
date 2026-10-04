"""
Soundwave AI — Viral Script Generator Plugin
"""

from typing import Dict, Any, Optional
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent))

from plugins.base_plugin import SoundwavePlugin
from viral_engine import generate_viral_script, list_niches, list_hooks, NICHES

class ViralScriptPlugin(SoundwavePlugin):
    def __init__(self):
        super().__init__(
            name="soundwave_viral_engine",
            description="Generates research-backed viral hooks and scripts for vertical video across 7 proven niches."
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
                        "description": "Action: generate, list_niches, list_hooks",
                        "enum": ["generate", "list_niches", "list_hooks"]
                    },
                    "niche": {
                        "type": "STRING",
                        "description": "Niche: psychology, facts, history, finance, ai, motivation, horror",
                        "enum": list(NICHES.keys())
                    },
                    "style": {
                        "type": "STRING",
                        "description": "Hook style: curiosity_gap, contrarian, stakes_warning, listicle, direct_callout, story_cold_open"
                    }
                },
                "required": ["action"]
            }
        }

    def execute(self, parameters: Dict[str, Any], context: Optional[Dict[str, Any]] = None) -> str:
        action = (parameters.get("action") or "generate").lower()
        if action == "list_niches":
            niches = list_niches()
            lines = ["Soundwave Viral Niches:"]
            for n in niches:
                lines.append(f"- {n['id'].upper()}: {n['name']} (RPM: {n['rpm']})")
            return "\n".join(lines)

        if action == "list_hooks":
            hooks = list_hooks()
            lines = ["Soundwave Hook Frameworks:"]
            for k, v in hooks.items():
                lines.append(f"- {k}: {v}")
            return "\n".join(lines)

        niche = parameters.get("niche") or "psychology"
        style = parameters.get("style")
        script = generate_viral_script(niche, style)
        return f"Generated {niche.upper()} Script:\n\n{script}"

def run(parameters: Dict[str, Any], player: Any = None, session_memory: Any = None) -> str:
    """Standard run entrypoint for assistant host systems."""
    plugin = ViralScriptPlugin()
    return plugin.execute(parameters, {"player": player, "memory": session_memory})

"""
Soundwave AI — Memory Manager
Handles recallable facts, user preferences, and cross-session knowledge.
"""

import json
import time
from pathlib import Path
from typing import Dict, Any, List, Optional

DEFAULT_MEMORY_FILE = Path.home() / ".soundwave" / "memory.json"

class MemoryManager:
    def __init__(self, file_path: Optional[Path] = None):
        self.file_path = file_path or DEFAULT_MEMORY_FILE
        self.data: Dict[str, Any] = {
            "identity": {
                "user_name": "User",
                "assistant_name": "Soundwave",
                "created_at": time.time(),
            },
            "facts": [],
            "preferences": {
                "default_niche": "psychology",
                "default_voice": "en-US-JennyNeural",
                "theme": "cyan_glow",
                "speech_rate": 1.0,
            },
            "recent_sessions": [],
        }
        self.load()

    def load(self):
        try:
            if self.file_path.exists():
                with open(self.file_path, "r", encoding="utf-8") as f:
                    loaded = json.load(f)
                    self.data.update(loaded)
        except Exception:
            pass

    def save(self):
        try:
            self.file_path.parent.mkdir(parents=True, exist_ok=True)
            with open(self.file_path, "w", encoding="utf-8") as f:
                json.dump(self.data, f, indent=2, ensure_ascii=False)
        except Exception as e:
            print(f"[Memory] Failed to save memory: {e}")

    def remember(self, key: str, value: Any):
        """Store a key-value fact or preference."""
        self.data["preferences"][key] = value
        self.add_fact(f"{key}: {value}", category="preference")
        self.save()

    def recall(self, key: str) -> Optional[Any]:
        """Recall a stored key-value preference."""
        return self.data["preferences"].get(key)

    def dump(self) -> str:
        """Dump memory representation as formatted JSON."""
        return json.dumps(self.data, indent=2)

    def add_fact(self, fact: str, category: str = "general"):
        """Store a new fact or preference about the user."""
        self.data["facts"].append({
            "text": fact,
            "category": category,
            "timestamp": time.time(),
        })
        self.save()

    def get_facts(self, query: Optional[str] = None) -> List[str]:
        """Retrieve stored facts, optionally filtered by keyword."""
        all_facts = [f["text"] for f in self.data["facts"]]
        if not query:
            return all_facts
        q = query.lower()
        return [f for f in all_facts if q in f.lower()]

    def clear_facts(self):
        self.data["facts"] = []
        self.save()

    def get_identity(self) -> Dict[str, Any]:
        return self.data.get("identity", {})

    def set_user_name(self, name: str):
        self.data["identity"]["user_name"] = name
        self.save()

    def set_assistant_name(self, name: str):
        self.data["identity"]["assistant_name"] = name
        self.save()

memory_manager = MemoryManager()

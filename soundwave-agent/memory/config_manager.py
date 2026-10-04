"""
Soundwave AI — Configuration & API Keys Manager
Manages LLM API keys (Gemini, OpenRouter, OpenAI), UI preferences, audio settings.
"""

import json
from pathlib import Path
from typing import Dict, Any, Optional

DEFAULT_CONFIG_FILE = Path.home() / ".soundwave" / "config.json"

class ConfigManager:
    def __init__(self, file_path: Optional[Path] = None):
        self.file_path = file_path or DEFAULT_CONFIG_FILE
        self.config: Dict[str, Any] = {
            "api_keys": {
                "gemini": "",
                "openrouter": "",
                "openai": "",
            },
            "assistant": {
                "name": "Soundwave",
                "voice": "en-US-JennyNeural",
                "wake_word": "Hey Soundwave",
                "auto_sleep_seconds": 120,
            },
            "audio": {
                "input_device": "Default Microphone",
                "output_device": "Default Speakers",
                "volume": 100,
            },
            "theme": "cyan_glow",
            "plugins_enabled": {},
        }
        self.load()

    def load(self):
        try:
            if self.file_path.exists():
                with open(self.file_path, "r", encoding="utf-8") as f:
                    self.config.update(json.load(f))
        except Exception:
            pass

    def save(self):
        try:
            self.file_path.parent.mkdir(parents=True, exist_ok=True)
            with open(self.file_path, "w", encoding="utf-8") as f:
                json.dump(self.config, f, indent=2, ensure_ascii=False)
        except Exception as e:
            print(f"[Config] Failed to save config: {e}")

    def get_api_key(self, provider: str = "gemini") -> str:
        return self.config.get("api_keys", {}).get(provider, "")

    def set_api_key(self, provider: str, key: str):
        if "api_keys" not in self.config:
            self.config["api_keys"] = {}
        self.config["api_keys"][provider] = key.strip()
        self.save()

    def get_assistant_name(self) -> str:
        return self.config.get("assistant", {}).get("name", "Soundwave")

    def set_assistant_name(self, name: str):
        if "assistant" not in self.config:
            self.config["assistant"] = {}
        self.config["assistant"]["name"] = name.strip()
        self.save()

    def set(self, key: str, value: Any):
        """Generic config setter."""
        if key == "assistant_name":
            self.set_assistant_name(str(value))
        elif key in self.config:
            self.config[key] = value
            self.save()
        else:
            self.config[key] = value
            self.save()

    def get(self, key: str, default: Any = None) -> Any:
        """Generic config getter."""
        if key == "assistant_name":
            return self.get_assistant_name()
        return self.config.get(key, default)

config_manager = ConfigManager()

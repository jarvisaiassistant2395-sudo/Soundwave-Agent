"""
Soundwave AI — Base Plugin Interface
Original, modular plugin architecture designed for clean extensibility.
"""

from abc import ABC, abstractmethod
from typing import Dict, Any, Optional

class SoundwavePlugin(ABC):
    """Base class for all Soundwave AI plugins and skills."""

    def __init__(self, name: str, description: str):
        self.name = name
        self.description = description

    @abstractmethod
    def get_manifest(self) -> Dict[str, Any]:
        """Return the plugin specification and parameter schema."""
        pass

    @abstractmethod
    def execute(self, parameters: Dict[str, Any], context: Optional[Dict[str, Any]] = None) -> str:
        """Run the plugin action with given parameters and return a status string."""
        pass

BasePlugin = SoundwavePlugin

"""
Soundwave AI — Action Loader
Discovers, validates, and dispatches bundled computer-control actions and skills.
"""

import os
import sys
import importlib.util
from pathlib import Path
from typing import Dict, Any, Callable, Optional, List

class ActionRegistry:
    def __init__(self):
        self.actions: Dict[str, Dict[str, Any]] = {}
        self.handlers: Dict[str, Callable[..., Any]] = {}

    def discover_actions(self, actions_dir: Optional[Path] = None):
        """Auto-discover all .py action modules in the actions directory."""
        if actions_dir is None:
            actions_dir = Path(__file__).parent.parent / "actions"

        if not actions_dir.exists():
            return

        for f in actions_dir.glob("*.py"):
            if f.name.startswith("_"):
                continue
            module_name = f.stem
            try:
                spec = importlib.util.spec_from_file_location(f"actions.{module_name}", str(f))
                if spec and spec.loader:
                    mod = importlib.util.module_from_spec(spec)
                    spec.loader.exec_module(mod)

                    tool_decl = getattr(mod, "TOOL", None)
                    handler_fn = getattr(mod, "handler", None) or getattr(mod, "run", None)

                    if tool_decl and handler_fn:
                        action_name = tool_decl.get("name", module_name)
                        self.actions[action_name] = tool_decl
                        self.handlers[action_name] = handler_fn
            except Exception as e:
                print(f"[ActionLoader] Failed to load action {f.name}: {e}")

    def list_tools(self) -> List[Dict[str, Any]]:
        """Return all declared tools for LLM function calling schema."""
        return list(self.actions.values())

    def list_actions(self) -> List[str]:
        """Return list of all registered action names."""
        return list(self.actions.keys())

    def has_action(self, action_name: str) -> bool:
        """Check if an action is registered."""
        return action_name in self.actions

    def get_action(self, action_name: str) -> Optional[Dict[str, Any]]:
        """Get action declaration details."""
        return self.actions.get(action_name)

    def execute(self, action_name: str, parameters: Dict[str, Any], context: Optional[Dict[str, Any]] = None) -> Any:
        """Execute an action by name."""
        handler = self.handlers.get(action_name)
        if not handler:
            return f"Action '{action_name}' not found."
        try:
            return handler(parameters, context=context)
        except TypeError:
            try:
                return handler(parameters)
            except Exception as e:
                return f"Action execution error: {e}"
        except Exception as e:
            return f"Action execution error: {e}"

action_registry = ActionRegistry()

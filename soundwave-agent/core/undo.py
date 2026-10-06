"""
Soundwave AI — Undo Stack
Tracks reversible actions and provides clean rollback mechanisms.
"""

from typing import Callable, Any, List, Optional, Tuple, Dict

class UndoManager:
    def __init__(self, max_history: int = 50):
        self.stack: List[Tuple[str, Callable[..., Any], Any]] = []
        self.max_history = max_history

    def register(self, description: str, undo_fn: Callable[..., Any], context: Any = None):
        """Register a reversible action."""
        if len(self.stack) >= self.max_history:
            self.stack.pop(0)
        self.stack.append((description, undo_fn, context))

    def push_action(self, action_name: str, payload: Any = None, undo_fn: Optional[Callable[..., Any]] = None):
        """Convenience method to push an action into the history."""
        fn = undo_fn if undo_fn is not None else (lambda ctx: True)
        self.register(action_name, fn, payload)

    def pop_action(self) -> Optional[Dict[str, Any]]:
        """Pop the most recent action representation."""
        if not self.stack:
            return None
        desc, fn, ctx = self.stack.pop()
        return {"action": desc, "context": ctx}

    def can_undo(self) -> bool:
        return len(self.stack) > 0

    def peek(self) -> Optional[str]:
        return self.stack[-1][0] if self.stack else None

    def undo_last(self) -> Tuple[bool, str]:
        """Undo the most recent reversible action."""
        if not self.stack:
            return False, "Nothing to undo."
        description, undo_fn, context = self.stack.pop()
        try:
            undo_fn(context)
            return True, f"Undid: {description}"
        except Exception as e:
            return False, f"Failed to undo '{description}': {e}"

    def clear(self):
        self.stack.clear()

undo_manager = UndoManager()

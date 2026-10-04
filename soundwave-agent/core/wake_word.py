"""
Soundwave AI — Wake Word & Assistant State Machine
Tracks active / listening / speaking / sleep states with auto-sleep timers and callbacks.
"""

import time
import threading
from typing import Callable, Optional, List

class AssistantState:
    ASLEEP = "ASLEEP"
    AWAKE = "AWAKE"
    LISTENING = "LISTENING"
    THINKING = "THINKING"
    SPEAKING = "SPEAKING"

class WakeWordEngine:
    def __init__(self, wake_word: str = "Hey Soundwave", auto_sleep_seconds: int = 120):
        self.wake_word = wake_word
        self.auto_sleep_seconds = auto_sleep_seconds
        self.current_state = AssistantState.AWAKE
        self.last_activity = time.time()
        self.listeners: List[Callable[[str], None]] = []
        self._running = False
        self._monitor_thread: Optional[threading.Thread] = None

    def add_state_listener(self, callback: Callable[[str], None]):
        """Subscribe to state change events (e.g. for HUD visualizer updates)."""
        self.listeners.append(callback)

    def set_state(self, new_state: str):
        if self.current_state != new_state:
            self.current_state = new_state
            self.last_activity = time.time()
            for cb in self.listeners:
                try:
                    cb(new_state)
                except Exception:
                    pass

    def wake(self):
        """Wake up the assistant from sleep."""
        self.set_state(AssistantState.AWAKE)

    def sleep(self):
        """Put assistant into sleep mode."""
        self.set_state(AssistantState.ASLEEP)

    def touch(self):
        """Register user interaction to keep awake."""
        self.last_activity = time.time()
        if self.current_state == AssistantState.ASLEEP:
            self.wake()

    def start_monitor(self):
        """Start auto-sleep timer thread."""
        self._running = True
        self._monitor_thread = threading.Thread(target=self._monitor_loop, daemon=True)
        self._monitor_thread.start()

    def stop_monitor(self):
        self._running = False

    def _monitor_loop(self):
        while self._running:
            time.sleep(2)
            if self.current_state != AssistantState.ASLEEP:
                idle = time.time() - self.last_activity
                if idle >= self.auto_sleep_seconds:
                    self.sleep()

    def check_text(self, text: str) -> bool:
        """Check if incoming transcription text contains a wake word trigger."""
        t = text.lower().strip()
        triggers = ["soundwave", "jarvis", "computer", self.wake_word.lower()]
        for trig in triggers:
            if trig in t:
                self.wake()
                return True
        return False

wake_engine = WakeWordEngine()
wake_detector = wake_engine

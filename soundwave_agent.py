#!/usr/bin/env python3
"""
Soundwave AI — Root Launcher
Redirects to soundwave-agent/main.py
"""

import sys
from pathlib import Path

agent_dir = Path(__file__).parent / "soundwave-agent"
sys.path.insert(0, str(agent_dir))

from main import main

if __name__ == "__main__":
    main()

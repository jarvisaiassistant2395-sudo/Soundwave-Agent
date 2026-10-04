#!/usr/bin/env python3
"""Self-check of the local voice service — no models, no downloads, no network.

    pip install fastapi numpy        # the whole mock path needs nothing else
    python selftest.py

Verifies the parts the Node app depends on: the health payload (both engines and
their licences), the narration voice list, one synthesized WAV (mock engine), the
refusals an unknown voice and an out-of-range speed must produce, and the WAV
encoder. Exits non-zero with a clear line if anything is wrong.

Why this exists: the Node tests pin the *HTTP contract* with a stand-in, and CI
runs no Python. This is the check that the real service still matches that
contract — run it whenever voiceclone/server.py changes, and in the Docker image
(see the Dockerfile's HEALTHCHECK note).
"""

import io
import os
import re
import sys
import wave

# Mock engines: no Chatterbox, no Kokoro, no multi-GB downloads. The point is the
# service's own logic, not the models' output.
os.environ.setdefault("CHATTERBOX_MOCK", "1")
os.environ.setdefault("VOICECLONE_PROFILES_DIR", "/tmp/soundwave-voice-selftest")

failures: list[str] = []


def check(name: str, condition: bool, detail: str = "") -> None:
    if condition:
        print(f"✓ {name}")
    else:
        print(f"✗ {name}{f' — {detail}' if detail else ''}")
        failures.append(name)


import server  # noqa: E402  (after the environment is set)
from fastapi import HTTPException  # noqa: E402

# ── Health: both engines, with the licences stated ──────────────────────────
health = server.health()
check("health says ok", health.get("ok") is True)
engines = health.get("engines", {})
check("health lists the cloning engine with its licence", engines.get("chatterbox", {}).get("weights") == "MIT")
check(
    "health lists the narration engine with its licence",
    engines.get("kokoro", {}).get("weights") == "Apache-2.0" and engines.get("kokoro", {}).get("loaded") is True,
)

# ── The narration voice list ────────────────────────────────────────────────
voices = server.kokoro_voices()
ids = [v["id"] for v in voices["voices"]]
check("the narration list is non-empty", len(ids) >= 20, f"{len(ids)} voices")
check("voice ids are unique", len(set(ids)) == len(ids))
check(
    "every voice id is a real Kokoro id (a/b + f/m + name)",
    all(len(i) >= 4 and i[0] in "ab" and i[1] in "fm" and i[2] == "_" for i in ids),
    ", ".join(i for i in ids if not (i[0] in "ab" and i[1] in "fm" and i[2] == "_")) or "none",
)
check("exactly one voice is marked as the default", sum(1 for v in voices["voices"] if v.get("default")) == 1)
check("both accents are offered", {v["accent"] for v in voices["voices"]} == {"American", "British"})
check("both genders are offered", {v["gender"] for v in voices["voices"]} == {"Female", "Male"})

# ── One clip, and the WAV it must be ────────────────────────────────────────
wav, duration = server._render_kokoro(server.KokoroRequest(text="Soundwave speaks on this PC.", voice="bf_emma", speed=1.2))
check("a clip comes back", len(wav) > 1000, f"{len(wav)} bytes")
check("the clip is a RIFF/WAVE file", wav[:4] == b"RIFF" and wav[8:12] == b"WAVE")
check("the reported duration is positive", duration > 0.2, f"{duration:.2f}s")
with wave.open(io.BytesIO(wav)) as handle:
    check("it is mono 16-bit", handle.getnchannels() == 1 and handle.getsampwidth() == 2)
    check("it is 24 kHz (Kokoro's rate)", handle.getframerate() == 24_000, str(handle.getframerate()))
    check(
        "its length matches the reported duration",
        abs(handle.getnframes() / handle.getframerate() - duration) < 0.05,
    )

# ── Refusals: said out loud, with the available list ────────────────────────
try:
    server._render_kokoro(server.KokoroRequest(text="hi", voice="af_hurt"))
    check("an unknown narration voice is refused", False, "no exception raised")
except HTTPException as exc:
    check(
        "an unknown narration voice is refused with the real list",
        exc.status_code == 400 and "Available:" in str(exc.detail),
        f"{exc.status_code} {exc.detail}",
    )

try:
    server._render_kokoro(server.KokoroRequest(text="hi", voice="af_heart", speed=3.0))
    check("an out-of-range speed is refused", False, "no exception raised (pydantic should have)")
except Exception as exc:  # noqa: BLE001 — pydantic ValidationError from the request model
    check("an out-of-range speed is refused", "speed" in str(exc).lower(), str(exc)[:80])

# ── The encoder itself ─────────────────────────────────────────────────────
import numpy as np  # noqa: E402

encoded = server._encode_wav(np.zeros(4800, dtype="float32"), 24_000)
check("the encoder writes a 0.2 s WAV at the requested rate", len(encoded) == 44 + 4800 * 2, f"{len(encoded)} bytes")

# ── The licence guarantee, checked against the source itself ────────────────
# The narration engine must not go through upstream's `kokoro.KPipeline` (which
# imports misaki.espeak → phonemizer/espeak-ng, both GPL-3.0). This is a static
# check so it runs even where torch isn't installed; the runtime guard in
# KokoroEngine.__init__ is the enforcement.
here = os.path.dirname(os.path.abspath(__file__))
engine_src = open(os.path.join(here, "kokoro_engine.py"), encoding="utf-8").read()
server_src = open(os.path.join(here, "server.py"), encoding="utf-8").read()


def code_only(source: str) -> str:
    """The source without docstrings or comments — the warnings about espeak
    live in those, and only real code can import something."""
    import re

    without_docstrings = re.sub(r'"""[\s\S]*?"""', "", source)
    lines = [line.split("  #")[0] for line in without_docstrings.splitlines()]
    return "\n".join(line for line in lines if not line.strip().startswith("#"))


engine_code = code_only(engine_src)
server_code = code_only(server_src)
check(
    "nothing imports upstream's KPipeline (only its model code)",
    not re.search(r"^\s*(from kokoro import|import kokoro\.pipeline)", engine_code + server_code, re.M),
)
check("the engine uses misaki's English G2P directly", "from misaki import en" in engine_code)
check(
    "the engine never imports the espeak path",
    not re.search(r"^\s*(from misaki import[^\n]*espeak|import misaki\.espeak)", engine_code, re.M),
)
check("the runtime guard is present", "GPL-3.0 code in-process" in engine_src)
check("the GPL extras are named in the docs so nobody adds them", "phonemizer-fork" in open(os.path.join(here, "requirements.txt"), encoding="utf-8").read())

print()
if failures:
    print(f"{len(failures)} check(s) failed: {', '.join(failures)}")
    sys.exit(1)
print("all checks passed")

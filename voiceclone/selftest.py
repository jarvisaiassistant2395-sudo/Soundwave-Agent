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

# ── Optional: the real model, and the difference between speech and a hum ───
# "Kokoro only produced a weird humming noise" is the failure this project was
# warned about, so this mode does not just print "ok": it measures the audio and
# says whether it sounds like a person. It needs the weights (torch + kokoro +
# misaki) and downloads them once, so it is opt-in:
#
#     python selftest.py --real
#
# It writes selftest-output.wav next to this file so you can hear it yourself.


def real_check() -> None:
    import importlib

    text = "Hello. This is Soundwave speaking on your computer."
    print("── The real model ──")

    # Imported by hand so a missing install reads as a sentence, not a traceback.
    missing = [name for name in ("numpy", "torch", "kokoro", "misaki") if importlib.util.find_spec(name) is None]
    if missing:
        print(f"This interpreter has no {', '.join(missing)} \u2014 the real-model check needs the install:")
        print("    ./install.sh          (then run: python selftest.py --real)")
        print("It will download the model and one voice from Hugging Face (one time only).")
        return
    import numpy as np
    from kokoro_engine import KokoroEngine

    print(f"Synthesizing: \u201c{text}\u201d")
    print("(the first run downloads the model and the voice \u2014 one time only)\n")

    try:
        engine = KokoroEngine(device=os.environ.get("CHATTERBOX_DEVICE", "cpu"))
        pieces = list(engine.generate(text, voice="af_heart", speed=1.0))
    except ImportError as exc:
        check("the model actually runs here", False, f"{exc} \u2014 install it with ./install.sh")
        return
    except Exception as exc:  # noqa: BLE001
        check("the model actually runs here", False, f"{type(exc).__name__}: {exc}")
        return

    check("the model produced audio", bool(pieces) and sum(len(p) for p in pieces) > 0)
    if not pieces:
        return
    audio = np.concatenate([np.asarray(p, dtype="float32").reshape(-1) for p in pieces])
    rate = 24_000
    seconds = len(audio) / rate

    # The exact encoder the service uses, so the WAV you play is the WAV it sends.
    wav = server._encode_wav(audio, rate)
    out_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "selftest-output.wav")
    with open(out_path, "wb") as handle:
        handle.write(wav)

    # ── Measurements ────────────────────────────────────────────────────────
    peak = float(np.max(np.abs(audio)))
    rms = float(np.sqrt(np.mean(audio**2)))
    clipped = float(np.mean(np.abs(audio) > 0.999))

    # Average spectrum over 50 ms frames (Hann window) — the shape of the sound.
    frame, hop = 1200, 600
    window = np.hanning(frame)
    power = None
    for start in range(0, max(1, len(audio) - frame), hop):
        spectrum = np.abs(np.fft.rfft(audio[start : start + frame] * window)) ** 2
        power = spectrum if power is None else power + spectrum
    freqs = np.fft.rfftfreq(frame, 1 / rate)
    power = power if power is not None else np.zeros_like(freqs)
    total = float(power[(freqs >= 50) & (freqs <= 8000)].sum()) or 1e-12
    speech_band = float(power[(freqs >= 300) & (freqs <= 3400)].sum())
    band_ratio = speech_band / total
    # A drone is a handful of loud, pure tones; speech is broadband.
    in_band = power[(freqs >= 100) & (freqs <= 4000)]
    loud_bins = int(np.sum(in_band > 0.2 * in_band.max())) if in_band.size else 0

    # Silence: frames far quieter than the rest — real speech breathes, a broken
    # renderer either hums non-stop or outputs nothing at all.
    frames = [float(np.sqrt(np.mean(audio[i : i + frame] ** 2))) for i in range(0, max(1, len(audio) - frame), frame)]
    quiet = float(np.mean([f < 0.02 * max(rms, 1e-9) for f in frames])) if frames else 1.0

    print(f"  duration {seconds:.2f} s   peak {peak:.3f}   RMS {rms:.4f}   clipped {clipped*100:.2f}%")
    print(f"  energy in the speech band (300\u20133400 Hz): {band_ratio*100:.0f}%   broadband bins: {loud_bins}   quiet frames: {quiet*100:.0f}%")
    print(f"  written to: {out_path}\n")

    check("it lasts about as long as the sentence (not a fraction of a second, not a minute)", 1.2 <= seconds <= 12.0, f"{seconds:.2f} s")
    check("it is audible (not silence)", peak > 0.05 and rms > 0.005, f"peak {peak:.3f}, RMS {rms:.4f}")
    check("it is not clipping into noise", clipped < 0.005, f"{clipped*100:.2f}% of samples pinned")
    # The hum signature: energy piled up in a few low tones instead of the band
    # where speech lives. A 'brrrwmmrwbb' drone measures well under 0.5 here.
    check("it is speech-shaped, not a low drone", band_ratio > 0.5, f"only {band_ratio*100:.0f}% of the energy is where speech lives")
    check("it is broadband like a voice, not a handful of tones", loud_bins >= 15, f"{loud_bins} loud frequency bins")
    check("it is not one long dead tone", quiet < 0.9, f"{quiet*100:.0f}% of frames are near-silent")
    if peak <= 0.05 or band_ratio <= 0.5 or loud_bins < 15:
        print("  \u2192 This does not look like a voice. Common causes, in order:")
        print("      1. the voice pack and the model are from different Kokoro versions;")
        print("      2. something fed the model text instead of phonemes (see test_engine.py);")
        print("      3. playback at the wrong sample rate (this file is 24 kHz mono).")


if "--real" in sys.argv:
    print()
    real_check()

print()
if failures:
    print(f"{len(failures)} check(s) failed: {', '.join(failures)}")
    sys.exit(1)
print("all checks passed")

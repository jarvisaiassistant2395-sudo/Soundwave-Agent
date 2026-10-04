#!/usr/bin/env python3
"""
Chatterbox voice-clone sidecar for Soundwave AI.

Loads Resemble AI's Chatterbox voice-cloning model once and exposes a small JSON
API the Node backend proxies to.

Why this model and not the obvious alternatives: Chatterbox is MIT-licensed
**including the pre-trained weights** (github.com/resemble-ai/chatterbox,
verified 2026-10-04), so cloned voices can legally be sold. OmniVoice, which
this sidecar used before, has Apache-2.0 *code* but CC-BY-NC *weights* — the
maintainers confirmed on the model card that they "can't be used commercially"
(training data such as WenetSpeech-Yue and part of Emilia is non-commercial).
X(TTS v2), F5-TTS and Higgs Audio are non-commercial for the same reason; Piper's
current fork is GPL-3.0. Nothing here may be swapped for one of those without
this paragraph changing first.

    GET  /health                  → { ok, model_loaded, device, mock }
    GET  /profiles                → saved cloned voices
    POST /profiles                → create a cloned voice from a reference clip
                                    (multipart: file + name + optional refText)
    DELETE /profiles/{id}         → remove a cloned voice
    POST /clone                   → { text, profileId, speed? } → WAV
                                    (+ X-Audio-Duration header, seconds)

Set CHATTERBOX_MOCK=1 to run without the model (sine-wave output) — used for
development/testing the plumbing without downloading multi-GB weights.
"""

import io
import json
import math
import os
import secrets
import threading
import time
import uuid
from pathlib import Path

from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel, Field

# ── Config ───────────────────────────────────────────────────────────────────
# Chatterbox v1 (English) — MIT code and MIT weights. `nano=1` uses the smaller
# Turbo/Nano model, which is designed to run on CPU.
CHATTERBOX_NANO = os.environ.get("CHATTERBOX_NANO", "").lower() in ("1", "true", "yes")
DEVICE = os.environ.get("CHATTERBOX_DEVICE", "cpu")  # cpu | cuda:0 | mps | xpu
MOCK = os.environ.get("CHATTERBOX_MOCK", "").lower() in ("1", "true", "yes")
# Emotion dial (0 = flat, 1 = excited) and how strongly the reference clip is
# followed. Chatterbox's own defaults; env-tunable for a particular voice.
EXAGGERATION = float(os.environ.get("CHATTERBOX_EXAGGERATION", "0.5"))
CFG_WEIGHT = float(os.environ.get("CHATTERBOX_CFG_WEIGHT", "0.5"))
# Fallback sample rate until the model is loaded (Chatterbox v1 outputs 24 kHz).
DEFAULT_SAMPLE_RATE = 24_000

PROFILES_DIR = Path(os.environ.get("VOICECLONE_PROFILES_DIR", Path(__file__).parent / "profiles"))
PROFILES_DIR.mkdir(parents=True, exist_ok=True)
INDEX_PATH = PROFILES_DIR / "index.json"

# ── Model (loaded once at startup) ───────────────────────────────────────────
model = None
model_lock = threading.Lock()

if not MOCK:
    print(f"[voiceclone] loading Chatterbox on {DEVICE}{' (nano)' if CHATTERBOX_NANO else ''} — this can take a minute…", flush=True)
    try:
        if CHATTERBOX_NANO:
            from chatterbox.tts_turbo import ChatterboxTurboTTS as ModelClass
        else:
            from chatterbox.tts import ChatterboxTTS as ModelClass

        model = ModelClass.from_pretrained(device=DEVICE, nano=True) if CHATTERBOX_NANO else ModelClass.from_pretrained(device=DEVICE)
        print(f"[voiceclone] model ready ({getattr(model, 'sr', DEFAULT_SAMPLE_RATE)} Hz)", flush=True)
    except Exception as e:  # noqa: BLE001 — surface a clean startup failure
        print(f"[voiceclone] FATAL: failed to load Chatterbox: {e}", flush=True)
        raise

SAMPLE_RATE = int(getattr(model, "sr", DEFAULT_SAMPLE_RATE)) if not MOCK else DEFAULT_SAMPLE_RATE


def _reference_audio_ok(ref_path: Path) -> None:
    """Refuse a clip the model can't read, now rather than at first synthesis.

    Chatterbox conditions on the reference clip itself (`audio_prompt_path`), so
    there is nothing to precompute and store — only this check, so a broken
    upload is caught while the person is still looking at the form.
    """
    import torchaudio

    try:
        info = torchaudio.info(str(ref_path))
    except Exception as e:  # noqa: BLE001
        raise HTTPException(400, f"That reference clip couldn't be read: {e}") from e
    seconds = info.num_frames / max(1, info.sample_rate)
    if seconds < 2:
        raise HTTPException(400, "The reference clip is too short — use 3–10 seconds of clean speech.")
    if seconds > 60:
        raise HTTPException(400, "The reference clip is too long — use 3–10 seconds of clean speech.")


def _render(req: "CloneRequest", ref_path: Path) -> "tuple[bytes, float]":
    if req.speed is not None and abs(req.speed - 1.0) > 1e-6:
        # Chatterbox has no speed control (OmniVoice did). The narration engine
        # does — say where it works instead of quietly ignoring the request.
        raise HTTPException(400, "Cloned voices don't support a speed change — set the speed on the narration voice instead.")
    try:
        with model_lock:
            audio = model.generate(
                text=req.text,
                audio_prompt_path=str(ref_path),
                exaggeration=EXAGGERATION,
                cfg_weight=CFG_WEIGHT,
            )
    except Exception as e:  # noqa: BLE001
        raise HTTPException(500, f"Generation failed: {e}") from e
    samples = audio[0]
    duration = len(samples) / SAMPLE_RATE
    buf = io.BytesIO()
    import soundfile as sf

    sf.write(buf, samples, SAMPLE_RATE, format="WAV", subtype="PCM_16")
    return buf.getvalue(), duration


# ── API-token guard (set VOICECLONE_TOKEN when the service is on a public URL) ─
API_TOKEN = os.environ.get("VOICECLONE_TOKEN", "").strip()


def require_token(authorization: str | None = Header(default=None)) -> None:
    if not API_TOKEN:
        return  # no token configured → local/trusted-network mode
    prefix = "bearer "
    token = authorization[len(prefix):] if authorization and authorization.lower().startswith(prefix) else None
    if not token or not secrets.compare_digest(token, API_TOKEN):
        raise HTTPException(401, "Invalid or missing bearer token.")

# ── Profile index ────────────────────────────────────────────────────────────
index_lock = threading.Lock()


def _read_index() -> list[dict]:
    with index_lock:
        if not INDEX_PATH.exists():
            return []
        try:
            return json.loads(INDEX_PATH.read_text(encoding="utf-8"))
        except Exception:
            return []


def _write_index(items: list[dict]) -> None:
    with index_lock:
        INDEX_PATH.write_text(json.dumps(items, indent=2), encoding="utf-8")


def _stored_reference(profile_id: str) -> Path:
    """The reference clip saved for this profile (it is what the model clones)."""
    for ext in (".wav", ".mp3", ".flac", ".ogg", ".m4a"):
        path = PROFILES_DIR / f"{profile_id}.ref{ext}"
        if path.exists():
            return path
    raise HTTPException(404, "This voice's reference clip is missing — recreate the profile.")


def _get_profile(profile_id: str) -> dict | None:
    if not profile_id or any(c not in "0123456789abcdef-" for c in profile_id):
        return None
    return next((p for p in _read_index() if p["id"] == profile_id), None)


# ── App ──────────────────────────────────────────────────────────────────────
app = FastAPI(title="Soundwave AI voice-clone sidecar", docs_url=None, redoc_url=None)


@app.get("/health")
def health() -> dict:
    return {"ok": True, "model_loaded": MOCK or model is not None, "device": "mock" if MOCK else DEVICE, "mock": MOCK}


@app.get("/profiles", dependencies=[Depends(require_token)])
def list_profiles() -> list[dict]:
    return [
        {"id": p["id"], "name": p["name"], "createdAt": p["createdAt"], "hasRefText": bool(p.get("refText"))}
        for p in _read_index()
    ]


@app.post("/profiles", status_code=201, dependencies=[Depends(require_token)])
async def create_profile(
    file: UploadFile = File(...),
    name: str = Form(...),
    refText: str | None = Form(None),
) -> dict:
    name = name.strip()[:80]
    if not name:
        raise HTTPException(400, "A voice name is required.")
    data = await file.read()
    if len(data) < 1000:
        raise HTTPException(400, "The reference clip is too small — use 3–10 seconds of clean speech.")
    if len(data) > 25 * 1024 * 1024:
        raise HTTPException(400, "The reference clip is too large (max 25 MB).")

    profile_id = str(uuid.uuid4())
    ref_path = PROFILES_DIR / f"{profile_id}.ref{_ext_for(file.filename)}"
    ref_path.write_bytes(data)

    if not MOCK:
        # The clip itself is what the model conditions on, so make sure it is
        # readable and the right length before the profile exists.
        try:
            _reference_audio_ok(ref_path)
        except HTTPException:
            ref_path.unlink(missing_ok=True)
            raise
        except Exception as e:  # noqa: BLE001
            ref_path.unlink(missing_ok=True)
            raise HTTPException(500, f"Failed to read this reference clip: {e}") from e

    entry = {
        "id": profile_id,
        "name": name,
        "createdAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "refText": (refText or "").strip()[:2000],
    }
    items = [p for p in _read_index() if p["id"] != profile_id]
    items.append(entry)
    _write_index(items)
    return {"id": profile_id, "name": entry["name"], "createdAt": entry["createdAt"], "hasRefText": bool(entry["refText"])}


@app.delete("/profiles/{profile_id}", dependencies=[Depends(require_token)])
def delete_profile(profile_id: str) -> dict:
    if _get_profile(profile_id) is None:
        raise HTTPException(404, "Voice profile not found.")
    _write_index([p for p in _read_index() if p["id"] != profile_id])
    for suffix in (".ref.wav", ".ref.mp3", ".ref.flac", ".ref.ogg", ".ref.m4a"):
        (PROFILES_DIR / f"{profile_id}{suffix}").unlink(missing_ok=True)
    return {"ok": True}


class CloneRequest(BaseModel):
    text: str = Field(min_length=1, max_length=10_000)
    profileId: str = Field(min_length=1, max_length=64)
    # Kept in the schema because the Node API's contract has it; only 1.0 is
    # accepted (see _render).
    speed: float | None = Field(default=None, ge=0.5, le=2.0)


@app.post("/clone", dependencies=[Depends(require_token)])
def clone(req: CloneRequest) -> Response:
    profile = _get_profile(req.profileId)
    if profile is None:
        raise HTTPException(404, "Voice profile not found — create it first via /profiles.")

    if MOCK:
        wav, duration = _mock_wav(req.text)
    else:
        ref_path = _stored_reference(req.profileId)
        wav, duration = _render(req, ref_path)
    return _wav_response(wav, duration)


# Stateless variant: the reference clip is sent inline with each request —
# no profiles stored in the sidecar. This is what the Soundwave Node API uses,
# so cloned voices are owned per-user by the API and this service can run on
# ephemeral free hosting without persistence.
@app.post("/clone/ephemeral", dependencies=[Depends(require_token)])
async def clone_ephemeral(
    file: UploadFile = File(...),
    text: str = Form(...),
    refText: str | None = Form(None),
    speed: float | None = Form(None),
) -> Response:
    if not text or len(text) > 10_000:
        raise HTTPException(400, "Text is required (max 10,000 chars).")
    data = await file.read()
    if len(data) < 1000 or len(data) > 25 * 1024 * 1024:
        raise HTTPException(400, "The reference clip must be between 1 KB and 25 MB.")

    if MOCK:
        wav, duration = _mock_wav(text)
    else:
        import tempfile

        fd, tmp = tempfile.mkstemp(suffix=_ext_for(file.filename))
        try:
            with os.fdopen(fd, "wb") as f:
                f.write(data)
            if not MOCK:
                _reference_audio_ok(Path(tmp))
            req = CloneRequest(
                text=text,
                profileId="ephemeral",
                speed=speed if speed is None else min(2.0, max(0.5, speed)),
            )
            wav, duration = _render(req, Path(tmp))
        except HTTPException:
            raise
        except Exception as e:  # noqa: BLE001
            raise HTTPException(500, f"Failed to clone this reference clip: {e}") from e
        finally:
            Path(tmp).unlink(missing_ok=True)
    return _wav_response(wav, duration)


def _wav_response(wav: bytes, duration: float) -> Response:
    return Response(
        content=wav,
        media_type="audio/wav",
        headers={"X-Audio-Duration": f"{duration:.3f}", "Cache-Control": "no-store"},
    )


# ── Mock output (no model) ───────────────────────────────────────────────────
def _mock_wav(text: str) -> tuple[bytes, float]:
    import numpy as np
    import soundfile as sf

    duration = max(1.0, min(60.0, len(text.split()) / 2.6))
    n = int(duration * SAMPLE_RATE)
    t = np.arange(n) / SAMPLE_RATE
    # Two-tone warble so it obviously isn't silence.
    wave = (0.20 * np.sin(2 * math.pi * 220 * t) + 0.12 * np.sin(2 * math.pi * 330 * t)).astype("float32")
    fade = int(0.03 * SAMPLE_RATE)
    wave[:fade] *= np.linspace(0, 1, fade)
    wave[-fade:] *= np.linspace(1, 0, fade)
    buf = io.BytesIO()
    sf.write(buf, wave, SAMPLE_RATE, format="WAV", subtype="PCM_16")
    return buf.getvalue(), duration


def _ext_for(filename: str | None) -> str:
    name = (filename or "").lower()
    for ext in (".wav", ".mp3", ".flac", ".ogg", ".m4a"):
        if name.endswith(ext):
            return ext
    return ".wav"


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host=os.environ.get("VOICECLONE_HOST", "127.0.0.1"), port=int(os.environ.get("VOICECLONE_PORT", "8100")))

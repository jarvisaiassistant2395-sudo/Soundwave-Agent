#!/usr/bin/env python3
"""
Soundwave's local voice service: optional Chatterbox cloning, managed
MOSS-TTS-Nano ONNX cloning, and Kokoro narration, behind one small JSON API
the Node backend proxies to.

The managed engine choices prioritize licence, distribution, and CPU footprint:

  • MOSS-TTS-Nano (managed clone candidate) — Apache-2.0 code and weights;
    CPU ONNX with 763,191,513 pinned model bytes; its supported-language list
    does not include Serbian, and low-/medium-end speed remains unbenchmarked.
  • Chatterbox (optional cloning) — MIT for code **and** weights, but its
    official Nano dependency pins conflict with this shared managed environment.
  • Kokoro-82M (narration) — Apache-2.0 for code and weights, 82M parameters,
    runs on a CPU. It is driven by kokoro_engine.py, our own thin pipeline, and
    NOT by upstream's `kokoro.KPipeline`: that one imports `misaki.espeak`, which
    links the GPL-3.0 `phonemizer` + espeak-ng into this process. Ours imports
    only `misaki.en` (Apache-2.0, dictionary + misaki's own FallbackNetwork), so
    the whole service stays permissively licensed and the GPL extras are never
    even installed (kokoro is installed with --no-deps; see requirements.txt).

Loads the enabled models once and exposes a small JSON API the Node backend proxies to.

Commercial use depends on the model-weight licence, not just the wrapper code.
The managed candidate is Apache-2.0 MOSS-TTS-Nano ONNX; optional Chatterbox
code and weights are MIT. OmniVoice, previously used by this sidecar, has
Apache-2.0 code but CC-BY-NC weights, so it is not suitable for this commercial
product. New models must be reviewed together with their dependency licences,
weight terms, distribution gates, and actual machine requirements before being
added.

    GET  /health                  → { ok, model_loaded, device, mock, engines }
    GET  /profiles                → saved cloned voices
    POST /clone/validate-reference→ validate duration/decoding without saving
                                    (multipart: file; returns active engine + duration)
    POST /profiles                → create a cloned voice from a reference clip
                                    (multipart: file + name + optional refText)
    DELETE /profiles/{id}         → remove a cloned voice
    POST /clone                   → { text, profileId, speed? } → WAV
                                    (+ X-Audio-Duration header, seconds)

    GET  /tts/kokoro/voices       → the narration voices this install can use
    POST /tts/kokoro              → { text, voice?, speed? } → WAV
                                    (+ X-Audio-Duration header, seconds)

Set CHATTERBOX_MOCK=1 to run without model weights (sine-wave output) — used
for development/testing the plumbing without downloading model assets.
Set MOSS_OFF=0, MOSS_SOURCE_DIR, and MOSS_MODEL_DIR to local pinned assets
(and MOSS_PRELOAD=1) to enable MOSS-TTS-Nano cloning outside the managed
Windows installer. Its listed languages do not include Serbian; do not assume
Serbian output is supported.
Set KOKORO_OFF=1 to skip loading the narration model entirely.
"""

import io
import json
import math
import os
import secrets
import shutil
import subprocess
import tempfile
import threading
import time
import uuid
import wave
from pathlib import Path

# Trust the operating system's certificate store for model downloads (Hugging
# Face via requests otherwise only trusts certifi's bundle, which fails behind
# antivirus HTTPS scanning or a company proxy even though the internet works).
try:
    import truststore

    truststore.inject_into_ssl()
except Exception:  # optional: older installs without truststore keep certifi
    pass

from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel, Field

# ── Config ───────────────────────────────────────────────────────────────────
# Chatterbox v1 (English) — MIT code and MIT weights. `nano=1` uses the smaller
# Turbo/Nano model, which is designed to run on CPU.
CHATTERBOX_NANO = os.environ.get("CHATTERBOX_NANO", "").lower() in ("1", "true", "yes")
DEVICE = os.environ.get("CHATTERBOX_DEVICE", "cpu")  # cpu | cuda:0 | mps | xpu
MOCK = os.environ.get("CHATTERBOX_MOCK", "").lower() in ("1", "true", "yes")
# The desktop-managed service installs only the smaller Kokoro dependency set.
# Keep cloning endpoints present for API compatibility, but never import or
# advertise Chatterbox there.
CHATTERBOX_OFF = os.environ.get("CHATTERBOX_OFF", "").lower() in ("1", "true", "yes")
# MOSS is opt-in for manually hosted installations. The managed Windows app
# turns it on after verifying its pinned source and all pinned ONNX assets.
MOSS_OFF = os.environ.get("MOSS_OFF", "1").lower() in ("1", "true", "yes")
MOSS_PRELOAD = os.environ.get("MOSS_PRELOAD", "1").lower() in ("1", "true", "yes")
MOSS_SOURCE_DIR = os.environ.get("MOSS_SOURCE_DIR", "").strip()
MOSS_MODEL_DIR = os.environ.get("MOSS_MODEL_DIR", "").strip()
MOSS_MAX_REF_SECONDS = 10
try:
    MOSS_CPU_THREADS = max(1, min(4, int(os.environ.get("MOSS_CPU_THREADS", "0"))))
except ValueError:
    MOSS_CPU_THREADS = 0
if MOSS_CPU_THREADS < 1:
    MOSS_CPU_THREADS = max(1, min(4, (os.cpu_count() or 2) - 1))
# One shared PyTorch thread cap helps both CPU voice engines on low-core PCs.
# Configure before either engine performs inference so inter-op settings stick.
if not MOCK and not MOSS_OFF:
    import torch

    torch.set_num_threads(MOSS_CPU_THREADS)
    try:
        torch.set_num_interop_threads(1)
    except RuntimeError:
        pass
# The packaged desktop loads the model and all advertised voice packs before
# uvicorn listens, so narration is available offline after setup.
KOKORO_PRELOAD = os.environ.get("KOKORO_PRELOAD", "").lower() in ("1", "true", "yes")
KOKORO_SETUP_PROGRESS_FILE = os.environ.get("KOKORO_SETUP_PROGRESS_FILE", "")


def _write_kokoro_setup_progress(message: str, progress: int | None = None, progress_label: str | None = None) -> None:
    """Publish model/voice-pack setup progress for the desktop supervisor."""
    if not KOKORO_SETUP_PROGRESS_FILE:
        return
    target = Path(KOKORO_SETUP_PROGRESS_FILE)
    temporary = target.with_name(f"{target.name}.{os.getpid()}.tmp")
    payload = {"phase": "loading-model", "message": message[:400]}
    if progress is not None:
        payload["progress"] = max(0, min(100, int(progress)))
    if progress_label:
        payload["progressLabel"] = progress_label[:80]
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        temporary.write_text(json.dumps(payload) + "\n", encoding="utf-8")
        os.replace(temporary, target)
    except OSError as exc:
        print(f"[voiceclone] could not write Kokoro setup progress: {exc}", flush=True)
        try:
            temporary.unlink(missing_ok=True)
        except OSError:
            pass
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

if not MOCK and not CHATTERBOX_OFF:
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
elif CHATTERBOX_OFF:
    print("[voiceclone] Chatterbox cloning is disabled.", flush=True)

SAMPLE_RATE = int(getattr(model, "sr", DEFAULT_SAMPLE_RATE)) if not MOCK else DEFAULT_SAMPLE_RATE

# ── Kokoro narration (Apache-2.0 code and weights) ──────────────────────────
# A second engine in the same service: no reference clip, fixed voices, CPU-fast
# (~82M parameters). Kokoro's own default pipeline is used; see the module
# docstring for why espeak-ng is deliberately absent.
KOKORO_OFF = os.environ.get("KOKORO_OFF", "").lower() in ("1", "true", "yes")
KOKORO_SPEED_DEFAULT = float(os.environ.get("KOKORO_SPEED", "1.0"))
# 'a' American, 'b' British (Kokoro's own lang codes). The voice id picks the
# pipeline, so this is only the fallback/default.
KOKORO_LANG = "b" if os.environ.get("KOKORO_LANG", "a").lower().startswith("b") else "a"

# The real voice ids shipped with Kokoro-82M v1.0, straight from the project's
# own demo (hexgrad/kokoro demo/app.py). Nothing here is invented; the id's first
# letter is the language (a/b) and the second the gender (f/m).
KOKORO_VOICES: list[dict] = [
    {"id": "af_heart", "name": "Heart", "gender": "Female", "accent": "American", "default": True},
    {"id": "af_bella", "name": "Bella", "gender": "Female", "accent": "American"},
    {"id": "af_nicole", "name": "Nicole", "gender": "Female", "accent": "American"},
    {"id": "af_aoede", "name": "Aoede", "gender": "Female", "accent": "American"},
    {"id": "af_kore", "name": "Kore", "gender": "Female", "accent": "American"},
    {"id": "af_sarah", "name": "Sarah", "gender": "Female", "accent": "American"},
    {"id": "af_nova", "name": "Nova", "gender": "Female", "accent": "American"},
    {"id": "af_sky", "name": "Sky", "gender": "Female", "accent": "American"},
    {"id": "af_alloy", "name": "Alloy", "gender": "Female", "accent": "American"},
    {"id": "af_jessica", "name": "Jessica", "gender": "Female", "accent": "American"},
    {"id": "af_river", "name": "River", "gender": "Female", "accent": "American"},
    {"id": "am_michael", "name": "Michael", "gender": "Male", "accent": "American"},
    {"id": "am_fenrir", "name": "Fenrir", "gender": "Male", "accent": "American"},
    {"id": "am_puck", "name": "Puck", "gender": "Male", "accent": "American"},
    {"id": "am_echo", "name": "Echo", "gender": "Male", "accent": "American"},
    {"id": "am_eric", "name": "Eric", "gender": "Male", "accent": "American"},
    {"id": "am_liam", "name": "Liam", "gender": "Male", "accent": "American"},
    {"id": "am_onyx", "name": "Onyx", "gender": "Male", "accent": "American"},
    {"id": "am_santa", "name": "Santa", "gender": "Male", "accent": "American"},
    {"id": "am_adam", "name": "Adam", "gender": "Male", "accent": "American"},
    {"id": "bf_emma", "name": "Emma", "gender": "Female", "accent": "British"},
    {"id": "bf_isabella", "name": "Isabella", "gender": "Female", "accent": "British"},
    {"id": "bf_alice", "name": "Alice", "gender": "Female", "accent": "British"},
    {"id": "bf_lily", "name": "Lily", "gender": "Female", "accent": "British"},
    {"id": "bm_george", "name": "George", "gender": "Male", "accent": "British"},
    {"id": "bm_fable", "name": "Fable", "gender": "Male", "accent": "British"},
    {"id": "bm_lewis", "name": "Lewis", "gender": "Male", "accent": "British"},
    {"id": "bm_daniel", "name": "Daniel", "gender": "Male", "accent": "British"},
]
KOKORO_IDS = {v["id"] for v in KOKORO_VOICES}

# One KokoroEngine per accent flavour (American 'a' / British 'b'), sharing a
# single KModel — upstream's own recommendation, and it keeps memory flat.
kokoro_engines: dict[str, object] = {}
kokoro_lock = threading.Lock()


def _kokoro_pipeline(lang_code: str):
    """The narration engine for one language, built once.

    Raises the underlying error rather than swallowing it — the caller turns it
    into a 500 with the reason, so a broken install says so.
    """
    if lang_code in kokoro_engines:
        return kokoro_engines[lang_code]
    with kokoro_lock:
        if lang_code in kokoro_engines:
            return kokoro_engines[lang_code]
        from kokoro_engine import KokoroEngine

        shared = next(iter(kokoro_engines.values()), None)
        engine = KokoroEngine(
            device=DEVICE,
            british=lang_code == "b",
            model=getattr(shared, "model", None),
        )
        kokoro_engines[lang_code] = engine
        return engine


KOKORO_READY = False
if not KOKORO_OFF and not MOCK:
    print(f"[voiceclone] loading Kokoro (narration, lang '{KOKORO_LANG}') — Apache-2.0, CPU…", flush=True)
    try:
        if KOKORO_PRELOAD:
            _write_kokoro_setup_progress("Loading Kokoro's English pronunciation model.", progress_label="Pronunciation assets")
        engine = _kokoro_pipeline(KOKORO_LANG)
        if KOKORO_PRELOAD:
            # Download/cache the model, both dialects' G2P fallback assets and
            # all 28 voice packs before the desktop reports ready. Subsequent
            # narration is offline, regardless of the advertised voice chosen.
            _write_kokoro_setup_progress("Downloading and loading the Kokoro speech model.", progress_label="Speech model")
            engine._ensure_model()
            for lang_code, label in (("a", "American"), ("b", "British")):
                _write_kokoro_setup_progress(f"Preparing Kokoro's {label} pronunciation assets.", progress_label=f"{label} text assets")
                _kokoro_pipeline(lang_code).preload_text_assets()
            voice_ids = [voice["id"] for voice in KOKORO_VOICES]
            _write_kokoro_setup_progress(f"Caching all {len(voice_ids)} Kokoro voice packs.", 0, f"Voice packs (0/{len(voice_ids)})")

            def report_voice_progress(completed: int, total: int, voice_id: str) -> None:
                voice = next((item for item in KOKORO_VOICES if item["id"] == voice_id), None)
                voice_name = voice["name"] if voice else voice_id
                percent = round(completed * 100 / max(1, total))
                _write_kokoro_setup_progress(
                    f"Caching Kokoro voice {completed} of {total}: {voice_name}.",
                    percent,
                    f"Voice packs ({completed}/{total})",
                )

            engine.preload_voice_packs(voice_ids, report_voice_progress)
        KOKORO_READY = True
        print(f"[voiceclone] Kokoro ready ({len(KOKORO_VOICES)} voices)", flush=True)
    except Exception as e:  # noqa: BLE001
        if KOKORO_PRELOAD:
            # The managed desktop promises that first-use model downloads have
            # completed before the local voice API says it is ready.
            print(f"[voiceclone] FATAL: Kokoro preload failed: {e}", flush=True)
            raise
        # Chatterbox cloning can still work without Kokoro; say so and carry on.
        print(f"[voiceclone] Kokoro unavailable ({e}) — narration voices are off, cloning still works", flush=True)
elif MOCK and not KOKORO_OFF:
    KOKORO_READY = True

# ── MOSS-TTS-Nano cloning (Apache-2.0 code and ONNX weights) ────────────────
# The sidecar is started only after the manager has downloaded and integrity-
# checked the upstream runtime source and model assets. Manual deployments can
# point MOSS_SOURCE_DIR / MOSS_MODEL_DIR at their own pinned local copies.
moss_engine = None
MOSS_READY = False
if not MOSS_OFF and not MOCK and MOSS_PRELOAD:
    print(f"[voiceclone] loading MOSS-TTS-Nano ONNX on CPU ({MOSS_CPU_THREADS} threads)…", flush=True)
    try:
        from moss_engine import MossEngine

        moss_engine = MossEngine(
            model_dir=MOSS_MODEL_DIR or (Path(__file__).parent / "models"),
            source_dir=MOSS_SOURCE_DIR or None,
            thread_count=MOSS_CPU_THREADS,
        )
        MOSS_READY = True
        print("[voiceclone] MOSS-TTS-Nano ready (CPU / ONNX Runtime)", flush=True)
    except Exception as e:  # noqa: BLE001 — managed setup must not claim readiness on a broken model
        print(f"[voiceclone] FATAL: failed to load MOSS-TTS-Nano: {e}", flush=True)
        raise
elif MOCK and not MOSS_OFF:
    MOSS_READY = True


def _active_clone_engine() -> str | None:
    if MOCK:
        return "mock" if (not CHATTERBOX_OFF or not MOSS_OFF) else None
    if not MOSS_OFF and MOSS_READY:
        return "moss"
    if not CHATTERBOX_OFF and model is not None:
        return "chatterbox"
    return None


def _reference_audio_ok(ref_path: Path) -> float:
    """Check a Chatterbox reference clip and return its duration in seconds."""
    import torchaudio

    try:
        info = torchaudio.info(str(ref_path))
    except Exception as e:  # noqa: BLE001
        raise HTTPException(400, f"That reference clip couldn't be read: {e}") from e
    seconds = info.num_frames / max(1, info.sample_rate)
    if seconds < 3:
        raise HTTPException(400, "The reference clip is too short — use at least 3 seconds of clean speech.")
    if seconds > 60:
        raise HTTPException(400, "The reference clip is too long — use 60 seconds or less of clean speech.")
    return seconds


def _wav_info(ref_path: Path) -> tuple[float, int, int] | None:
    try:
        with wave.open(str(ref_path), "rb") as audio:
            rate = audio.getframerate()
            frames = audio.getnframes()
            return frames / max(1, rate), audio.getnchannels(), rate
    except (OSError, wave.Error):
        return None


def _prepare_moss_reference(ref_path: Path) -> tuple[Path, Path | None]:
    """Return a readable 3–10 s reference, decoding compressed clips locally.

    MOSS's runtime resamples WAV input and converts mono/stereo itself. FFmpeg
    is used only to decode a non-WAV (or unsupported multichannel WAV) into a
    bounded temporary PCM file; the reference is never sent to a cloud service.
    """
    original = Path(ref_path).expanduser().resolve()
    info = _wav_info(original) if original.suffix.lower() == ".wav" else None
    if info and info[1] in (1, 2):
        seconds = info[0]
        if seconds < 3:
            raise HTTPException(400, "The reference clip is too short — use at least 3 seconds of clean speech.")
        if seconds > MOSS_MAX_REF_SECONDS:
            raise HTTPException(400, f"The MOSS reference clip must be 3–{MOSS_MAX_REF_SECONDS} seconds long.")
        return original, None

    ffmpeg = os.environ.get("FFMPEG_PATH", "").strip()
    if ffmpeg and os.path.dirname(ffmpeg) and not os.path.isfile(ffmpeg):
        ffmpeg = None
    ffmpeg = ffmpeg or shutil.which("ffmpeg")
    if not ffmpeg:
        # Torchaudio can decode some compressed formats on builds with a
        # decoder backend. Let it try, but clearly request WAV if it cannot.
        try:
            import torchaudio

            audio_info = torchaudio.info(str(original))
            seconds = audio_info.num_frames / max(1, audio_info.sample_rate)
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(400, "This voice-cloning install needs FFmpeg to read that format. Upload a mono/stereo WAV clip instead, or install FFmpeg.") from exc
        if seconds < 3:
            raise HTTPException(400, "The reference clip is too short — use at least 3 seconds of clean speech.")
        if seconds > MOSS_MAX_REF_SECONDS:
            raise HTTPException(400, f"The MOSS reference clip must be 3–{MOSS_MAX_REF_SECONDS} seconds long.")
        return original, None

    fd, temporary = tempfile.mkstemp(prefix="soundwave-moss-reference-", suffix=".wav")
    os.close(fd)
    temporary_path = Path(temporary)
    try:
        completed = subprocess.run(
            [
                ffmpeg,
                "-hide_banner",
                "-loglevel",
                "error",
                "-nostdin",
                "-y",
                "-i",
                str(original),
                "-t",
                str(MOSS_MAX_REF_SECONDS + 1),
                "-ar",
                "48000",
                "-ac",
                "2",
                "-c:a",
                "pcm_s16le",
                "-f",
                "wav",
                str(temporary_path),
            ],
            capture_output=True,
            text=True,
            timeout=60,
            check=False,
        )
        if completed.returncode != 0:
            detail = (completed.stderr or "").strip()[-240:]
            raise HTTPException(400, f"That reference clip couldn't be decoded locally{': ' + detail if detail else '.'}")
        normalized_info = _wav_info(temporary_path)
        if normalized_info is None:
            raise HTTPException(400, "That reference clip couldn't be converted to WAV audio.")
        seconds = normalized_info[0]
        if seconds < 3:
            raise HTTPException(400, "The reference clip is too short — use at least 3 seconds of clean speech.")
        if seconds > MOSS_MAX_REF_SECONDS:
            raise HTTPException(400, f"The MOSS reference clip must be 3–{MOSS_MAX_REF_SECONDS} seconds long.")
        return temporary_path, temporary_path
    except subprocess.TimeoutExpired as exc:
        temporary_path.unlink(missing_ok=True)
        raise HTTPException(400, "Decoding that reference clip took too long.") from exc
    except OSError as exc:
        temporary_path.unlink(missing_ok=True)
        raise HTTPException(400, "FFmpeg couldn't be started. Upload a mono/stereo WAV clip or check the FFmpeg installation.") from exc
    except Exception:
        temporary_path.unlink(missing_ok=True)
        raise


def _validate_clone_reference(ref_path: Path, engine: str | None = None) -> float:
    selected = engine or _active_clone_engine()
    if selected == "moss":
        normalized, temporary = _prepare_moss_reference(ref_path)
        try:
            info = _wav_info(normalized)
            if info is None:
                raise HTTPException(400, "The reference clip couldn't be read as WAV audio.")
            return info[0]
        finally:
            if temporary:
                temporary.unlink(missing_ok=True)
    if selected == "chatterbox":
        return _reference_audio_ok(ref_path)
    if selected == "mock":
        # The mock service has no real engine but should still exercise the same
        # Chatterbox-compatible acceptance limits in self-tests.
        return _reference_audio_ok(ref_path)
    raise HTTPException(503, "No voice-cloning model is loaded on this service.")


def _render(req: "CloneRequest", ref_path: Path) -> "tuple[bytes, float]":
    if req.speed is not None and abs(req.speed - 1.0) > 1e-6:
        raise HTTPException(400, "Cloned voices don't support a speed change — set the speed on the narration voice instead.")

    engine = _active_clone_engine()
    if engine == "moss":
        normalized_path: Path | None = None
        cleanup_path: Path | None = None
        try:
            normalized_path, cleanup_path = _prepare_moss_reference(ref_path)
            with model_lock:
                audio, duration, _sample_rate = moss_engine.synthesize(text=req.text, reference_audio_path=normalized_path)
            return audio, duration
        except HTTPException:
            raise
        except Exception as e:  # noqa: BLE001
            raise HTTPException(500, f"MOSS-TTS-Nano generation failed: {e}") from e
        finally:
            if cleanup_path:
                cleanup_path.unlink(missing_ok=True)

    if engine != "chatterbox" or model is None:
        raise HTTPException(503, "No voice-cloning model is loaded on this service.")
    _reference_audio_ok(ref_path)
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


def _render_kokoro(req: "KokoroRequest") -> "tuple[bytes, float]":
    """One narration clip. No reference clip: the voice IS the model's tensor."""
    voice = (req.voice or "af_heart").strip()
    if voice not in KOKORO_IDS:
        known = ", ".join(sorted(KOKORO_IDS))
        raise HTTPException(400, f"Unknown narration voice \"{voice}\". Available: {known}")
    speed = KOKORO_SPEED_DEFAULT if req.speed is None else req.speed
    if not 0.5 <= speed <= 2.0:
        raise HTTPException(400, "Speed must be between 0.5 and 2.0.")
    if MOCK:
        return _mock_wav(req.text, 24_000)
    if not KOKORO_READY:
        raise HTTPException(503, "The narration model isn't loaded on this service (KOKORO_OFF or a failed load).")
    lang = "b" if voice.startswith("b") else "a"
    import numpy as np

    try:
        engine = _kokoro_pipeline(lang)
        # Serialize local CPU inference across MOSS, Chatterbox and Kokoro so
        # concurrent requests do not oversubscribe a low-core desktop.
        with model_lock, kokoro_lock:
            chunks = list(engine.generate(req.text, voice=voice, speed=speed))
    except Exception as e:  # noqa: BLE001
        raise HTTPException(500, f"Kokoro failed to generate speech: {e}") from e
    if not chunks:
        raise HTTPException(500, "Kokoro returned no audio for that text.")
    samples = np.concatenate([np.asarray(c, dtype="float32").reshape(-1) for c in chunks])
    sample_rate = 24_000  # Kokoro-82M v1.0
    return _encode_wav(samples, sample_rate), len(samples) / sample_rate


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
    for ext in (".wav", ".mp3", ".flac", ".ogg", ".m4a", ".webm"):
        path = PROFILES_DIR / f"{profile_id}.ref{ext}"
        if path.exists():
            return path
    raise HTTPException(404, "This voice's reference clip is missing — recreate the profile.")


def _get_profile(profile_id: str) -> dict | None:
    if not profile_id or any(c not in "0123456789abcdef-" for c in profile_id):
        return None
    return next((p for p in _read_index() if p["id"] == profile_id), None)


# ── Request models ───────────────────────────────────────────────────────────
# Defined before the app: FastAPI resolves annotations when a route is
# decorated, so a model defined further down the file would be read as a query
# parameter (which is how /tts/kokoro answered 422 the first time).
class KokoroRequest(BaseModel):
    text: str = Field(min_length=1, max_length=10_000)
    # Kokoro-82M v1.0 voice id (af_heart, bm_george, …). Defaults to the model's
    # own default voice.
    voice: str | None = Field(default=None, max_length=32)
    speed: float | None = Field(default=None, ge=0.5, le=2.0)


class CloneRequest(BaseModel):
    text: str = Field(min_length=1, max_length=10_000)
    profileId: str = Field(min_length=1, max_length=64)
    # Kept in the schema because the Node API's contract has it; only 1.0 is
    # accepted (see _render).
    speed: float | None = Field(default=None, ge=0.5, le=2.0)


# ── App ──────────────────────────────────────────────────────────────────────
app = FastAPI(title="Soundwave AI local voice service", docs_url=None, redoc_url=None)


@app.get("/health")
def health() -> dict:
    clone_engine = _active_clone_engine()
    return {
        "ok": True,
        "model_loaded": MOCK or model is not None or MOSS_READY,
        "device": "mock" if MOCK else ("cpu" if clone_engine == "moss" and model is None else DEVICE),
        "mock": MOCK,
        "clone_engine": clone_engine,
        "clone_ready": clone_engine is not None,
        "reference_limits_seconds": {"moss": {"min": 3, "max": MOSS_MAX_REF_SECONDS}, "chatterbox": {"min": 3, "max": 60}},
        "engines": {
            "chatterbox": {
                "enabled": not CHATTERBOX_OFF,
                "loaded": not CHATTERBOX_OFF and (MOCK or model is not None),
                "code": "MIT",
                "weights": "MIT",
            },
            "moss": {
                "enabled": not MOSS_OFF,
                "loaded": not MOSS_OFF and MOSS_READY,
                "code": "Apache-2.0",
                "weights": "Apache-2.0",
                "model": "MOSS-TTS-Nano-100M-ONNX",
                "backend": "ONNX Runtime CPU",
                "threads": MOSS_CPU_THREADS,
                "downloadBytes": 763191513,
                "supportedLanguagesCount": 20,
                "serbianSupported": False,
            },
            "kokoro": {"enabled": not KOKORO_OFF, "loaded": KOKORO_READY, "code": "Apache-2.0", "weights": "Apache-2.0", "voices": len(KOKORO_VOICES)},
        },
    }


@app.get("/tts/kokoro/voices", dependencies=[Depends(require_token)])
def kokoro_voices() -> dict:
    return {"engine": "kokoro", "available": KOKORO_READY, "voices": KOKORO_VOICES}


@app.post("/tts/kokoro", dependencies=[Depends(require_token)])
def kokoro_tts(req: KokoroRequest) -> Response:
    wav, duration = _render_kokoro(req)
    return _wav_response(wav, duration)


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
    if _active_clone_engine() is None:
        raise HTTPException(503, "Voice cloning is not enabled on this local voice service.")
    name = name.strip()[:80]
    if not name:
        raise HTTPException(400, "A voice name is required.")
    data = await file.read()
    if len(data) < 1000:
        raise HTTPException(400, "The reference clip is too small — use at least 3 seconds of clean speech.")
    if len(data) > 25 * 1024 * 1024:
        raise HTTPException(400, "The reference clip is too large (max 25 MB).")

    profile_id = str(uuid.uuid4())
    ref_path = PROFILES_DIR / f"{profile_id}.ref{_ext_for(file.filename)}"
    ref_path.write_bytes(data)

    if not MOCK:
        # The clip itself is what the model conditions on. Validate it before
        # the profile exists, and remove the uploaded file if it is unusable.
        try:
            _validate_clone_reference(ref_path)
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


@app.post("/clone/validate-reference", dependencies=[Depends(require_token)])
async def validate_clone_reference(
    file: UploadFile = File(...),
) -> dict:
    engine = _active_clone_engine()
    if engine is None:
        raise HTTPException(503, "Voice cloning is not enabled on this local voice service.")
    data = await file.read()
    if len(data) < 1000:
        raise HTTPException(400, "The reference clip is too small — use at least 3 seconds of clean speech.")
    if len(data) > 25 * 1024 * 1024:
        raise HTTPException(400, "The reference clip is too large (max 25 MB).")

    fd, temporary = tempfile.mkstemp(prefix="soundwave-reference-check-", suffix=_ext_for(file.filename))
    try:
        with os.fdopen(fd, "wb") as output:
            output.write(data)
        duration = _validate_clone_reference(Path(temporary), engine=engine)
        return {"valid": True, "durationSeconds": duration, "engine": engine}
    finally:
        Path(temporary).unlink(missing_ok=True)


@app.delete("/profiles/{profile_id}", dependencies=[Depends(require_token)])
def delete_profile(profile_id: str) -> dict:
    if _get_profile(profile_id) is None:
        raise HTTPException(404, "Voice profile not found.")
    _write_index([p for p in _read_index() if p["id"] != profile_id])
    for suffix in (".ref.wav", ".ref.mp3", ".ref.flac", ".ref.ogg", ".ref.m4a", ".ref.webm"):
        (PROFILES_DIR / f"{profile_id}{suffix}").unlink(missing_ok=True)
    return {"ok": True}



@app.post("/clone", dependencies=[Depends(require_token)])
def clone(req: CloneRequest) -> Response:
    if _active_clone_engine() is None:
        raise HTTPException(503, "Voice cloning is not enabled on this local voice service.")
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
    if _active_clone_engine() is None:
        raise HTTPException(503, "Voice cloning is not enabled on this local voice service.")
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


# ── WAV encoding (stdlib) ────────────────────────────────────────────────────
def _encode_wav(samples, sample_rate: int) -> bytes:
    """Float samples → 16-bit mono WAV.

    Deliberately the standard library, not soundfile: the narration engine and
    the mock output then need nothing but numpy, which keeps a light install
    light (and CI does not need libsndfile present).
    """
    import numpy as np
    import wave

    clipped = np.clip(np.asarray(samples, dtype="float32").reshape(-1), -1.0, 1.0)
    pcm = (clipped * 32767.0).astype("<i2")
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(int(sample_rate))
        w.writeframes(pcm.tobytes())
    return buf.getvalue()


# ── Mock output (no model) ───────────────────────────────────────────────────
def _mock_wav(text: str, sample_rate: int | None = None) -> tuple[bytes, float]:
    import numpy as np

    rate = sample_rate or SAMPLE_RATE
    duration = max(1.0, min(60.0, len(text.split()) / 2.6))
    n = int(duration * rate)
    t = np.arange(n) / rate
    # Two-tone warble so it obviously isn't silence.
    wave_out = (0.20 * np.sin(2 * math.pi * 220 * t) + 0.12 * np.sin(2 * math.pi * 330 * t)).astype("float32")
    fade = int(0.03 * rate)
    wave_out[:fade] *= np.linspace(0, 1, fade)
    wave_out[-fade:] *= np.linspace(1, 0, fade)
    return _encode_wav(wave_out, rate), duration


def _ext_for(filename: str | None) -> str:
    name = (filename or "").lower()
    for ext in (".wav", ".mp3", ".flac", ".ogg", ".m4a", ".webm"):
        if name.endswith(ext):
            return ext
    return ".wav"


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host=os.environ.get("VOICECLONE_HOST", "127.0.0.1"), port=int(os.environ.get("VOICECLONE_PORT", "8100")))

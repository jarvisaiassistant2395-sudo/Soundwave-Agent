#!/usr/bin/env python3
"""Thin Soundwave adapter for OpenMOSS MOSS-TTS-Nano's CPU ONNX runtime.

The packaged desktop downloads the upstream Apache-2.0 runtime source at a
pinned Git commit and the two ONNX model repositories at pinned Hugging Face
revisions. The 100M-parameter model runs through ONNX Runtime on CPU; this
adapter caps inference at four threads and serializes it with the other local
voice engine so low-core PCs are not oversubscribed.

MOSS's upstream ONNX wrapper imports torch/torchaudio for reference-audio
loading even though the TTS and codec graphs run in ONNX Runtime. Soundwave
installs the matching CPU torch/torchaudio 2.7.0 pair already used by Kokoro.
We disable WeTextProcessing (which is optional in upstream) so the runtime
needs no extra text-normalization stack or its native build dependencies.
"""

from __future__ import annotations

import os
import sys
import tempfile
import threading
from pathlib import Path
from typing import Any


def _cpu_thread_count(requested: int | None = None) -> int:
    logical = max(1, os.cpu_count() or 2)
    if requested is None:
        try:
            requested = int(os.environ.get("MOSS_CPU_THREADS", ""))
        except ValueError:
            requested = None
    if requested is None or requested < 1:
        requested = max(1, min(4, logical - 1))
    return max(1, min(4, int(requested)))


class MossEngine:
    """One initialized ONNX runtime, safe for the threaded FastAPI service."""

    def __init__(
        self,
        *,
        model_dir: str | Path,
        source_dir: str | Path | None = None,
        thread_count: int | None = None,
    ) -> None:
        resolved_source = Path(source_dir or os.environ.get("MOSS_SOURCE_DIR", "")).expanduser().resolve()
        if not resolved_source.is_dir():
            raise FileNotFoundError(f"Pinned MOSS-TTS-Nano runtime source is missing: {resolved_source}")
        if str(resolved_source) not in sys.path:
            sys.path.insert(0, str(resolved_source))

        self.model_dir = Path(model_dir).expanduser().resolve()
        self.thread_count = _cpu_thread_count(thread_count)
        self._lock = threading.Lock()

        # Upstream's ONNX wrapper imports torch/torchaudio for reading and
        # resampling prompt audio. Limit their CPU pools before constructing ORT
        # sessions, but tolerate an already-initialized torch inter-op pool.
        import torch

        torch.set_num_threads(self.thread_count)
        try:
            torch.set_num_interop_threads(1)
        except RuntimeError:
            pass

        from onnx_tts_runtime import OnnxTtsRuntime

        self.runtime = OnnxTtsRuntime(
            model_dir=self.model_dir,
            thread_count=self.thread_count,
            execution_provider="cpu",
            sample_mode="fixed",
        )
        self.runtime.warmup()

    def synthesize(self, *, text: str, reference_audio_path: str | Path) -> tuple[bytes, float, int]:
        normalized_text = str(text or "").strip()
        reference_path = Path(reference_audio_path).expanduser().resolve()
        if not normalized_text:
            raise ValueError("Text prompt cannot be empty.")
        if not reference_path.is_file():
            raise FileNotFoundError(f"Reference audio is missing: {reference_path}")

        # Upstream has mutable RNG/session state. A per-engine lock prevents
        # concurrent HTTP requests from corrupting one another and controls CPU
        # contention alongside Kokoro/Chatterbox in server.py.
        with self._lock, tempfile.TemporaryDirectory(prefix="soundwave-moss-") as temp_dir:
            output_path = Path(temp_dir) / "clone.wav"
            result: dict[str, Any] = self.runtime.synthesize(
                text=normalized_text,
                prompt_audio_path=reference_path,
                output_audio_path=output_path,
                sample_mode="fixed",
                do_sample=True,
                streaming=True,
                enable_wetext=False,
                enable_normalize_tts_text=True,
            )
            if not output_path.is_file():
                raise RuntimeError("MOSS-TTS-Nano completed without writing a WAV file.")
            audio = output_path.read_bytes()
            sample_rate = int(result.get("sample_rate") or 48_000)
            waveform = result.get("waveform")
            sample_count = int(getattr(waveform, "shape", [0])[0]) if waveform is not None else 0
            duration = sample_count / max(1, sample_rate)
            if duration <= 0:
                import wave

                with wave.open(str(output_path), "rb") as wav_file:
                    duration = wav_file.getnframes() / max(1, wav_file.getframerate())
                    sample_rate = wav_file.getframerate()
            if not audio or duration <= 0:
                raise RuntimeError("MOSS-TTS-Nano returned empty audio.")
            return audio, duration, sample_rate

#!/usr/bin/env python3
"""Kokoro narration engine — our own thin pipeline, so nothing GPL is pulled in.

Why not the obvious `from kokoro import KPipeline`? Because that module does
`from misaki import en, espeak` at import time, and `misaki/espeak.py` imports
`phonemizer` (GPL-3.0) and `espeakng_loader` (which ships espeak-ng, GPL-3.0)
and calls `EspeakWrapper.set_library(...)` on import — i.e. it links a GPL
library into this process. `kokoro` also *requires* `misaki[en]`, whose extras
are exactly those two GPL packages. Verified against the upstream sources on
2026-10-04 (hexgrad/kokoro kokoro/pipeline.py, hexgrad/misaki misaki/espeak.py).

What this file uses instead — every piece permissively licensed:

  • `misaki.en`        Apache-2.0  English G2P: dictionary + misaki's own
                                   FallbackNetwork (Apache-2.0 code) for
                                   out-of-dictionary words. Passing
                                   fallback=None selects that, NOT espeak — see
                                   misaki/en.py G2P.__init__. Importing
                                   misaki.en alone never touches misaki.espeak,
                                   phonemizer or espeak-ng.
                                   Caveat, recorded rather than glossed over:
                                   FallbackNetwork loads a ~3 MB BART model from
                                   the dialect-specific `PeterReid/graphemes_to_phonemes_en_us`
                                   or `PeterReid/graphemes_to_phonemes_en_gb` on
                                   Hugging Face. Their model cards are empty and
                                   state **no licence** (checked 2026-10-04), so
                                   they are listed as unverified in
                                   THIRD-PARTY-NOTICES.txt instead of being
                                   called Apache-2.0. They are what misaki itself
                                   uses by default, and are downloaded to the
                                   user's own machine — nothing we ship conveys
                                   them — but the gap is named, not hidden.
  • `kokoro.model`     Apache-2.0  KModel (the 82M network + weights loader),
                                   installed with --no-deps so its GPL extra
                                   never lands in the environment.
  • `en_core_web_sm`   MIT         spaCy's English tokeniser/tagger, which
                                   misaki downloads on first use.
  • `num2words`        LGPL-2.1    Used by misaki to speak digits. Not
                                   modified, installed separately, and its
                                   licence text ships with the service.

The model weights themselves (hexgrad/Kokoro-82M) are Apache-2.0.

`selftest.py` asserts that importing and running this engine leaves
`phonemizer`, `espeakng_loader` and `misaki.espeak` *out* of `sys.modules`: the
guarantee is tested, not just claimed.

The advertised voice list lives in server.py (one source of truth).
API: KokoroEngine(device=…, british=…, model=…) with
.generate(text, voice, speed) → iterable of float32 sample arrays at 24 kHz.
"""

import os
import re
import threading
from typing import Iterable, List, Optional

import torch

# The model's own limit: one phoneme string is at most 510 characters.
MAX_PHONEMES = 510
SAMPLE_RATE = 24_000
REPO_ID = "hexgrad/Kokoro-82M"


def _require_spacy_model(name: str) -> None:
    """Refuse to start when misaki's tokeniser model is absent.

    Deliberately *not* a download: setup owns installing this (the installer and
    preflight.py both check it), so reaching here means the environment is
    broken, and a service that quietly fetches a model mid-narration is worse
    than one that says what is missing. When spaCy itself is absent this
    returns — `from misaki import en` will have raised already, with its own
    message.
    """
    try:
        import spacy.util
    except Exception:  # noqa: BLE001 — misaki's import error is the useful one
        return
    if spacy.util.is_package(name):
        return
    raise RuntimeError(
        f"misaki's spaCy model '{name}' is not installed, and fetching it from "
        f"inside the service is what used to fail without a message. "
        f"Run: python -m spacy download {name} — or re-run the Soundwave voice setup."
    )


class KokoroEngine:
    """One language's G2P over a shared KModel. Thread-safe."""

    def __init__(self, device: str = "cpu", british: bool = False, model=None, repo_id: str = REPO_ID):
        self.repo_id = repo_id
        self.device = device
        self.british = british
        self._lock = threading.Lock()
        self._voices: dict[str, object] = {}

        from misaki import en  # Apache-2.0; never imports misaki.espeak

        # misaki's own tokeniser is a spaCy model (en_core_web_sm). If it is not
        # installed, misaki does not raise: G2P.__init__ calls
        # spacy.cli.download() *itself*, from inside this process, at whatever
        # moment the first narration happens. On a machine where that download
        # cannot complete — offline, or HTTPS scanned by antivirus, which is how
        # it usually fails on Windows — the user gets a requests/SSL traceback
        # and no narration, long after setup said it succeeded. Check first, and
        # fail with the one line that fixes it.
        _require_spacy_model("en_core_web_sm")

        # fallback=None → misaki's built-in FallbackNetwork (Apache-2.0), which is
        # what upstream passes when espeak isn't available. espeak is never used.
        self.g2p = en.G2P(trf=False, british=british, fallback=None, unk="")
        self.model = model

        # The licence promise, enforced rather than remembered: if anything in
        # this process has imported the espeak/phonemizer path, the service is no
        # longer permissively licensed — refuse to run instead of shipping that.
        import sys

        gpl = [name for name in ("phonemizer", "espeakng_loader", "misaki.espeak") if name in sys.modules]
        if gpl:
            raise RuntimeError(
                "Kokoro would run with GPL-3.0 code in-process: " + ", ".join(gpl) +
                ". Use misaki.en only (see this file's docstring) — never `from kokoro import KPipeline`."
            )

    # ── Model + voices ──────────────────────────────────────────────────────
    def _ensure_model(self):
        if self.model is None:
            from kokoro.model import KModel  # Apache-2.0; installed with --no-deps

            self.model = KModel(repo_id=self.repo_id).to(self.device).eval()
        return self.model

    def voice_tensor(self, voice: str):
        """The .pt voice pack, downloaded and cached once per voice (~0.5 MB)."""
        from huggingface_hub import hf_hub_download

        with self._lock:
            if voice not in self._voices:
                path = hf_hub_download(repo_id=self.repo_id, filename=f"voices/{voice}.pt")
                self._voices[voice] = torch.load(path, weights_only=True)
            return self._voices[voice]

    def preload_text_assets(self) -> None:
        """Warm misaki's tokenizer and fallback G2P weights for offline use."""
        # These uncommon names plus a deliberately unknown token exercise the
        # fallback network used for words absent from misaki's dictionary. It is a small Hugging Face
        # asset that would otherwise first download on an arbitrary narration.
        self.g2p("Soundwave Kokoro qzxvkp")

    def preload_voice_packs(self, voices: Iterable[str], on_progress=None) -> int:
        """Download/cache every requested pack before an offline-first service starts.

        ``on_progress`` receives (completed, total, voice_id) after each pack is
        present in Hugging Face's local cache and loaded into this engine.
        """
        voice_ids = list(dict.fromkeys(voices))
        total = len(voice_ids)
        for completed, voice_id in enumerate(voice_ids, start=1):
            self.voice_tensor(voice_id)
            if callable(on_progress):
                on_progress(completed, total, voice_id)
        return total

    def attach_model(self, model) -> None:
        """Share one KModel across languages (upstream recommends this)."""
        self.model = model

    # ── Text → phonemes → audio ─────────────────────────────────────────────
    @staticmethod
    def _phoneme_string(tokens) -> str:
        return "".join((t.phonemes or "") + (" " if t.whitespace else "") for t in tokens).strip()

    def _chunk(self, tokens) -> Iterable[str]:
        """Split tokens into ≤510-phoneme strings, preferring punctuation.

        Mirrors upstream KPipeline.en_tokenize's budget and waterfall
        ('!.?…' before ':;' before ',—'), so long replies are cut where a
        listener expects a breath rather than mid-clause.
        """
        waterfall = ["!.?…", ":;", ",—"]
        chunk: List = []
        count = 0
        for token in tokens:
            piece = (token.phonemes or "") + (" " if token.whitespace else "")
            if chunk and count + len(piece.rstrip()) > MAX_PHONEMES:
                cut = len(chunk)
                for marks in waterfall:
                    found = next(
                        (i for i in range(len(chunk) - 1, -1, -1) if chunk[i].phonemes in set(marks)),
                        None,
                    )
                    if found is not None:
                        cut = found + 1
                        break
                head = self._phoneme_string(chunk[:cut])
                if head:
                    yield head
                chunk = chunk[cut:]
                count = len(self._phoneme_string(chunk))
            chunk.append(token)
            count += len(piece)
        tail = self._phoneme_string(chunk)
        if tail:
            yield tail

    def generate(self, text: str, voice: str, speed: float = 1.0) -> Iterable["torch.Tensor"]:
        """Yield float32 sample arrays (24 kHz) for `text` in `voice`.

        Paragraphs are processed one at a time (upstream splits on \n+ too):
        a newline is a real pause in a narration script, and it keeps the
        phoneme budget well clear of the model's 510-character limit.
        """
        model = self._ensure_model()
        pack = self.voice_tensor(voice).to(model.device)
        for paragraph in re.split(r"\n+", text.strip()):
            if not paragraph.strip():
                continue
            with self._lock:
                _phonemes, tokens = self.g2p(paragraph)
                for phonemes in self._chunk(tokens):
                    if not phonemes:
                        continue
                    # A single very long token can't be cut at punctuation; the
                    # model's own guard is the 510 limit (upstream truncates the
                    # same way and logs it).
                    if len(phonemes) > MAX_PHONEMES:
                        phonemes = phonemes[:MAX_PHONEMES]
                    # ref_s is the per-phoneme style row for this voice.
                    output = model(phonemes, pack[len(phonemes) - 1], speed, return_output=True)
                    audio = output.audio
                    if audio is None:
                        continue
                    yield audio.detach().cpu().numpy().astype("float32").reshape(-1)

def state():
    """Is torch usable here, and is a GPU present? (Used for the health payload.)"""
    device = os.environ.get("KOKORO_DEVICE") or os.environ.get("CHATTERBOX_DEVICE") or "cpu"
    return {"device": device, "cuda": bool(torch.cuda.is_available()), "torch": torch.__version__}


if __name__ == "__main__":  # tiny smoke test, no model download
    print("voices:", len(KokoroEngine.voices()))
    print("state:", state())

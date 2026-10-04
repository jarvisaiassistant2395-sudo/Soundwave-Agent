#!/usr/bin/env python3
"""Contract tests for kokoro_engine.py — no torch, no models, no downloads.

    python test_engine.py

Why this exists: a Kokoro integration that "emits weird humming instead of a
voice" (the exact symptom reported) is almost never the model. It is one of:

  1. **Text sent where phonemes belong.** The model maps phoneme characters
     through its vocab; ordinary letters mostly aren't in it, they get filtered
     out, and the network is left with <bos><eos> and generates its prior —
     noise. The engine must hand it misaki's phoneme string.
  2. **The wrong style row.** The voice pack is [511, 1, 256]; the row must be
     `pack[len(phonemes) - 1]` — indexed by the *phoneme length* of the chunk
     being spoken. Passing `pack[0]` or the whole tensor gives a constant,
     wrong style vector, which is precisely the "brrrwmmrwbb" drone.
  3. Wrong sample rate or PCM scaling on the way out (that part is pinned by
     voicecopy/selftest.py and server.py's _encode_wav).

This file pins 1 and 2 by standing in for torch, huggingface_hub and misaki, so
it runs anywhere — including CI and a bare machine with no GPU. It is a static
guard on the code path that produces the hum, not a test of the model itself
(the real-model check is `python selftest.py --real`).
"""

import sys
import types

import numpy as np

failures: list[str] = []


def check(name: str, condition: bool, detail: str = "") -> None:
    if condition:
        print(f"✓ {name}")
    else:
        print(f"✗ {name}{f' — {detail}' if detail else ''}")
        failures.append(name)


# ── Stand-ins ───────────────────────────────────────────────────────────────
calls: list[dict] = []          # every model(...) call, verbatim
downloads: list[str] = []       # every style row the engine read
fetches: list[str] = []         # every file requested from Hugging Face
g2p_inputs: list[str] = []      # every string handed to the G2P


class FakeAudio:
    def __init__(self, samples):
        self._samples = np.asarray(samples, dtype="float32")

    def detach(self):
        return self

    def cpu(self):
        return self

    def numpy(self):
        return self._samples


class FakeOutput:
    def __init__(self, samples):
        self.audio = FakeAudio(samples)
        self.pred_dur = None


class FakePack:
    """Mimics the real voice pack: 511 rows, one style vector each."""

    def __init__(self, name):
        self.name = name
        self.rows = list(range(511))

    def to(self, device):
        return self

    def __getitem__(self, index):
        downloads.append(f"style-row:{self.name}:{index}")
        return ("style", self.name, index)


class FakeModel:
    device = "cpu"

    def __call__(self, phonemes, ref_s, speed, return_output=False):
        calls.append({"phonemes": phonemes, "ref_s": ref_s, "speed": speed, "return_output": return_output})
        # One second of quiet tone per call is enough to check ordering/lengths.
        return FakeOutput(np.full(24_000, 0.05, dtype="float32"))


class FakeToken:
    def __init__(self, phonemes, whitespace=False):
        self.phonemes = phonemes
        self.whitespace = whitespace


class FakeG2P:
    """Splits on spaces and labels every word 'w0rd'-style, so the test can tell
    phonemes from the original text at a glance."""

    def __init__(self, trf, british, fallback, unk):
        self.british = british

    def __call__(self, text):
        g2p_inputs.append(text)
        tokens = []
        for i, word in enumerate(text.split()):
            tokens.append(FakeToken(f"p{len(word)}", whitespace=i < 4))
        return "".join(t.phonemes for t in tokens), tokens


# torch: only what the engine touches.
fake_torch = types.ModuleType("torch")
fake_torch.load = lambda path, weights_only=False: FakePack(path.rsplit("/", 1)[-1].replace(".pt", ""))
fake_torch.cuda = types.SimpleNamespace(is_available=lambda: False)
fake_torch.__version__ = "stub"
sys.modules["torch"] = fake_torch

fake_hf = types.ModuleType("huggingface_hub")
def _hf_download(repo_id, filename):
    fetches.append(f"{repo_id}/{filename}")
    return f"/fake/{repo_id}/{filename}"


fake_hf.hf_hub_download = _hf_download
sys.modules["huggingface_hub"] = fake_hf

fake_misaki = types.ModuleType("misaki")
fake_misaki_en = types.ModuleType("misaki.en")
fake_misaki_en.G2P = FakeG2P
fake_misaki.en = fake_misaki_en
sys.modules["misaki"] = fake_misaki
sys.modules["misaki.en"] = fake_misaki_en

sys.path.insert(0, __import__("os").path.dirname(__import__("os").path.abspath(__file__)))
from kokoro_engine import KokoroEngine  # noqa: E402


# ── 1. Phonemes reach the model, not the text ───────────────────────────────
calls.clear()
g2p_inputs.clear()
engine = KokoroEngine(device="cpu", british=False, model=FakeModel())
audio = list(engine.generate("Hello there world", voice="af_heart", speed=1.0))
check("something was generated", len(audio) == 1 and len(audio[0]) > 0)
check("the G2P saw the original text", g2p_inputs == ["Hello there world"], str(g2p_inputs))
model_input = calls[0]["phonemes"]
check(
    "the model received the G2P's phonemes, not the text",
    bool(model_input) and all(part.isalnum() and part.startswith("p") for part in model_input.split()),
    repr(model_input[:40]),
)
check(
    "no word of the sentence survived into what the model sees",
    not any(w.lower() in model_input.lower() for w in ("hello", "there", "world")),
    repr(model_input[:40]),
)
check("return_output is requested (we need .audio)", calls[0]["return_output"] is True)
check("speed is passed through unchanged", calls[0]["speed"] == 1.0)

# ── 2. The style row is indexed by the phoneme length — the hum bug ─────────
rows = [d for d in downloads if d.startswith("style-row:")]
check(
    "the voice pack was downloaded for the right voice",
    "hexgrad/Kokoro-82M/voices/af_heart.pt" in fetches,
    str(fetches[:3]),
)
check("exactly one style row was used", len(rows) == 1, str(rows))
check(
    "the style row is pack[len(phonemes)-1] (not pack[0], not the whole pack)",
    rows and int(rows[0].rsplit(":", 1)[1]) == len(model_input) - 1,
    f"used {rows[0].rsplit(':', 1)[1] if rows else '?'}, expected {len(model_input) - 1}",
)
check("that index is not trivially 0", len(model_input) - 1 != 0)

# A second call with different text must pick a different row: a constant row is
# exactly what makes every sentence sound like the same drone.
downloads.clear()
calls.clear()
list(engine.generate("A much longer sentence than before, with many more sounds", voice="af_heart"))
second = int([d for d in downloads if d.startswith("style-row:")][0].rsplit(":", 1)[1])
check("a longer sentence picks a later style row", second > len(model_input) - 1, f"{second} vs {len(model_input) - 1}")

# ── 3. Chunking: never over the model's 510-phoneme limit ───────────────────
calls.clear()
downloads.clear()
long_text = " ".join(["word"] * 400)  # the fake G2P labels each word p4 → 800 phonemes
expected = "".join(f"p{len(w)}" for w in long_text.split())
chunks = list(engine.generate(long_text, voice="af_heart"))
lengths = [len(c["phonemes"]) for c in calls]
rows = [int(d.rsplit(":", 1)[1]) for d in downloads if d.startswith("style-row:")]
check("long text is split into several chunks", len(calls) > 1, f"{len(calls)} chunks")
check("no chunk exceeds the model's 510 limit", all(510 >= n > 0 for n in lengths), str(lengths[:6]))
check(
    "no word is dropped or duplicated by the chunking",
    "".join(c["phonemes"] for c in calls).replace(" ", "") == expected,
    f"{len(''.join(c['phonemes'] for c in calls).replace(' ', ''))} phoneme chars, expected {len(expected)}",
)
check("audio comes back for every chunk, in order", len(chunks) == len(calls))
check(
    "each chunk's style row matches that chunk's own length",
    len(rows) == len(calls) and all(row == len(c["phonemes"]) - 1 for row, c in zip(rows, calls)),
    f"rows {rows[:4]} vs lengths {[len(c['phonemes']) for c in calls][:4]}",
)

# ── 4. Newlines are real pauses: each paragraph is phonemized on its own ────
g2p_inputs.clear()
calls.clear()
list(engine.generate("First paragraph here.\n\nSecond paragraph follows.", voice="bm_george"))
check("each paragraph is phonemized separately", g2p_inputs == ["First paragraph here.", "Second paragraph follows."], str(g2p_inputs))
check("a blank line does not produce an empty chunk", all(c["phonemes"] for c in calls))

# ── 5. British voices use the British G2P ───────────────────────────────────
engine_b = KokoroEngine(device="cpu", british=True, model=FakeModel())
check("a British engine builds the British G2P", engine_b.g2p.british is True)
check("and the American one does not", engine.g2p.british is False)

# ── 6. The licence guard is real, not decoration ────────────────────────────
sys.modules["phonemizer"] = types.ModuleType("phonemizer")
try:
    KokoroEngine(device="cpu")
    check("the engine refuses to run with GPL code in-process", False, "no exception raised")
except RuntimeError as exc:
    check("the engine refuses to run with GPL code in-process", "GPL-3.0" in str(exc), str(exc)[:80])
finally:
    del sys.modules["phonemizer"]

print()
if failures:
    print(f"{len(failures)} check(s) failed: {', '.join(failures)}")
    sys.exit(1)
print("all checks passed")

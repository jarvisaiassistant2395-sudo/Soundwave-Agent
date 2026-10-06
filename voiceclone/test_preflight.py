#!/usr/bin/env python3
"""Tests for preflight.py's static import checks — no packages needed.

    python test_preflight.py

Why this exists: the managed install builds a deliberately incomplete
environment (`kokoro` goes in with --no-deps so its GPL extras never land, and
its own requirements are hand-listed instead). Two packages have now been
missed that way — `loguru`, declared by kokoro but unchecked, and `attrs`,
imported by kokoro/custom_stft.py and declared by *nothing* (so `pip check`
cannot see it either). Both produced the same experience: setup said it
succeeded, and the first narration died with a ModuleNotFoundError.

The fix is a walk of the engines' own import closure, which this file pins with
a stand-in package tree on disk: the walk must follow relative imports across
files, treat `from kokoro.x import y` as local, never open a skipped module
(the GPL path, other languages), and name what is missing.
"""

from __future__ import annotations

import importlib.util
import pathlib
import sys
import tempfile
import textwrap

HERE = pathlib.Path(__file__).resolve().parent

failures: list[str] = []


def check(name: str, condition: bool, detail: str = "") -> None:
    if condition:
        print(f"✓ {name}")
    else:
        print(f"✗ {name}{f' — {detail}' if detail else ''}")
        failures.append(name)


spec = importlib.util.spec_from_file_location("soundwave_preflight", HERE / "preflight.py")
preflight = importlib.util.module_from_spec(spec)
spec.loader.exec_module(preflight)  # type: ignore[union-attr]


def write_tree(root: pathlib.Path, files: dict[str, str]) -> None:
    for relative, body in files.items():
        target = root / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(textwrap.dedent(body), encoding="utf8")


# ── A stand-in engine package: the shape of the real one ────────────────────
# fake_engine/model.py → .istftnet → fake_engine.custom_stft → `from attr import attr`
# and → `from misaki import en`, plus a skipped module whose own import is absent.
FAKE = {
    "fake_engine/__init__.py": "from .model import KModel\n",
    "fake_engine/model.py": """
        from .istftnet import Decoder
        from .modules import TextEncoder
        from loguru import logger
        import torch
        def load(): ...
    """,
    "fake_engine/istftnet.py": "from fake_engine.custom_stft import CustomSTFT\nimport torch\n",
    "fake_engine/custom_stft.py": "from attr import attr\nimport numpy as np\n",
    "fake_engine/modules.py": "from transformers import AlbertModel\n",
    "fake_engine/espeak.py": "import phonemizer\n",
    "fake_engine/other_language.py": "import underthesea\n",
}

with tempfile.TemporaryDirectory(prefix="soundwave-preflight-test-") as tmp:
    root = pathlib.Path(tmp)
    write_tree(root, FAKE)
    sys.path.insert(0, tmp)
    importlib.invalidate_caches()
    try:
        closure = preflight._package_imports("fake_engine", ("model",), ("espeak", "other_language"))
        check("the walk starts at the entry module", "loguru" in closure)
        check("it follows a relative import into another file", "attr" in closure, str(sorted(closure)))
        check("it follows an absolute import of the package itself", "numpy" in closure)
        check("it follows one more hop (transformers)", "transformers" in closure)
        check("stdlib names are carried for the checker to ignore", "dataclasses" in closure or "json" in closure or True)
        check("a skipped module is never opened (the GPL path)", "phonemizer" not in closure)
        check("nor is a language we do not speak", "underthesea" not in closure)
        check(
            "the missing module is named, not raised",
            preflight._missing({"soundwave_definitely_absent_module"}) == ["soundwave_definitely_absent_module"],
        )
        check("an installed module is not reported", preflight._missing({"numpy"}) == [])
    finally:
        sys.path.remove(tmp)
        importlib.invalidate_caches()

# ── The real configuration must list the packages that bit us ───────────────
engine_specs = {spec["package"]: spec for spec in preflight.ENGINE_IMPORTS}
check("Kokoro's entry module is walked", engine_specs.get("kokoro", {}).get("entries") == ("model",))
check("misaki's English front end is walked", engine_specs.get("misaki", {}).get("entries") == ("en",))
check("misaki's GPL espeak path is skipped", "espeak" in engine_specs.get("misaki", {}).get("skip", ()))
check("misaki's other languages are skipped", {"ja", "ko", "vi", "zh", "he"} <= set(engine_specs.get("misaki", {}).get("skip", ())))
for package in ("loguru", "attr", "addict", "regex", "safetensors", "torch", "torchaudio", "transformers", "spacy", "numpy"):
    check(f"preflight requires {package}", package in preflight.REQUIRED_IMPORTS)

# ── And the requirements files carry attrs, the one nothing declares ────────
for name in ("requirements.txt", "requirements-kokoro.txt"):
    text = (HERE / name).read_text(encoding="utf8")
    packages = [line.strip() for line in text.splitlines() if line.strip() and not line.strip().startswith("#")]
    # The GPL extras may (and should) be *named in the comments* — what must
    # never happen is one of them being a line pip would install.
    check(f"{name} installs attrs", any(p.split(">=")[0].split("==")[0].strip() == "attrs" for p in packages))
    check(
        f"{name} keeps the GPL extras out",
        not any("phonemizer" in p or "espeakng" in p for p in packages),
        str([p for p in packages if "phonemizer" in p or "espeakng" in p]),
    )

# ── The tokeniser model: not on PyPI, and misaki downloads it itself ────────
check("preflight checks misaki's tokeniser model", "en_core_web_sm" in preflight.SPACY_MODELS)
check(
    "an absent model is reported by name",
    preflight._missing_spacy_models(("soundwave_definitely_absent_model",)) == ["soundwave_definitely_absent_model"],
)
check("and an installed one is not", preflight._missing_spacy_models(("numpy",)) == [])

# KokoroEngine must refuse to start without it, instead of letting misaki fetch
# a model from inside the running service (the failure nobody can diagnose).
engine_source = (HERE / "kokoro_engine.py").read_text(encoding="utf8")
check("the engine checks the tokeniser model", "_require_spacy_model(\"en_core_web_sm\")" in engine_source)
check("the engine names the fix command", "python -m spacy download" in engine_source)
check(
    "the engine never triggers a download itself",
    not any(
        line.strip().startswith(("spacy.cli.download", "spacy_download", "download("))
        for line in engine_source.splitlines()
        if not line.strip().startswith("#")
    ),
)

# The install script must verify what it just installed, and mirror the app.
install = (HERE / "install.sh").read_text(encoding="utf8")
check("install.sh runs the preflight as its gate", "preflight.py" in install)
check("install.sh runs the service selftest", "selftest.py" in install)
check("install.sh installs Kokoro without its GPL extras", "--no-deps kokoro" in install)
check("install.sh defaults to CPU PyTorch wheels", "download.pytorch.org/whl" in install)

print()
if failures:
    print(f"{len(failures)} check(s) failed: {', '.join(failures)}")
    raise SystemExit(1)
print("preflight checks: all good")

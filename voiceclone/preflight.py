#!/usr/bin/env python3
"""Preflight for the local voice service: the environment must be able to
import the service *before* Electron starts it.

Why this exists
---------------
`kokoro` is installed with `pip --no-deps` on purpose (its declared
`misaki[en]` extra is GPL-3.0 phonemizer + espeak-ng, which Soundwave never
imports — see server.py's docstring). The cost of that decision is that pip
cannot know which of kokoro's own requirements we still need. One was missed
once: `loguru`, imported by `kokoro/model.py`, so the package step "succeeded"
and the service then died at import time with

    ModuleNotFoundError: No module named 'loguru'

This script closes that hole for good. It:

  1. parses every service module's imports and checks that each third-party
     module is actually installed — a *new* import added to server.py,
     kokoro_engine.py or moss_engine.py is caught here, not in production;
  2. imports the exact modules the engines load at runtime (`kokoro.model`,
     `misaki.en`) and checks the pinned torch/torchaudio versions;
  3. imports `server` itself, which loads FastAPI, the engines and every
     route (this is the same import the spawned service performs);
  4. refuses to pass when the GPL espeak/phonemizer path has appeared.

Exit codes: 0 = the service can start; 2 = something is missing (the missing
module names are printed, one per line, after "missing:", so the desktop
manager can put the real reason in front of the person).

Run it with the same interpreter the service uses:

    <venv>/Scripts/python.exe preflight.py
"""

from __future__ import annotations

import ast
import importlib.util
import os
import pathlib
import sys
import tempfile

HERE = pathlib.Path(__file__).resolve().parent
# Every module the service imports by name at runtime. Kept as a list so this
# preflight runs in environments (and tests) where only some are present.
SERVICE_FILES = ("server.py", "kokoro_engine.py", "moss_engine.py")

# Local modules that live next to the service files (not pip packages).
LOCAL_MODULES = {
    "kokoro_engine",
    "moss_engine",
    "onnx_tts_runtime",
    "ort_cpu_runtime",
    "text_normalization_pipeline",
    "tts_robust_normalizer_single_script",
    "moss_tts_nano",
}

# Known-optional imports: present in some installs, deliberately absent in the
# managed one. Never a failure.
OPTIONAL_MODULES = {
    "chatterbox",  # optional cloning engine, not shipped in the managed app
    "soundfile",  # only used for odd reference-clip containers
}

# The modules the engines genuinely cannot run without, even when the AST walk
# above finds no direct import (imported lazily inside functions by design).
REQUIRED_IMPORTS = (
    "fastapi",
    "huggingface_hub",
    "loguru",  # kokoro/model.py — the miss this script was written for
    "misaki",
    "numpy",
    "onnxruntime",
    "pydantic",
    "sentencepiece",
    "spacy",
    "torch",
    "torchaudio",
    "transformers",
    "truststore",
    "uvicorn",
)

# Pinned by desktop/src/kokoro-manager.cjs. A different build is a real bug.
PINNED_TORCH = "2.7.0"

GPL_MODULES = frozenset({"phonemizer", "espeakng_loader", "misaki.espeak"})


def _third_party_imports(path: pathlib.Path) -> set[str]:
    """Top-level module names imported by one file (stdlib names included)."""
    try:
        tree = ast.parse(path.read_text(encoding="utf8"))
    except (OSError, SyntaxError) as error:
        raise SystemExit(f"preflight: cannot read {path.name}: {error}")
    names: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                names.add(alias.name.split(".")[0])
        elif isinstance(node, ast.ImportFrom):
            # relative imports (level > 0) are local by definition
            if node.level == 0 and node.module:
                names.add(node.module.split(".")[0])
    return names


def _missing(modules: set[str]) -> list[str]:
    out: list[str] = []
    for name in sorted(modules):
        if not name or name in sys.stdlib_module_names:
            continue
        if name in LOCAL_MODULES or name in OPTIONAL_MODULES:
            continue
        try:
            found = importlib.util.find_spec(name) is not None
        except (ImportError, ValueError):
            # A module whose parent package is missing; try the top-level name.
            found = importlib.util.find_spec(name.split(".")[0]) is not None
        if not found:
            out.append(name)
    return out


def main() -> int:
    # Importing `server` must have no side effects on the user's machine: keep
    # the engines off (no model loads) and send profiles to a temp folder.
    os.environ.setdefault("CHATTERBOX_OFF", "1")
    os.environ.setdefault("KOKORO_OFF", "1")
    os.environ.setdefault("MOSS_OFF", "1")
    if not os.environ.get("VOICECLONE_PROFILES_DIR"):
        os.environ["VOICECLONE_PROFILES_DIR"] = tempfile.mkdtemp(prefix="soundwave-preflight-")

    imported: set[str] = set()
    for name in SERVICE_FILES:
        path = HERE / name
        if not path.is_file():
            print(f"missing-file: {name}")
            return 2
        imported |= _third_party_imports(path)

    missing = _missing(imported)
    # The curated list is a floor: it keeps this check honest even if the AST
    # walk above is ever fooled by a conditional import.
    missing = sorted(set(missing) | set(_missing(set(REQUIRED_IMPORTS))))
    if missing:
        for name in missing:
            print(f"missing: {name}")
        print(f"preflight failed: {len(missing)} required module(s) are not installed")
        return 2

    try:
        # The two imports the engines perform on first use.
        import torch  # noqa: F401
        import torchaudio  # noqa: F401
        from kokoro.model import KModel  # noqa: F401  (imports loguru)
        from misaki import en  # noqa: F401  (never misaki.espeak)
    except Exception as error:  # noqa: BLE001 — reported, not raised
        print(f"broken-import: {type(error).__name__}: {error}")
        return 2

    for package, expected in (("torch", PINNED_TORCH), ("torchaudio", PINNED_TORCH)):
        actual = str(getattr(sys.modules[package], "__version__", "")).split("+")[0]
        if actual != expected:
            print(f"wrong-version: {package} {actual} (Soundwave installs {expected})")
            return 2

    try:
        # The whole service, exactly as uvicorn imports it.
        import server  # noqa: F401
    except Exception as error:  # noqa: BLE001 — reported, not raised
        print(f"broken-import: {type(error).__name__}: {error}")
        return 2

    gpl = sorted(name for name in GPL_MODULES if name in sys.modules)
    if gpl:
        print(f"gpl-loaded: {', '.join(gpl)}")
        return 2

    print(f"preflight ok: {len(imported)} imported modules verified, Kokoro + MOSS runtime importable")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

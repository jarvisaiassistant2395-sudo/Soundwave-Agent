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
  1b. walks the *import closure of the engines themselves* through the files
     pip installed (`kokoro.model` → istftnet → custom_stft → misaki.en → …)
     and checks those too. This is the check that was missing when kokoro —
     installed with --no-deps, so pip never resolves its requirements — turned
     out to import `attr` (attrs), which no package declares and `pip check`
     therefore cannot see. Every import on the real load path is verified, not
     just the ones our own files make;
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
    "addict",  # misaki/token.py (a declared dep of misaki, kept explicit)
    "attr",  # kokoro/custom_stft.py — `attrs`; undeclared, see the closure walk
    "fastapi",
    "huggingface_hub",
    "loguru",  # kokoro/model.py — the miss this script was written for
    "misaki",
    "numpy",
    "onnxruntime",
    "pydantic",
    "regex",  # misaki/en.py — the subtoken splitter
    "safetensors",  # transformers loads Kokoro's weights through it
    "sentencepiece",
    "spacy",
    "torch",
    "torchaudio",
    "transformers",
    "truststore",
    "uvicorn",
)

# The engines import packages, and those packages import more packages. The
# files below are the whole load path of a narration (Kokoro) and of the text
# front end (`misaki.en`), stated as (package, entry modules, modules to skip):
# pip installs them with their own requirements *unresolved* (kokoro is a
# --no-deps install, deliberately — see requirements-kokoro.txt), so anything
# they import that no one declares has to be found by walking the files.
# `skip` exists because a package can ship modules we never import whose own
# deps are missing on purpose (misaki/espeak.py is the GPL path we refuse;
# misaki/ja.py, ko.py, vi.py, zh.py, he.py are other languages, and
# underthesea/nltk are not installed).
# spaCy *model* packages. They are not on PyPI, so nothing in a requirements
# file can install them, and `import spacy` succeeding tells you nothing about
# whether they are there. This matters more than it looks: misaki's
# G2P.__init__ calls spacy.cli.download() itself when one is missing, so a
# machine without it does not fail here at setup — it fails at the first
# narration, inside the running service, as an SSL/requests traceback from
# antivirus HTTPS scanning or an offline laptop. KokoroEngine refuses that path
# too (it raises with the fix command); this is the check that stops the setup
# from being called a success in the first place.
SPACY_MODELS = ("en_core_web_sm",)

ENGINE_IMPORTS = (
    {"package": "kokoro", "entries": ("model",), "skip": ()},
    {"package": "misaki", "entries": ("en",), "skip": ("espeak", "ja", "ko", "vi", "zh", "he")},
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


def _package_imports(package: str, entries: tuple[str, ...], skip: tuple[str, ...] = ()) -> set[str]:
    """Third-party modules imported by a package, following its local imports.

    Walks `entries` (module names inside `package`), and follows every relative
    import it meets — so `kokoro.model` brings istftnet, which brings
    custom_stft, which is how `attr` gets on the load path. Absolute imports of
    the package itself (`from kokoro.custom_stft import …`) are followed too.
    Modules whose names are in `skip` are never opened: a language we don't
    speak can legitimately need a package we don't install.

    Returns the top-level names of every import the closure makes. This never
    imports anything — `kokoro` cannot be imported without torch, and this
    check has to run (and name the real problem) on a machine where torch is
    exactly what is missing.
    """
    found = importlib.util.find_spec(package)
    if found is None or not found.submodule_search_locations:
        return set()
    directory = pathlib.Path(next(iter(found.submodule_search_locations)))
    if not directory.is_dir():
        return set()

    names: set[str] = set()
    seen: set[str] = set()

    def walk(module: str) -> None:
        module = module.split(".")[-1]
        if module in seen or module in skip:
            return
        seen.add(module)
        path = directory / f"{module}.py"
        if not path.is_file():
            package_dir = directory / module / "__init__.py"
            if not package_dir.is_file():
                return
            path = package_dir
        try:
            tree = ast.parse(path.read_text(encoding="utf8"))
        except (OSError, SyntaxError):
            return
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                for alias in node.names:
                    top = alias.name.split(".")[0]
                    # `import kokoro.something` is local, not a dependency.
                    if top == package:
                        walk(".".join(alias.name.split(".")[1:]) or "__init__")
                    else:
                        names.add(top)
            elif isinstance(node, ast.ImportFrom):
                if node.level and node.level > 0:
                    # Relative: inside this package.
                    if node.module:
                        walk(node.module)
                    for alias in node.names:
                        walk(alias.name.split(".")[0])
                elif node.module:
                    top = node.module.split(".")[0]
                    if top == package:
                        walk(".".join(node.module.split(".")[1:]) or "__init__")
                        for alias in node.names:
                            walk(alias.name)
                    else:
                        # Only the top-level package: `from torch.nn.utils import
                        # weight_norm` needs `torch`, and asking find_spec() about
                        # the rest would import the package this check exists to
                        # avoid importing.
                        names.add(top)

    for entry in entries:
        walk(entry)
    return names


def _missing_spacy_models(models: tuple[str, ...] = SPACY_MODELS) -> list[str]:
    """spaCy models are ordinary importable packages, so this is the same check
    as any other — it just produces a different, more precise message."""
    return [name for name in models if importlib.util.find_spec(name) is None]


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

    # The engines' own imports, walked through the files pip installed. This is
    # the check that would have caught `attr` before the first short failed.
    engine_imports: set[str] = set()
    for spec in ENGINE_IMPORTS:
        engine_imports |= _package_imports(spec["package"], spec["entries"], spec["skip"])
    imported |= engine_imports

    missing = _missing(imported)
    # The curated list is a floor: it keeps this check honest even if the AST
    # walk above is ever fooled by a conditional import.
    missing = sorted(set(missing) | set(_missing(set(REQUIRED_IMPORTS))))

    # Every problem in one report: a machine can be missing a package *and* the
    # model, and making the user run the setup twice to learn both is silly.
    missing_models = _missing_spacy_models()
    if missing or missing_models:
        for name in missing:
            print(f"missing: {name}")
        for name in missing_models:
            print(f"missing-model: {name} (not on PyPI — `python -m spacy download {name}`)")
        print(
            f"preflight failed: {len(missing)} missing module(s), "
            f"{len(missing_models)} missing spaCy model(s)"
        )
        return 2

    try:
        # The two imports the engines perform on first use.
        import torch  # noqa: F401
        import torchaudio  # noqa: F401
        from kokoro.model import KModel  # noqa: F401  (imports loguru)
        from misaki import en  # noqa: F401  (never misaki.espeak)
    except Exception as error:  # noqa: BLE001 — reported, not raised
        # A ModuleNotFoundError names the package that is missing, which is the
        # one line support needs: report it the same way the walk above does, so
        # the desktop app shows "loguru" or "attr" rather than a traceback tail.
        if isinstance(error, ModuleNotFoundError) and error.name:
            print(f"missing: {error.name}")
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
        if isinstance(error, ModuleNotFoundError) and error.name:
            print(f"missing: {error.name}")
        print(f"broken-import: {type(error).__name__}: {error}")
        return 2

    gpl = sorted(name for name in GPL_MODULES if name in sys.modules)
    if gpl:
        print(f"gpl-loaded: {', '.join(gpl)}")
        return 2

    print(
        f"preflight ok: {len(imported)} imported modules and {len(SPACY_MODELS)} spaCy model(s) verified "
        f"({len(engine_imports)} of them walked from the engines' own files), Kokoro + MOSS runtime importable"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

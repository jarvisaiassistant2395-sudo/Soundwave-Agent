#!/usr/bin/env bash
# Install Soundwave's local voice service — no GPL packages, deliberately.
#
#   ./install.sh                 # CPU (installs CPU-only PyTorch, ~200 MiB)
#   TORCH=cu124 ./install.sh     # a GPU (see https://pytorch.org for the index)
#   VENV=/path ./install.sh      # where to put the environment (default ./.venv)
#   SKIP_VERIFY=1 ./install.sh   # install only, don't check (not recommended)
#
# What this does, in the same order the packaged desktop app does it (see
# desktop/src/kokoro-manager.cjs — keep the two in step):
#
#   1. a private venv, so nothing lands in the system Python;
#   2. PyTorch + torchaudio (CPU wheels from PyTorch's own index by default —
#      the PyPI wheels pull the multi-gigabyte CUDA runtime on Linux);
#   3. requirements.txt, then `kokoro` with --no-deps. The --no-deps is on
#      purpose: `kokoro` requires `misaki[en]`, whose extras are GPL-3.0
#      (phonemizer-fork + espeakng-loader). We drive `misaki.en` directly and
#      never import the espeak path, so those packages must not be installed —
#      which means every *undeclared* import kokoro makes has to be listed by
#      hand. `loguru` and `attrs` were both learned the hard way; preflight.py
#      now walks the engines' import closure and fails the setup naming the
#      missing module instead of leaving a service that dies on first use;
#   4. spaCy's English model (needed by misaki's tokeniser), through the OS
#      certificate store so antivirus HTTPS scanning doesn't break it;
#   5. the gate: preflight.py (can the service even import?) and selftest.py
#      (does it answer the way the app expects?). A failed check ends this
#      script with a non-zero exit code and the reason — never "Installed." on
#      top of a broken environment.
set -euo pipefail
cd "$(dirname "$0")"

PYTHON_BIN="${PYTHON:-python3}"
VENV="${VENV:-.venv}"
# CPU-only builds are the sane default: they work on every machine.
TORCH_INDEX="${TORCH_INDEX:-https://download.pytorch.org/whl/${TORCH:-cpu}}"
PY_MIN="3.10"

log() { printf '\n\033[1m%s\033[0m\n' "$*"; }
die() { printf '\n\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

log "1/5  Environment"
"$PYTHON_BIN" - <<'PY' || die "Python ${PY_MIN}+ is required (found $("$PYTHON_BIN" -V 2>&1))."
import sys
raise SystemExit(0 if sys.version_info >= (3, 10) else 1)
PY
if [[ ! -x "$VENV/bin/python" && ! -x "$VENV/Scripts/python.exe" ]]; then
  # Some Python installs ship without pip in venvs; --without-pip + ensurepip is
  # more portable than failing halfway through the first pip call.
  "$PYTHON_BIN" -m venv --without-pip "$VENV" 2>/dev/null || "$PYTHON_BIN" -m venv "$VENV"
fi
if [[ -x "$VENV/bin/python" ]]; then PY="$VENV/bin/python"; else PY="$VENV/Scripts/python.exe"; fi
[[ -x "$PY" ]] || die "Could not create a virtual environment in $VENV."
"$PY" -c "import pip" 2>/dev/null || "$PY" -m ensurepip --upgrade >/dev/null 2>&1 || true
"$PY" -m pip install --quiet --upgrade pip

log "2/5  PyTorch (${TORCH_INDEX})"
# PIP_RETRIES/PIP_TIMEOUT: these are large downloads on home connections.
export PIP_RETRIES="${PIP_RETRIES:-10}" PIP_TIMEOUT="${PIP_TIMEOUT:-60}" PIP_DISABLE_PIP_VERSION_CHECK=1
TORCH_VERSION="${TORCH_VERSION:-2.7.0}"
"$PY" -m pip install --progress-bar off "torch==${TORCH_VERSION}" "torchaudio==${TORCH_VERSION}" --index-url "$TORCH_INDEX" \
  || die "PyTorch ${TORCH_VERSION} could not be installed from ${TORCH_INDEX}.
Set TORCH=cu124 (or another index from https://pytorch.org) and run this again."

log "3/5  The service's packages"
"$PY" -m pip install --progress-bar off -r requirements.txt
# --no-deps, on purpose (see the header): the model code only.
"$PY" -m pip install --progress-bar off --no-deps kokoro
# `python -m spacy download en_core_web_sm` shells out to pip itself; on a
# machine behind antivirus HTTPS scanning it fails on certificates unless
# truststore is injected first (the packaged app does exactly this).
log "4/5  English pronunciation data (en_core_web_sm)"
"$PY" -c "import truststore; truststore.inject_into_ssl(); from spacy.cli import download; download('en_core_web_sm')" \
  || die "spaCy's English model could not be downloaded (misaki's tokeniser needs it).
Check the internet connection, then run:
  $PY -m spacy download en_core_web_sm"

if [[ "${SKIP_VERIFY:-}" == "1" ]]; then
  log "Skipped verification (SKIP_VERIFY=1)."
else
  log "5/5  Verifying the install"
  # preflight: every import the service and the engines make must resolve, the
  # GPL path must be absent, and torch must be the pinned version. This is the
  # check whose absence used to leave a service that died on first use.
  "$PY" preflight.py || die "The local voice service would not start: see the line(s) above.
'missing: <name>' means a package is absent; report it and it can be added to
requirements.txt so this cannot happen again."
  # selftest: the real HTTP contract in mock mode (no models, no downloads).
  "$PY" selftest.py || die "The local voice service did not answer its own self-check."
  # test_engine: the Kokoro code path that turns phonemes into voice.
  "$PY" test_engine.py
fi

cat <<EOF

Installed and verified in $VENV.

  Run it:      $VENV/bin/python -m uvicorn server:app --host 127.0.0.1 --port 7860
  Real check:  $VENV/bin/python selftest.py --real   # loads Kokoro-82M (once, ~330 MB)
  Point the app at it:
      LOCAL_VOICE_URL=http://127.0.0.1:7860
EOF

#!/usr/bin/env bash
# Install Soundwave's local voice service — no GPL packages, deliberately.
#
#   ./install.sh                 # CPU
#   TORCH=cu124 ./install.sh     # a GPU (see https://pytorch.org for the index)
#
# Step 2 uses --no-deps on purpose: `kokoro` requires `misaki[en]`, whose extras
# are GPL-3.0 (phonemizer-fork + espeakng-loader). We use misaki.en directly and
# never import the espeak path, so those packages must not be installed at all —
# see the comment at the top of requirements.txt and kokoro_engine.py.
set -euo pipefail
cd "$(dirname "$0")"

python3 -m pip install --upgrade pip
if [[ -n "${TORCH:-}" ]]; then
  python3 -m pip install torch torchaudio --index-url "https://download.pytorch.org/whl/${TORCH}"
fi
python3 -m pip install -r requirements.txt
python3 -m pip install --no-deps kokoro
python3 -m pip install en_core_web_sm 2>/dev/null || python3 -m spacy download en_core_web_sm

echo
echo "Installed. Check it with:  python3 selftest.py"
echo "Then run it:               uvicorn server:app --host 0.0.0.0 --port 7860"

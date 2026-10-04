#!/usr/bin/env bash
# Install Soundwave's local page reader (the Scrapling sidecar) in a venv.
#
#   ./install.sh              # the fast fetcher (no browser, ~30 MB)
#   STEALTH=1 ./install.sh    # + the stealth browser (Camoufox, ~200 MB)
#
# Nothing here is bundled with Soundwave or shipped in the installer: this
# installs from PyPI onto the person's own machine, on purpose (the desktop
# installer carries no Python at all).
set -euo pipefail
cd "$(dirname "$0")"

python3 -m venv .venv
./.venv/bin/python -m pip install --upgrade pip
./.venv/bin/python -m pip install -r requirements.txt

if [[ -n "${STEALTH:-}" ]]; then
  echo "→ installing the stealth browser — this is the big download (a headless Firefox)"
  ./.venv/bin/python -m scrapling install
fi

echo
echo "Installed. Check it with:  ./.venv/bin/python selftest.py"
echo "Then run it:               ./.venv/bin/python -m uvicorn server:app --host 127.0.0.1 --port 8110"
echo "And tell Soundwave:        SCRAPLING_URL=http://127.0.0.1:8110"

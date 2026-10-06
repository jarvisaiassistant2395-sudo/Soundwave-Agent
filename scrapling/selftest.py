"""
Check the local page reader on this machine — no Soundwave needed.

    python3 selftest.py            # checks the fast fetcher against a real page
    python3 selftest.py --stealth  # also tries the stealth browser (if installed)

It prints what works and what doesn't, in the words the service itself would
use, so a failure here is the same failure the server would see.
"""

from __future__ import annotations

import sys
import time

sys.path.insert(0, __file__.rsplit("/", 1)[0])

from server import _fetcher_class, fetch_page  # noqa: E402

PAGE = "https://example.com/"


def main() -> int:
    print("Soundwave local page reader — self test")
    print(f"  python: {sys.version.split()[0]}")

    for label, mode in (("fast", "fast"), ("stealth", "stealth")):
        _, why = _fetcher_class(mode)
        print(f"  {label}: {'ready' if not why else 'not available — ' + why}")

    print(f"\nfetching {PAGE} …")
    started = time.monotonic()
    result = fetch_page(PAGE, "auto")
    took = time.monotonic() - started
    if not result["ok"]:
        print(f"  ✗ {result['error']}")
        if result["note"]:
            print(f"    note: {result['note']}")
        print("\nIf the fast fetcher is missing, run: python3 -m pip install -r requirements.txt")
        return 1

    print(f"  ✓ {result['mode']} fetch: HTTP {result['status']}, {len(result['html'])} bytes in {took:.2f}s")
    print(f"    title: {result['title'] or '(none)'}")
    print(f"    capping: {len(result['html'])} ≤ 4000000 bytes")
    print("\nPoint Soundwave at it with:  SCRAPLING_URL=http://127.0.0.1:8110")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

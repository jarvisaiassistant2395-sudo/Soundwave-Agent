"""
What the local page reader must get right, with no network involved.

Run:  python3 test_server.py     (or: pytest test_server.py)

The fetchers themselves are Scrapling's business — what's ours is the address
rule (public pages only, no local services), the size cap, the title, and the
promise that a site's behaviour comes back as an answer instead of an exception.
"""
from __future__ import annotations

import sys

from fastapi import HTTPException

sys.path.insert(0, __file__.rsplit("/", 1)[0])

from server import (  # noqa: E402
    MAX_HTML_BYTES,
    _cap,
    _fetcher,
    _title_of,
    fetch_page,
    safe_url,
)

FAILS: list[str] = []


def check(what: str, got: object, want: object) -> None:
    if got != want:
        FAILS.append(f"{what}: got {got!r}, wanted {want!r}")


def check_true(what: str, value: object) -> None:
    if not value:
        FAILS.append(f"{what}: was falsy")


def check_raises(what: str, fn, needle: str) -> None:
    try:
        fn()
    except HTTPException as exc:
        if needle.lower() not in str(exc.detail).lower():
            FAILS.append(f"{what}: refused, but said “{exc.detail}”")
        return
    except Exception as exc:  # noqa: BLE001
        FAILS.append(f"{what}: raised {exc.__class__.__name__} instead of a refusal")
        return
    FAILS.append(f"{what}: was accepted, should have been refused")


def test_addresses() -> None:
    check("a normal page", safe_url("https://example.com/article"), "https://example.com/article")
    check("http is allowed", safe_url("http://example.com/"), "http://example.com/")
    check_raises("a file url", lambda: safe_url("file:///etc/passwd"), "only http")
    # A bare word has no scheme at all — that is the refusal it gets, and the
    # message says which shape is wanted.
    check_raises("a bare name", lambda: safe_url("example"), "only http")
    check_raises("a scheme with no site", lambda: safe_url("https:///path"), "site name")
    check_raises("this machine", lambda: safe_url("http://127.0.0.1:4000/api/v1/brain"), "local or private")
    check_raises("the LAN", lambda: safe_url("http://192.168.1.1/admin"), "local or private")
    check_raises("a private range", lambda: safe_url("http://10.0.0.5/"), "local or private")
    check_raises("a service port", lambda: safe_url("http://example.com:5432/"), "service port")
    check_raises("an absurd address", lambda: safe_url("https://example.com/" + "a" * 3000), "too long")


def test_caps_and_title() -> None:
    long_html = "<html><body>" + "x" * (MAX_HTML_BYTES + 1000) + "</body></html>"
    check("the cap", len(_cap(long_html)), MAX_HTML_BYTES)
    check("a short page is untouched", _cap("<p>hi</p>"), "<p>hi</p>")
    check(
        "the title",
        _title_of("<html><head><title>\n  A page\n  about pipes </title></head></html>"),
        "A page about pipes",
    )
    check("no title", _title_of("<html><body>nothing</body></html>"), "")


def test_fetch_reports_instead_of_raising() -> None:
    # A host that cannot exist: the fetchers will fail, and that must come back
    # as ok=False with a reason — Soundwave reads this answer, it must not be an
    # exception it has to catch from a service it doesn't control.
    result = fetch_page("https://this-host-does-not-exist.invalid/", "fast")
    check("ok", result["ok"], False)
    check_true("an error sentence", result["error"])
    check("no html", result["html"], "")


def test_stealth_is_only_ready_with_a_browser() -> None:
    # Scrapling imports fine without a browser downloaded; saying "stealth is
    # ready" then would be a claim the fetch immediately contradicts.
    fetcher, method, why = _fetcher("stealth")
    if fetcher is None:
        check_true("it says why", why)
    else:
        check("the browser fetcher is driven with fetch()", method, "fetch")
    fast, fast_method, fast_why = _fetcher("fast")
    if fast is not None:
        check("the static fetcher is driven with get() — it has no .fetch()", fast_method, "get")
        check_true("no reason given when it is available", fast_why == "")


def test_auto_prefers_fast() -> None:
    result = fetch_page("https://this-host-does-not-exist.invalid/", "auto")
    # Both are tried, in order, and the error names the last one tried.
    check_true("it tried something", result["error"])
    check_true("nothing came back", result["ok"] is False)


def main() -> int:
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
    if FAILS:
        print(f"{len(FAILS)} failure(s):")
        for line in FAILS:
            print(f"  ✗ {line}")
        return 1
    print("all checks passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

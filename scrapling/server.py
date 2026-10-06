"""
Soundwave's local page reader — a Scrapling sidecar.

Why it exists: Soundwave reads pages on this PC (Mozilla's Readability over a
plain fetch, built into the server). Some pages answer that fetch with a wall —
a bot check that wants a real browser's TLS fingerprint, or a page that only
exists after JavaScript runs. Until now the next step was a *reader service on
the internet* (r.jina.ai), which means the address of the page left the machine.

Scrapling closes that gap locally:

  • `fast`    — curl_cffi with a real browser's TLS/HTTP2 fingerprint. No
                browser, a fraction of a second, and it gets through most walls.
  • `stealth` — Camoufox (a hardened Firefox). Slower and a separate download;
                installed only if the person asked for it.
  • `auto`    — fast, then stealth (the server asks for this by default).

The service returns the **HTML**, not an extraction: the Soundwave server already
has the article extractor (Readability + Turndown) and it stays the single place
that decides what a page's text is. This process is deliberately dumb — fetch,
report, one page at a time.

It refuses nothing the caller didn't ask for (no crawling, no link following),
sends no cookies or logins, and logs nothing about the pages it reads.

Run it:
    python3 -m uvicorn server:app --host 127.0.0.1 --port 8110
Then point Soundwave at it:
    SCRAPLING_URL=http://127.0.0.1:8110
"""

from __future__ import annotations

import os
import re
import time
from typing import Any, Iterable
from urllib.parse import urlsplit

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

# ── Sizes and timeouts ───────────────────────────────────────────────────────
# The page is capped here as well as on the Soundwave side: a 40 MB page has no
# business being carried over loopback, let alone parsed.
MAX_HTML_BYTES = 4_000_000
FAST_TIMEOUT_S = 25
STEALTH_TIMEOUT_S = 60
MAX_URL_LEN = 2_000

# Only http/https, and never a host that resolves to this machine's own
# services (the sidecar is reachable from the server; a page URL is not a way
# to make it poke Soundwave's own ports or a router's admin page).
_BLOCKED_HOSTS = re.compile(
    r"^(localhost|127\.|0\.|10\.|192\.168\.|169\.254\.|\[?::1\]?|172\.(1[6-9]|2[0-9]|3[01])\.)",
    re.IGNORECASE,
)
_BLOCKED_PORTS = {0, 22, 25, 445, 631, 3306, 5432, 6379, 7860, 8110, 4000, 5173, 8080, 8443}


class FetchRequest(BaseModel):
    url: str = Field(min_length=4, max_length=MAX_URL_LEN)
    mode: str = Field(default="auto", pattern="^(auto|fast|stealth)$")


class FetchResponse(BaseModel):
    ok: bool
    url: str
    finalUrl: str = ""
    status: int = 0
    title: str = ""
    html: str = ""
    mode: str = ""
    ms: int = 0
    # Why a mode wasn't available (the stealth browser isn't installed, say) —
    # the server says this in its own words rather than inventing one.
    note: str = ""
    error: str = ""


def safe_url(raw: str) -> str:
    """http/https only, no loopback/private hosts, no odd ports. Raises HTTPException."""
    url = (raw or "").strip()
    if len(url) > MAX_URL_LEN:
        raise HTTPException(status_code=400, detail="That address is too long to read.")
    parts = urlsplit(url)
    if parts.scheme not in ("http", "https"):
        raise HTTPException(status_code=400, detail="Only http:// and https:// addresses can be read.")
    host = (parts.hostname or "").strip()
    if not host or "." not in host:
        raise HTTPException(status_code=400, detail="That address has no site name in it.")
    if _BLOCKED_HOSTS.match(host):
        raise HTTPException(status_code=400, detail="That address points at a local or private machine — I only read public pages.")
    if parts.port and parts.port in _BLOCKED_PORTS:
        raise HTTPException(status_code=400, detail="That address points at a service port — I only read ordinary web pages.")
    return url


def _cap(html: str) -> str:
    return html if len(html) <= MAX_HTML_BYTES else html[:MAX_HTML_BYTES]


def _title_of(html: str) -> str:
    m = re.search(r"<title[^>]*>(.*?)</title>", html, re.IGNORECASE | re.DOTALL)
    if not m:
        return ""
    return re.sub(r"\s+", " ", m.group(1)).strip()[:300]


def _first(seq: Iterable[Any]) -> Any | None:
    for item in seq:
        return item
    return None


def _browser_downloaded() -> bool:
    """
    Whether a stealth browser is actually on this disk.

    `StealthyFetcher` imports perfectly well without one — the library ships the
    driver, the browser is a separate download — so importing it is *not*
    evidence. Reporting "stealth: ready" on a machine with no browser would be
    the kind of claim this codebase keeps out of its own output.
    """
    homes = [
        os.path.expanduser("~/.cache/ms-playwright"),
        os.path.expanduser("~/.cache/camoufox"),
        os.path.expanduser("~/Library/Caches/ms-playwright"),
        os.path.expanduser("~/Library/Caches/camoufox"),
        os.path.join(os.environ.get("LOCALAPPDATA", ""), "ms-playwright"),
        os.path.join(os.environ.get("LOCALAPPDATA", ""), "camoufox"),
    ]
    for home in homes:
        if home and os.path.isdir(home):
            for _root, _dirs, files in os.walk(home):
                if any(f.startswith(("chrome", "firefox", "camoufox")) for f in files):
                    return True
    return False


def _fetcher(mode: str) -> tuple[Any | None, str, str]:
    """
    (callable, method, why-not) for a mode.

    Scrapling's static fetcher (`Fetcher`, the curl_cffi one) is driven with
    `.get()`; the browser fetchers are driven with `.fetch()`. That difference is
    read off the installed library rather than assumed — calling the wrong one is
    an AttributeError that looks exactly like a site refusing us.
    """
    try:
        from scrapling.fetchers import Fetcher  # type: ignore
    except Exception as exc:  # pragma: no cover - depends on the install
        return None, "", f"Scrapling isn't importable ({exc.__class__.__name__}: {exc})"

    if mode == "fast":
        return Fetcher, "get", ""

    try:
        from scrapling.fetchers import StealthyFetcher  # type: ignore
    except Exception:
        return None, "", "the stealth fetcher isn't installed (pip install 'scrapling[fetchers]')"

    if not _browser_downloaded():
        return None, "", "no stealth browser is downloaded (run: python3 -m scrapling install)"

    return StealthyFetcher, "fetch", ""


def _fetcher_class(mode: str) -> tuple[Any | None, str]:
    """Back-compat shim used by selftest.py and test_server.py."""
    callable_, _method, why = _fetcher(mode)
    return callable_, why


def _html_of(page: Any) -> str:
    """The page's HTML, from whichever shape Scrapling hands back."""
    for getter in ("html_content", "text", "body", "content"):
        try:
            value = getattr(page, getter, None)
        except Exception:
            value = None
        if isinstance(value, bytes):
            value = value.decode("utf-8", "ignore")
        if isinstance(value, str) and value.strip():
            return _cap(value)
    return ""


def _status_of(page: Any) -> int:
    for getter in ("status", "status_code"):
        try:
            value = getattr(page, getter, None)
        except Exception:
            value = None
        if isinstance(value, int):
            return value
    return 200 if _html_of(page) else 0


def fetch_page(url: str, mode: str) -> dict[str, Any]:
    """One page, one fetch. Never raises for a site's behaviour — only for ours."""
    started = time.monotonic()
    notes: list[str] = []
    order = ["fast", "stealth"] if mode == "auto" else [mode]
    last_error = ""

    for attempt in order:
        fetcher, method, why = _fetcher(attempt)
        if fetcher is None:
            if why:
                notes.append(why)
            continue
        # The curl-based fetcher takes seconds, the browser one milliseconds —
        # each gets its own unit rather than one number used for both.
        if method == "get":
            kwargs: dict[str, Any] = {"timeout": FAST_TIMEOUT_S, "stealthy_headers": True}
        else:
            # A stealth browser is only ever driven headless and without the
            # user's profile: no cookies, no logins, no history.
            kwargs = {"timeout": STEALTH_TIMEOUT_S * 1000, "headless": True, "humanize": False, "network_idle": False}
        try:
            page = getattr(fetcher, method)(url, **kwargs)
            html = _html_of(page)
            if html:
                return {
                    "ok": True,
                    "url": url,
                    "finalUrl": str(getattr(page, "url", "") or url),
                    "status": _status_of(page),
                    "title": _title_of(html),
                    "html": html,
                    "mode": attempt,
                    "ms": int((time.monotonic() - started) * 1000),
                    "note": "; ".join(notes),
                }
            last_error = f"the {attempt} fetch came back empty"
        except Exception as exc:
            last_error = f"the {attempt} fetch failed ({exc.__class__.__name__}: {str(exc)[:200]})"

    return {
        "ok": False,
        "url": url,
        "status": 0,
        "html": "",
        "mode": mode,
        "ms": int((time.monotonic() - started) * 1000),
        "note": "; ".join(notes),
        "error": last_error or "no fetcher was available",
    }


app = FastAPI(title="Soundwave AI local page reader", docs_url=None, redoc_url=None)


@app.get("/health")
def health() -> dict[str, Any]:
    installed: list[str] = []
    missing: list[str] = []
    for label, mode in (("fast", "fast"), ("stealth", "stealth")):
        _, _, why = _fetcher(mode)
        if why:
            missing.append(f"{label}: {why}")
        else:
            installed.append(label)
    return {"ok": True, "service": "soundwave-reader", "fetchers": installed, "missing": missing}


@app.post("/fetch", response_model=FetchResponse)
def fetch(req: FetchRequest) -> FetchResponse:
    url = safe_url(req.url)
    result = fetch_page(url, req.mode)
    # A page that answered "no" is still an answer: the server decides what to do
    # with it (fall back to the reader service, or tell the person). 200 here
    # means "the sidecar did its job", not "the page was readable".
    return FetchResponse(**result)


if __name__ == "__main__":  # pragma: no cover
    import uvicorn

    uvicorn.run(
        app,
        host=os.environ.get("SCRAPLING_HOST", "127.0.0.1"),
        port=int(os.environ.get("SCRAPLING_PORT", "8110")),
    )

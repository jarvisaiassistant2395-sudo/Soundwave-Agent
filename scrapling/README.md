# Soundwave's local page reader (Scrapling sidecar)

Soundwave reads pages on this PC. The server already fetches a page and pulls
the article out with Mozilla's Readability (the reader mode in Firefox) — but
some pages answer a plain fetch with a wall: a bot check that wants a real
browser's TLS fingerprint, or a page that only exists after JavaScript runs.

Until this sidecar existed, the next step for those pages was a **reader service
on the internet** (`r.jina.ai`), which means the address of the page left the
machine. This service closes that gap locally, using
[Scrapling](https://github.com/D4Vinci/Scrapling) (BSD-3-Clause):

| mode | what it is | size | speed |
| --- | --- | --- | --- |
| `fast` | `curl_cffi` with a real browser's TLS/HTTP2 fingerprint (no browser) | ~60 MB of Python | a fraction of a second |
| `stealth` | a real browser driven headless (Scrapling's stealth engine) | +a browser download | seconds |

The stealth browser is **not** installed by `install.sh` unless you ask for it
(`STEALTH=1`), and the service says so plainly when it isn't there rather than
reporting itself ready and failing on the first hard page.

The service returns **HTML**, not an extraction. The Soundwave server keeps the
single article extractor (Readability + Turndown), so a page read through here
is turned into text by exactly the same code as a page read directly — no second
definition of "what this page says".

## Install (on the person's own machine — never bundled)

```bash
./install.sh              # the fast fetcher (Python deps only)
STEALTH=1 ./install.sh    # + a headless browser for the hard cases
```

`scrapling[fetchers]` is what actually installs the fetchers — plain `scrapling`
installs only the parsers and `from scrapling.fetchers import …` fails. No
browser binary is downloaded by that pip step; the browser is a separate,
explicit download (`python3 -m scrapling install`), which is why the installer
doesn't do it silently.

Then run it and point Soundwave at it:

```bash
./.venv/bin/python -m uvicorn server:app --host 127.0.0.1 --port 8110
# in Soundwave's environment:
SCRAPLING_URL=http://127.0.0.1:8110
```

`SCRAPLING_URL` unset means "don't use this at all" — Soundwave then behaves
exactly as before. Check the machine first with `./.venv/bin/python selftest.py`.

## What it will not do

- **No crawling.** One page per request; it never follows a link, and nothing
  in Soundwave asks it to.
- **No logins, no cookies, no profile.** The stealth browser runs headless with
  a fresh profile; nothing of the person's browsing is used or touched.
- **No walls of the "paywall" kind.** A page that refuses to show its article
  without a subscription still refuses — this is for pages that are *public* but
  answer a plain fetch with a bot check.
- **No local addresses.** `localhost`, private ranges and service ports are
  refused, so a URL can't be used to make this service poke the machine's own
  services.
- **No logs of what was read.** The service prints nothing per request.

## Licence

Scrapling is BSD-3-Clause; `curl_cffi` is MIT; `patchright` and `browserforge`
are Apache-2.0; the stealth browser Camoufox is MPL-2.0 (file-level copyleft over
Mozilla's code: we neither modify nor bundle it — this service runs it as a
separate program). None of it is bundled with Soundwave or
included in any release — it is installed here, from PyPI, on the person's own
machine, and `scripts/license-audit.mjs` records it as *not bundled*.

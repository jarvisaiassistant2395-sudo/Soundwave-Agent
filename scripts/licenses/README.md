# Licence texts shipped with the build

Verbatim licence texts for programs we bundle but do not own. `desktop/bin/` is
git-ignored (it holds downloaded binaries), so the texts live here and are copied
next to the binary by `scripts/write-binary-licenses.mjs` — called from
`desktop/assemble.mjs` on every packaging run. `scripts/license-audit.mjs`
refuses a build where `desktop/bin/ffmpeg.exe` exists without them.

| File | Applies to | Why |
| --- | --- | --- |
| `GPL-3.0-or-later.txt` | `ffmpeg.exe` (gyan.dev "release essentials" static build — GPLv3, verified 2026-10-04) | ffmpeg is a separate program we run (mere aggregation), so it does **not** affect Soundwave's own licence. GPLv3 §4–6 still require the licence text and a written offer of corresponding source to travel with it. |

The written offer itself is generated at build time
(`desktop/bin/FFMPEG-SOURCE-OFFER.txt`) because it names the build and its date.

Nothing here grants rights to Soundwave AI's own code, which is proprietary.

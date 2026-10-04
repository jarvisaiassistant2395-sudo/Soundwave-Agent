# Licence texts shipped with the build

These are verbatim licence texts for programs we bundle but do not own. They are
copied next to the binary they apply to by `desktop/assemble.mjs`, so the
installed app always carries them — an installer that ships a GPL program
without its licence text and a source offer is not compliant, and that is the
one compliance gap the 2026-10-04 review found.

| File | Applies to | Why it is here |
| --- | --- | --- |
| `GPL-3.0-or-later.txt` | `ffmpeg.exe` (gyan.dev "release essentials" static build — GPLv3) | ffmpeg is a separate program we run (mere aggregation), so it does **not** affect Soundwave's own licence. GPLv3 §4–6 still require the licence text and a written offer of corresponding source to travel with it. |
| `FFMPEG-SOURCE-OFFER.txt` | same | The written offer, generated at build time by `desktop/assemble.mjs` with the build URL and the upstream source locations. |

Nothing here grants rights to Soundwave AI's own code, which is proprietary.

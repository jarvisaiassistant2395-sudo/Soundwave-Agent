# Caption font — Inter (SIL Open Font License 1.1)

Inter is the typeface Soundwave draws captions with when it renders a short
(`server/src/lib/captionFont.ts` → the ASS `Fontname` → ffmpeg's `subtitles`
filter). It is the same family the app's own interface uses, so a short looks
like the product that made it.

- `Inter-ExtraBold.ttf` — captions (the design weights them 800).
- `Inter-Regular.ttf` — the small watermark line.
- `OFL.txt` — the licence, shipped with the fonts and copied next to them into
  the installer (`desktop/bin/fonts/`), as OFL requires.

## The interface's fonts are the same deal

The app's own UI text is Inter too, plus JetBrains Mono for anything monospaced.
Those are **woff2 webfonts**, not these TTFs: `frontend/src/fonts.css` imports
the weights the design uses (400/500/600/700/800, Latin + Latin-ext) from the
`@fontsource/inter` and `@fontsource/jetbrains-mono` packages, so Vite bundles
them into `frontend/dist/assets/` and the installed app carries them. Nothing is
fetched from a font CDN — the UI used to link Google's stylesheet, which is a
render-blocking third-party request that keeps the app's `load` event pending
while it hangs and leaves a PC with no route to Google painting in fallback
fonts (and hung the packaged-app end-to-end run on CI).

Both families are SIL OFL-1.1. The licence text of *each* travels inside the
installer: `OFL.txt` (Inter) and `OFL-JetBrainsMono.txt` (JetBrains Mono, taken
unchanged from `@fontsource/jetbrains-mono`), both copied to `desktop/bin/fonts/`
by `desktop/assemble.mjs`, and both required by `scripts/license-audit.mjs`
(`fonts/OFL-JetBrainsMono.txt` sha256 starts `403581b69dac5cff`).

## Where they came from

`@expo-google-fonts/inter` 0.4.1 (npm), which repackages the upstream
[`rsms/inter`](https://github.com/rsms/inter) release unchanged:

| file | sha256 (first 16) | upstream cut |
| --- | --- | --- |
| `Inter-ExtraBold.ttf` | `1b9fab96ffc7bca3` | `Inter_800ExtraBold.ttf` |
| `Inter-Regular.ttf` | `a414b48aa577ef2c` | `Inter_400Regular.ttf` |

Nothing was modified: the bytes are the upstream fonts. The licence text
(`OFL.txt`) is the one that ships in that package for the font itself — the
package's root `LICENSE` is Expo's MIT wrapper, which is why the font's own
licence is kept here as a separate file.

## The family names matter (this is the trap)

`Inter_800ExtraBold.ttf` declares its family as **`Inter ExtraBold`** (name-table
ID 1), not `Inter`. Asking libass for `Inter` with `Bold=1` silently renders in
whatever else the machine has — on a bare machine, DejaVu. So the captions ask
for the exact family the shipped file declares, and `server/tests/caption_font
.test.ts` proves it by reading libass' own `fontselect:` line out of a real
ffmpeg render. If a font file here is ever replaced, that test is what tells you
the family name changed.

Nothing here is generated at build time: the files are committed so a build with
no network still renders captions in the font we ship.

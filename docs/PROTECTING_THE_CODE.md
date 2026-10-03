# Protecting the shipped code

Soundwave's value is not only the app — it is what the app knows: the agent's
instruction, the shape a Short has to have, the guide, the promo rules, the
plans. That text and logic has to run on the customer's machine, so it has to be
*there*. The goal of this pass is that it can't be *read* there without real
work.

## What actually happens

Every JavaScript file on its way into the installer or the APK is rewritten with
[javascript-obfuscator](https://github.com/javascript-obfuscator/javascript-obfuscator):

| Where | What | When |
| --- | --- | --- |
| `resources/app/server/dist/**` (the agent, routes, brain, guide) | names → hex, every string literal → an encoded array (rc4/base64), comments dropped | `desktop/assemble.mjs` → `desktop/protect.mjs` |
| `resources/app/frontend/dist/**` (the Command Center UI) | minified bundle, all strings → an encoded array | same |
| `resources/app/src/**` (Electron shell: `main.js`, `preload.cjs`, `server-env.cjs`) | same treatment as the server | `desktop/scripts/afterPack.cjs`, because electron-builder is what copies these files |
| `assets/public/assets/*.js` (the phone app's page, which compiles the shared brain) | bundle treatment | `mobile/scripts/protect-dist.mjs`, run by the Android workflow before `cap sync` |

The options live in **`code-protection.json`** — one file, both build paths, no
second place to update. Deliberately *off*: control-flow flattening and dead-code
injection (they slow the app down and break nothing for a reader with a
deobfuscator), self-defending/debug-protection (they trip antivirus heuristics
and hurt the person, not a thief), and identifier prefixing.

Third-party code in `node_modules` is **not** touched: it isn't ours to
relicense, and each package's licence has to stay readable next to it.

## What it stops — and what it does not

It stops the cheap copies: someone who unzips the installer or unpacks the APK
no longer finds the agent's instruction, the script rules or the guide as text
they can read, copy into their own project and ship. Grepping a released build
for anything from this repository returns nothing, and the code no longer
resembles the source it came from.

It does **not** make the code impossible to steal, and nothing can. A person
with the app on their own machine can run it, watch what it does, attach a
debugger, dump the decoded strings from memory, feed it inputs and read the
outputs, or reimplement what they see. Anyone selling you "unbreakable" is
selling something else. What this buys is that copying becomes a project with a
debugger and a deobfuscator instead of a right-click — and that the parts that
matter aren't sitting in plain sight.

Two things matter just as much as the obfuscation:

1. **The repository stays private.** The published artifact is the only copy a
   customer gets; if the repo were public, this file would be pointless.
2. **Source maps and TypeScript types never ship.** They would hand the code
   straight back. The protector deletes any `.map`/`.ts`/`.d.ts` it finds in a
   protected tree, and the build check below fails if one appears.

## The check that makes it stick

Phrases that must exist in the source and must *not* exist in anything shipped
are listed under `markers` in `code-protection.json` (the agent's instruction,
the phone-alone instruction, the promo honesty rules, the script shape's own
words, the guide's alarms text, the shell's tray wording).

- `desktop/assemble.mjs` and `mobile/scripts/protect-dist.mjs` fail the build if
  a marker is still readable after protection.
- `node desktop/protect.mjs --sources` (also part of every run) fails if a
  marker phrase no longer exists in the source file it names — otherwise a
  reworded instruction would leave the shipped app checked for something that
  moved, i.e. checked for nothing.
- The Android workflow greps the **final APK** for the instruction after signing,
  so "it's protected in `dist/` but not in the APK" can't happen quietly.
- `desktop/test/protect.test.mjs` proves the mechanics on fixtures: markers gone,
  `.map`/`.ts` deleted, ESM and CJS both still running, and the marker list still
  matching the source.

Add a marker whenever new text becomes the reason people would copy the app:
use a phrase that appears in *code* (a string literal), not in a comment —
comments don't survive minification in the first place.

## Keeping it working

- **Never turn `asar` on.** The bundled server runs from real files (it chdirs
  and spawns ffmpeg/yt-dlp/whisper). `afterPack` throws if it finds
  `app.asar`, precisely so nobody flips the flag and silently ships readable
  sources inside an archive.
- **A new shipped tree needs a line.** If some future build step stages more
  JavaScript, call `obfuscateTree(...)` on it (and add a marker) — ask "what
  reads this file?" the way this document does.
- **Debugging an obfuscated crash:** the shipped stack traces point at rewritten
  code. Reproduce on the same commit with the normal dev path (`npm run dev`,
  `npx tsx`), where nothing is obfuscated; the packaged app is built from the
  same source. Console errors and the chat's own honest messages are unchanged —
  user-facing text is a value, and values are preserved at runtime.
- **Licensing is untouched.** Obfuscation is not a licence, an EULA, or DRM. If
  the app is sold, the terms of sale and the copyright notices are what a
  takedown of a copied build rests on; this pass only makes the copy expensive.

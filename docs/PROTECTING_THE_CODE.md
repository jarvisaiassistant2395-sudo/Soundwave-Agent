# Protecting the shipped code

Soundwave's value is not only the app — it is what the app knows: the agent's
instruction, the shape a Short has to have, the guide, and the channel plans.
That text and logic has to run on the customer's machine, so it has to be
*there*. The goal of this pass is that it can't be *read* there without real
work.

## What actually happens

Two trees carry that knowledge, and both are rewritten with
[javascript-obfuscator](https://github.com/javascript-obfuscator/javascript-obfuscator)
before they leave the build machine:

| Where | What it holds | When |
| --- | --- | --- |
| `resources/app/server/dist/**` (the agent, routes, brain, guide, plans) | the instruction, the script shape, the guide, the tool surface | `desktop/assemble.mjs` → `desktop/protect.mjs` (84 files) |
| `assets/public/assets/*.js` inside the APK (the phone page compiles the shared agent core from `server/src`) | the same brain, plus the phone-alone instruction | `mobile/scripts/protect-dist.mjs`, run by the Android workflow before `cap sync`, and re-checked after it |

Everything else ships as built, on purpose:

| Where | Why not |
| --- | --- |
| `resources/app/frontend/dist/**` (the Command Center UI) | not one marker of the brain is in it — checked, not assumed (it is React UI, already minified). Obfuscating it bought nothing |
| `resources/app/src/**` (Electron `main.js`, `preload.cjs`, `server-env.cjs`) | plumbing: window, tray, permissions, yt-dlp copying. No brain text either |
| `node_modules` | third-party code; its licences require it to stay readable, and it isn't ours to relicense |

That split was not the first attempt. The first version rewrote the UI bundle and
the Electron shell too — and the packaged-app end-to-end test then timed out at
the Command Center's mic, a step that gives no diagnostics (the app runs, the log
is empty), on a build that otherwise behaved. Nothing about the UI was worth that
risk, so the rule this leaves behind is: **rewrite a tree only when it holds
something worth hiding *and* CI drives it end to end.** The E2E now also carries
the page's own console/exception lines and what was on screen into its failure
annotation, so the next such timeout says why.

## What it stops — and what it does not

It stops the cheap copies: someone who unzips the installer or unpacks the APK no
longer finds the agent's instruction, the script rules or the guide as text they
can read, copy into their own project and ship. Grepping a released build for
anything from this repository returns nothing.

It does **not** make the code impossible to steal, and nothing can. A person with
the app on their own machine can run it, watch what it does, attach a debugger,
dump the decoded strings from memory, feed it inputs and read the outputs, or
reimplement what they see. Anyone selling you "unbreakable" is selling something
else. What this buys is that copying the part that matters becomes a project with
a debugger and a deobfuscator instead of a right-click.

Two things matter just as much as the obfuscation:

1. **The repository stays private.** The published artifact is the only copy a
   customer gets; if the repo were public, this file would be pointless.
2. **Source maps and TypeScript types never ship.** They would hand the code
   straight back. The protector deletes any `.map`/`.ts`/`.d.ts` it finds in a
   protected tree, and the build check fails if one appears in either of them.

## The check that makes it stick

Phrases that must exist in the source and must *not* exist in anything shipped
are listed under `markers` in `code-protection.json` (the agent's instruction, the
phone-alone instruction, the script shape's own words, and the guide's alarms
text).

- `desktop/assemble.mjs` and `mobile/scripts/protect-dist.mjs` fail the build if
  a marker is still readable after protection.
- `node desktop/protect.mjs --sources` (part of every run) fails if a marker
  phrase no longer exists in the source file it names — otherwise a reworded
  instruction would leave the shipped app checked for something that moved, i.e.
  checked for nothing.
- The Android workflow greps the **final APK** for the instruction after signing,
  so "it's protected in `dist/` but not in the APK" can't happen quietly.
- `desktop/test/protect.test.mjs` proves the mechanics on fixtures: markers gone,
  `.map`/`.ts` deleted, ESM and CJS both still running, the marker list still
  matching the source, and the policy still guarding only the two brain-bearing
  trees.

Add a marker whenever new text becomes the reason people would copy the app: use
a phrase that appears in *code* (a string literal), not in a comment — comments
don't survive minification in the first place.

## Keeping it working

- **A new shipped tree needs a decision, not a habit.** If some future build step
  stages more JavaScript, ask two questions: does it hold the brain (a marker will
  say), and does CI drive it end to end? Only then protect it, and add a marker.
- **Never turn `asar` on.** The bundled server runs from real files (it chdirs and
  spawns ffmpeg/yt-dlp/whisper); with an archive, that server has to be loaded
  from inside it or the app breaks.
- **Debugging an obfuscated crash:** the shipped stack traces point at rewritten
  code. Reproduce on the same commit with the normal dev path (`npm run dev`,
  `npx tsx`), where nothing is obfuscated; the packaged app is built from the same
  source. Console errors and the chat's own honest messages are unchanged —
  user-facing text is a value, and values are preserved at runtime.
- **Licensing is untouched.** Obfuscation is not a licence, an EULA, or DRM. If
  the app is sold, the terms of sale and the copyright notices are what a takedown
  of a copied build rests on; this pass only makes the copy expensive.

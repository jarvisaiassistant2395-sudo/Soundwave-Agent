# Releasing Soundwave AI for Windows

How the sellable desktop app gets built, what customers see, and what it takes
to be fully "no warnings" on Windows.

## TL;DR

```bash
git tag v1.0.0
git push origin v1.0.0          # CI builds the Windows installers
gh run watch                    # or watch the Actions tab
gh run download -n soundwave-ai-windows -D dist/
```

**Test builds without releasing:** every push to a branch that changes the
app (`server/`, `frontend/`, `desktop/`, `scripts/assets/`, or the workflow)
runs the same build and attaches the installers to that Actions run as the
`soundwave-ai-windows` artifact — nothing is published. Only `v*` tags create
a GitHub Release.

CI (GitHub Actions, `windows-latest`) runs: typecheck + tests → frontend
build → downloads ffmpeg, the **nightly** yt-dlp and the **whisper.cpp speech
engine + English model** into `desktop/bin/` → checks every DLL the speech
engine needs ships with it (`desktop/check-dlls.mjs`) → assembles the app tree
→ **smoke-tests the real assembled app on Windows** (incl. transcribing a real
recording) → `electron-builder` → **verifies the packaged exe works as yt-dlp's
JavaScript runtime** (`desktop/verify-runtime.mjs`) → **end-to-end test of the
packaged app** (`desktop/e2e.mjs`: fake microphone → mic button and the
Ctrl+Shift+Space voice bar → transcription → agent reply; tray, close-to-tray,
preload bridge) → produces:

| Artifact | What it is |
| --- | --- |
| `SoundwaveAI-Setup-1.0.0.exe` | NSIS installer: Start Menu + desktop shortcut, per-user (no admin/UAC), uninstaller |
| `SoundwaveAI-Portable-1.0.0.exe` | Single portable exe — double-click, nothing to install |

The customer needs **nothing preinstalled**: no Node, no Python, no ffmpeg,
no terminal, no `.bat`, no Visual C++ redistributable. Node runtime (inside
Electron), ffmpeg, yt-dlp and the speech engine all ship in the package; first
run generates its own JWT secrets and uses `%APPDATA%\Soundwave AI\` for all
data.

## Voice input (whisper.cpp) in the desktop app

- **Local speech recognition.** `resources\bin\whisper\` holds whisper.cpp's
  official Windows build (pinned release + SHA-256 in the workflow; it picks
  the best CPU code path at runtime, AVX-512 down to plain x64), the Microsoft
  C++ runtime DLLs app-locally, and OpenAI's Whisper **base.en** model
  (5-bit, ~57 MB). Both whisper.cpp and the model are MIT licensed
  (`LICENSE-whisper.cpp.txt` ships next to the exe). Nothing is uploaded.
- **How it's used.** The server's `POST /api/v1/agent/transcribe` runs
  `whisper-cli` per voice command: model by file name from its own folder,
  audio on stdin, text on stdout — so non-ASCII Windows user names in the
  install path can't break it. `GET /api/v1/agent/transcribe/status` says
  whether it's available and why not.
- **Desktop shell.** Global shortcut (Ctrl+Shift+Space by default; Ctrl+Alt+Space
  or Alt+Space in Settings → Voice & Desktop) opens an always-on-top voice bar
  that never takes focus from the app you're in. The app keeps running in the
  tray when its window is closed, can start with Windows (`--hidden`, in the
  tray), and posts Windows notifications (attributed to the `appId`) when a
  short is ready or fails.
- **Dev machines:** put `whisper-cli` and a ggml model (e.g.
  `ggml-base.en-q5_1.bin`) in `vendor/whisper/`, or set `WHISPER_CLI_PATH` /
  `WHISPER_MODEL_PATH`.

## The phone companion (Android APK)

The desktop app (1.2.0+) has **Settings → Phone**, which opens a separate,
encrypted listener for the Soundwave phone app — off until the person turns it
on (`COMPANION=1` is set by `desktop/src/server-env.cjs`; hosted/web builds
never expose it). The smoke test and the packaged-app E2E turn it on, check it
answers on its own port (and that the app's API isn't reachable there), and
turn it off again.

The phone app itself is built by `.github/workflows/android-companion.yml`
(artifact `soundwave-companion-apk`) and tested on an Android 15 emulator
against the real server, set up like the desktop app (`DESKTOP_APP=1`) with a
stand-in Gemini (`desktop/test/fake-gemini.mjs --port 4100`, which also
stands in for Open-Meteo): without a key the agent tells the phone to add
one; after the key is saved through Settings → Brain's API, Gemini answers
the phone and runs a PC tool for it. Then the PC turns phone access off: the
app must switch to chatting on its own (it reaches the stand-ins at 10.0.2.2 —
the PC rewrites loopback service URLs in the brain kit to the address the
phone used), answer a message and run a briefing-only Morning Setup with the
weather, and — once phone access is back on — hand both to the PC's
conversation, labelled as answered on the phone.
Signing: add the repository secrets
`ANDROID_KEYSTORE_BASE64` / `ANDROID_KEYSTORE_PASSWORD` (/ `ANDROID_KEY_ALIAS`)
for a permanent key so updates install over each other; without them every
build is signed with a one-off key. Details and the keytool command:
[mobile/README.md](../mobile/README.md).

## The agent's brain (Gemini) in the desktop app

No Gemini key ships in the installer: each person pastes their own (free from
Google AI Studio) in **Settings → Brain** (1.3.0+); it's stored in
`%APPDATA%\Soundwave AI\data\brain.json`. `DESKTOP_APP=1` (set by
`desktop/src/server-env.cjs`) enables that settings page and the agent's PC
tools (open websites/apps, PC status); hosted builds use `GEMINI_API_KEY`.

CI never calls the real Gemini API: the smoke test and the packaged-app E2E
point the app at a fake Gemini on loopback (`GEMINI_API_BASE`,
`desktop/test/fake-gemini.mjs`). They save and test a key, chat through it,
run a real tool on the Windows runner (`get_pc_status`) and check the Start
menu app lookup. The request format is pinned in `server/tests/brain.test.ts`
(the same JSON the official `@google/genai` SDK sends).

1.4.0 adds the agent's memory (`%APPDATA%\Soundwave AI\data\agent-memory.json`),
the built-in guide (`soundwave_guide`), Morning Setup (`morning.json`; weather
from Open-Meteo — `OPEN_METEO_*_URL` point CI at the stand-in) and "Connect
YouTube account" (installed-app OAuth with PKCE; Google redirects to the app's
loopback address, caught at `/` by its one-time `state`). The smoke test and
the E2E check a memory note reaching Gemini, the Morning Setup briefing being
written from facts (weather included), the Memory tab and the YouTube tab.
Update the guide (`server/src/lib/brain/core/guide.ts`) whenever a screen
changes — `server/tests/memory_guide.test.ts` checks its key facts.

1.5.2 (phone 1.3.0) adds alarms on the phone: the agent's `set_phone_alarm`
tool (time HH:MM or in_seconds, label, briefing delay) leaves a control message
in the shared conversation, and the phone app runs it through its native
`Alarm` plugin — an AlarmManager alarm clock with its own alarm screen over the
lock screen (Snooze, Turn off), re-armed after a reboot — so it rings with the
PC off. Turning one off starts the morning briefing by itself after the user's
delay (Settings → "Alarm & the briefing", 0–600 s, default 30). Covered by
`server/tests/phone_alarm.test.ts`, `mobile/src/lib/alarm.test.ts`, the fake
Gemini's alarm branch and the phone E2E (sets one through the chat, checks
Android's own alarm list, rings a 20-second alarm, turns it off on its screen
and waits for the briefing to start talking). The ring plays on the connected
Bluetooth earbuds/headset when there are any — `AlarmAudio` picks the output
Android's own routing often ignores for alarms, lifts the alarm volume for the
ring and puts it back — and Settings → "Alarm & the briefing" plus the alarm
screen say where it rings.

1.5.1 (phone 1.2.1) makes the voice read every reply to the end: replies are
split into pieces at sentence boundaries and each piece is spoken, so a long
explanation (like the YouTube setup walkthrough) is never cut off part-way, and
a hiccup in one piece no longer stops the rest. It also sounds more natural at
no cost: the most natural Microsoft Edge voices (Ava/Andrew/Emma/Brian
Multilingual) are listed first in the Voice Library, sentences get a short pause
between them, and the narration cadence is slightly slower.

1.5.0 adds the daily briefing: topics researched with Gemini 2.5 Flash + Google
Search (free tier; the public feeds as backup), written when due, spoken when
an app opens. The smoke test, the packaged-app E2E and the phone E2E check it
against the stand-in (which answers `googleSearch` requests too). The phone app
(1.2.0) gained a native plugin (`EdgeTtsPlugin.java`, OkHttp) so it speaks the
Soundwave voices with the PC off — the phone E2E has it synthesize real speech
from Microsoft's service on the emulator.

## YouTube import (yt-dlp) in the desktop app

YouTube changes regularly break older yt-dlp builds (e.g. "The page needs to
be reloaded", Aug 2026), so the desktop app handles yt-dlp specially:

- **Self-updating copy.** yt-dlp runs from
  `%APPDATA%\Soundwave AI\bin\yt-dlp.exe`, copied from the installer on first
  run (and again when an app update ships a newer build). Each start, the
  server updates that copy to yt-dlp's **nightly** channel in the background
  (`YTDLP_AUTO_UPDATE=nightly`); imports wait for the update so none races the
  exe being replaced. Customers get YouTube fixes by restarting the app — no
  new release needed. Set `YTDLP_AUTO_UPDATE=off` (or `stable`) in the
  environment to change that.
- **Built-in JavaScript runtime.** yt-dlp needs Node 22+ or Deno to solve
  YouTube's JS challenges. The app hands yt-dlp its own exe with
  `ELECTRON_RUN_AS_NODE=1` (Electron then behaves as plain Node), after a
  startup probe that replays yt-dlp's exact commands; if that fails it falls
  back to a node/deno on PATH. **Keep Electron's RunAsNode fuse enabled** —
  CI's verify step fails the build otherwise.
- The server log shows both: `[yt-dlp] self-update: …` and
  `[yt-dlp] JavaScript runtime: this app running as Node v… (Electron …)`.

## Local build (any OS with network access)

```bash
cd server   && npm ci && npm run build
cd ../frontend && npm ci && npm run build
cd ../desktop && npm ci && node assemble.mjs && node smoke.mjs
npx electron-builder --win        # needs network: downloads Electron + NSIS tools
```

`node smoke.mjs` boots the assembled app exactly like the desktop shell does
and asserts health, SPA serving, history fallback, and API behavior.

## SmartScreen & code signing (read this before selling)

What this repo already guarantees (no extra action needed):

- **No `.bat` / PowerShell downloaders** anywhere in the customer path.
- **No console windows** (child processes spawn with `windowsHide`).
- **No admin/UAC prompt** (`requestedExecutionLevel: asInvoker`).
- **No runtime `npm install`** — binaries (incl. the speech model) are in the
  installer, fetched at build time. The one deliberate runtime download is yt-dlp updating its own
  copy in `%APPDATA%\Soundwave AI\bin\` (see above) — the same thing every
  yt-dlp front-end does, because YouTube breaks old versions within weeks.
- Proper exe metadata (product name, version, icon, company copyright).

What **no app can avoid without a certificate**: Windows SmartScreen shows
"Windows protected your PC" for **unsigned** executables, no matter the
stack (.NET, Electron, anything). Options, best first:

1. **Code-signing certificate (recommended for selling).** Buy an OV or EV
   code-signing cert from a public CA (DigiCert, Sectigo, SSL.com, Certum —
   ~$70–400/yr; EV used to be required for instant SmartScreen reputation,
   OV now accrues reputation after downloads). Export it as a `.pfx`, then:
   ```bash
   base64 -w0 your.pfx > pfx.b64          # or: certutil -encode your.pfx pfx.b64
   gh secret set CSC_LINK      --body "$(cat pfx.b64)"
   gh secret set CSC_KEY_PASSWORD --body "your-pfx-password"
   ```
   The next tagged build is signed automatically (electron-builder standard
   env vars) — installer and portable exe both.
2. **Microsoft Store** ($19 one-time dev account): Store-delivered apps are
   Microsoft-signed — zero SmartScreen prompts, no cert purchase.
3. **Unsigned**: buyers click "More info → Run anyway" once; SmartScreen
   reputation then accrues per-file.

Before selling, upload the final exe to https://www.virustotal.com once and
check for false positives — unsigned new files sometimes get heuristic flags
that vanish after signing.

## Versioning

Bump `desktop/package.json` → `version` (this drives artifact names), tag
`vX.Y.Z`, push the tag. Release notes are generated automatically.

# Soundwave AI

**An AI agent that writes, narrates and renders viral shorts.**

The app opens on the agent's **Command Center**. Press Generate — or tell the
agent "make a short about…" — and it writes the script, narrates it in a
**Soundwave voice** (Microsoft's neural voices via the free, key-less Edge TTS
service), burns word-by-word captions, and renders it over an Orbital NCG
gameplay video it hasn't used before. The agent is the only thing in the app
that makes videos; it also answers in the chat, out loud, in the same voice.

**Talk to it.** Tap the mic in the Command Center (or hold it to talk) — or,
in the desktop app, press **Ctrl+Shift+Space** from any app: a small voice bar
pops up above the taskbar, listens, and answers out loud. Speech is recognized
**on your PC** by [whisper.cpp](https://github.com/ggml-org/whisper.cpp) with a
bundled English model — no account, no API key, nothing uploaded. The desktop
app lives in the tray (closing the window keeps it running), can start with
Windows, and sends a Windows notification when a short is ready.

**From your phone.** The **Soundwave** Android app is the agent in your
pocket: type or talk, start shorts, watch them when they're done, run your
Morning Setup — the same conversation as the Command Center. It talks
straight to the PC over your Wi-Fi, end-to-end encrypted, while Soundwave AI
runs there (the tray counts) — and when the PC is off it **keeps chatting on
its own** with Gemini, the conversation and the agent's memory, then hands
everything back to the PC. Pair it once by scanning the QR code in
**Settings → Phone**.

**It remembers, and it knows its own app.** The agent keeps notes ("remember
that…"), a running summary of earlier conversations and the list of shorts
you made, so it picks up where you left off. Ask it how anything in Soundwave
works — linking YouTube, pairing the phone, Morning Setup — and it explains
step by step from the built-in guide, with the real button names.

**🌅 Morning Setup and the daily briefing.** Tell it what you want to hear
about every morning — anything: "the latest news about open-source, free AI
tools", "new trending GitHub repositories" (Settings → Morning Setup, or just
say it). The plan is saved in the agent's memory. When the briefing is due,
Gemini researches each topic (Google Search on Gemini 2.5 Flash — free with a
free key; GitHub, Hacker News and Google News as a backup) and writes the
briefing — weather, your shorts, your YouTube numbers, your topics, three
fresh short ideas — and **it starts talking when you open the app**. With the
PC off, the phone researches, writes and speaks it all by itself, in the same
Soundwave voice. The 🌅 chip runs it right away and also opens your morning
websites and apps on the PC.

---

## Get the app (Windows)

Soundwave AI ships as a **native desktop app** — no terminal, no `.bat`, no
Node/Python/FFmpeg to install:

- **`SoundwaveAI-Setup-*.exe`** — installer with Start Menu + desktop
  shortcut (double-click → install → launch).
- **`SoundwaveAI-Portable-*.exe`** — single-file app, nothing to install.

Both are built by CI from this repo (see [docs/RELEASING.md](docs/RELEASING.md)
— including the code-signing steps that remove the Windows SmartScreen
prompt). All your projects, uploads and settings live in
`%APPDATA%\Soundwave AI\`.

The installers also include the speech engine for voice input (whisper.cpp +
OpenAI's Whisper base.en model, ~60 MB, both MIT licensed) and the Microsoft
C++ runtime it needs, so voice input works on a fresh Windows install.

The app's YouTube import keeps working through YouTube changes: its yt-dlp
lives in `%APPDATA%\Soundwave AI\bin\` and updates itself to the latest
nightly build each time the app starts (just restart the app if an import
fails with a YouTube-side error), and it uses the app itself as the
JavaScript runtime yt-dlp needs — no Node or Deno install required.

## The agent's brain (Google Gemini)

The agent thinks with **Google Gemini**, using your own API key (free from
[Google AI Studio](https://aistudio.google.com/apikey)): paste it in
**Settings → Brain** (desktop 1.3.0+) and press *Save & test*. The key is
stored only on your PC (`%APPDATA%\Soundwave AI\data\brain.json`) and is
never sent back to the app's pages.

With a key, the agent talks for real (Command Center, voice bar and phone),
writes each short's script for its topic, and acts through real tools only —
it never claims something it didn't do:

| Tool | What it really does |
| --- | --- |
| `make_youtube_short` | starts a short (unused Orbital NCG background, Gemini-written script) |
| `get_short_progress`, `list_my_videos`, `show_video` | reads the real jobs; `show_video` puts the player in the chat |
| `get_pc_status` | live CPU load, memory, disk, uptime of this PC |
| `open_website` | opens an http(s) page in the default browser |
| `open_app` | opens an app from the Windows Start menu (`Get-StartApps`) |
| `run_morning_setup` | Morning Setup: opens the morning items (Settings → Morning Setup), researches the briefing topics and returns the facts for the briefing |
| `update_morning_briefing` | the daily briefing plan — topics (anything), time, automatic — saved in the agent's memory |
| `remember`, `forget` | the agent's notes (memory, shared with the phone; never keys or passwords) |
| `soundwave_guide` | the built-in user guide — every feature, exact steps and button names (`server/src/lib/brain/core/guide.ts`) |
| Google Search | live answers — only with a key that has billing (not on the free tier) |

Default model: **Gemini 3.8 Flash** (thinking level *low*, for snappy spoken
replies). If its free requests run out or it's overloaded, the agent retries
once with **Gemini 3.5 Flash-Lite** (its own free quota) — never after an
action already ran. Without a key the agent still makes shorts (with the
built-in scripts) and tells you how to add one. Servers can set
`GEMINI_API_KEY` / `GEMINI_MODEL` instead. Code: `server/src/lib/brain/` —
`core/` (the Gemini client, tool loop, instruction, guide, memory and Morning
Setup briefing) is plain TypeScript that the phone app compiles too.

**Daily briefing** (desktop 1.5.1 / phone 1.2.1): the plan (topics, time,
automatic) lives in the agent's memory. The PC writes the briefing when it's
due (`lib/briefing.ts`, catching up at start-up within 10 hours) and posts it
in the conversation marked with its day; the phone app and the Command Center
speak it the first time they're opened after that — once (`briefing.heard`).
Research: `server/src/lib/brain/core/research.ts` (shared with the phone).
With the PC off the phone does the same itself and speaks through the native
`EdgeTts` plugin (`mobile/android/.../EdgeTtsPlugin.java` — Microsoft's voices
need headers a WebView can't send).

**Alarms on the phone** (desktop 1.5.2 / phone 1.3.0): ask the agent for one
("set an alarm for 6:30", "wake me in 20 minutes") and it arms a real alarm on
the paired Android phone — `set_phone_alarm` leaves a control message in the
shared conversation, and the phone's native `Alarm` plugin puts it in Android's
alarm clock (its own alarm screen over the lock screen, Snooze and Turn off,
re-armed after a reboot), so it rings with the PC off. Turning one off starts
the morning briefing by itself after the seconds the user chose (phone app →
Settings → **Alarm & the briefing**, 0–600, default 30; the agent can give a
per-alarm delay too), which is also how the briefing starts when the phone is
all the user has. Alarms live in the phone app (1.3.0+) — the PC learns the
app's version when the phone connects, and if it's older it says to update
instead of claiming an alarm it can't set. The ring plays in the connected
Bluetooth earbuds/headset (Soundwave picks the output itself — Android often
sends alarm audio to the phone's speaker — and lifts the alarm volume for the
ring), with a switch in Settings → "Alarm & the briefing" to keep it on the
speaker; the screen says where it rings.

**Memory** (desktop 1.4.0+): `%APPDATA%\Soundwave AI\data\agent-memory.json`
— notes, Gemini's running summary of earlier conversations (written by the
lighter Flash-Lite model when the chat outgrows the 24 messages sent along,
and when you press Clear), and the last Morning Setup. Command Center → gear
→ **Memory** shows and edits it.

**Link YouTube** (desktop 1.4.0+): create a free OAuth client of type
**Desktop app** in Google Cloud (YouTube Data API v3 enabled, yourself as a
test user), paste its ID and secret in Command Center → gear → **YouTube API
& Shorts**, press **Connect YouTube account** and sign in with Google in your
browser — the app catches the loopback redirect (PKCE) and saves the refresh
token. Uploads from unaudited Google Cloud projects stay private until
YouTube's API audit; "Testing" consent screens expire the sign-in after 7 days
(publish the app to avoid it). The agent explains all of this on request.

## Get the phone app (Android)

CI builds **`SoundwaveCompanion-*.apk`** (the `soundwave-companion-apk`
artifact of the *Android Companion* workflow) and tests it on an Android 15
emulator against the real PC server. To use it:

1. Install the desktop app **1.5.0 or newer** on your PC (1.2.0+ works,
   without chatting while the PC is off or the daily briefing).
2. On the phone, open the APK and allow installing from that source
   (Android asks once). Android 7.0+. Test builds are signed with a new key
   each time: uninstall the previous app first, then pair again.
3. On the PC: **Settings → Phone → Let my phone connect** (Windows may ask to
   allow Soundwave AI on private networks — allow it).
4. In the app: **Scan QR code**. Done — the phone remembers the PC.

The phone uses the PC's brain: once a Gemini key is saved in **Settings →
Brain** on the PC, the agent answers the phone with Gemini too — nothing to
set up on the phone. Web pages and apps it opens appear on the PC.

**With the PC off** (phone app 1.1.0 + desktop 1.4.0): if **Settings → Phone
→ Chat from the phone when this PC is off** is on (default), the PC hands its
paired phones a copy of the Gemini key and the agent's memory over the
encrypted channel. When the PC can't be reached, the app answers with Gemini
directly — the same agent core, the conversation, the memory and the guide —
runs a briefing-only Morning Setup (weather from Open-Meteo) and transcribes
voice with Gemini. Everything said there (and notes saved) goes back into the
PC's conversation and memory when the phone reaches the PC again. Turning the
setting off makes phones delete the key the next time they connect.

The full agent (shorts, videos, PC actions, the Soundwave voices) needs
Soundwave AI running on the PC, with the phone on the same network (or on a
VPN such as Tailscale with the PC — the pairing code includes VPN addresses). See [mobile/README.md](mobile/README.md) for how
it works and how to build it.

---

## Architecture

| Layer | Stack |
| --- | --- |
| Frontend | React 18, TypeScript, Vite, Tailwind CSS, Framer Motion, Zustand, React Hook Form + Zod |
| Agent Engine | Python 3 Autonomous Shorts Creator, 2026 Viral Research Hooks, Reactive Soundwave HUD, Batch Automation |
| Voice input | Local speech-to-text: whisper.cpp (`whisper-cli`) + Whisper base.en, run per command by the server (`POST /api/v1/agent/transcribe`); the browser records 16 kHz WAV (AudioWorklet) and detects the end of speech itself |
| Voice | **Soundwave voices** = Microsoft neural voices (Edge TTS). A direct WebSocket client streams replies as they are synthesized (24 kHz mono MP3 + word timings); `node-edge-tts` is the backup engine. No robotic fallback voice: if the service is unreachable the app says why |
| Backend | Express 5 + TypeScript, PostgreSQL + Prisma (JSON-file store fallback), JWT sessions (httpOnly cookies + refresh rotation + CSRF), Stripe billing stubs, SSE export jobs |
| Media | FFmpeg (`libx264`/`libvpx-vp9`, `libass` subtitles + ASS watermark, volume/fades, media probing) |

```
soundwave-ai/
├── soundwave-agent/     # Autonomous Desktop Shorts Agent & 2026 Viral Engine
│   ├── viral_engine.py  # 7 High-performing niches & 6 viral hook frameworks
│   ├── short_runner.py  # 1-Click & batch vertical video pipeline orchestrator
│   ├── hud.py           # Futuristic acoustic visualizer HUD (no weird 3D avatar)
│   ├── main.py          # Unified CLI & GUI desktop launcher
│   └── plugins/         # Clean, modular plugin extensions
├── frontend/            # Vite + React SPA
│   ├── src/pages/       # AgentHub (Command Center), Dashboard, Projects, VoiceLibrary, ...
│   ├── src/components/  # ui/ primitives, layout/, agent/ (orb, short cards)
│   ├── src/lib/         # voices, agentShorts, api, format, …
│   └── src/store/       # Zustand: auth, toast
├── server/              # Express API
│   ├── src/routes/      # agent, auth, voices, tts, projects, upload, export, billing, ...
│   ├── src/lib/         # auth (JWT/bcrypt), edgeTts, store (Prisma/JSON), ffmpeg, ytdlp, plans, security
│   ├── prisma/schema.prisma
│   └── scripts/generate-samples.ts
├── deploy/              # Dockerfile.api, nginx.conf
├── voiceclone/          # optional OmniVoice voice-cloning sidecar (see its README)
├── docker-compose.yml
└── vendor/              # static ffmpeg (export) + yt-dlp zipapp (YouTube import); whisper/ (voice input, git-ignored)
```

---

## Quick start (development)

```bash
# 1. Backend
cd server
npm install
cp .env.example .env          # edit JWT_SECRET, APP_URL
npm run prisma:generate       # optional — used only with a Postgres DSN
npm run dev                   # http://localhost:4000

# 2. Frontend (separate terminal)
cd frontend
npm install
npm run dev                   # http://localhost:5173 (proxies /api → :4000)
```

Without `DATABASE_URL` (Postgres) the API transparently uses a JSON-file store
(`server/data/store.json`) so the full product works locally with zero infra.

> **One-click launchers:** `start_windows.bat` (Windows) and `start.sh`
> (macOS/Linux) do all of the above and open the Agent Hub. Before starting the
> servers they run `node scripts/ensure_node_deps.mjs server frontend`, which
> checks every package against `package-lock.json` and repairs the install, so
> an interrupted first `npm install` no longer shows up later in the browser as
> `Failed to resolve import "lucide-react"`. If you install by hand and hit that
> error, delete that folder's `node_modules` and run `npm install` again — a
> plain re-run cannot repair packages that were only half-extracted.

> **Windows:** the commands are the same in PowerShell or `cmd`. Install
> [Node.js 22+](https://nodejs.org) (yt-dlp needs Node 22+ to solve YouTube's
> JavaScript challenges), and for video export install FFmpeg once
> with `winget install ffmpeg` (then restart the terminal) or point
> `FFMPEG_PATH` at `ffmpeg.exe`. `start_windows.bat` downloads the standalone
> `yt-dlp.exe` into `vendor\yt-dlp\` and updates it to the latest nightly on
> every start — YouTube breaks older yt-dlp builds every few weeks. Without
> it, YouTube import needs Python 3
> ([python.org](https://www.python.org/downloads/) or `winget install
> Python.Python.3.12`) — the vendored `vendor/yt-dlp/yt-dlp` zipapp is
> launched through it automatically; `pip install yt-dlp` works too.
> Copy the env file with `copy .env.example .env` and fill in the two JWT
> secrets (any random strings in dev).

> **FFmpeg** is required only for *rendering shorts*. In dev, point `FFMPEG_PATH`
> at a static binary (e.g. `vendor/ffmpeg/ffmpeg`) or install ffmpeg. Note: the
> static build has no `drawtext` filter, so the export watermark is rendered
> through the `libass` filter (same path as subtitle burn-in).
>
> **YouTube import** (the agent's Orbital NCG backgrounds) uses
> [yt-dlp](https://github.com/yt-dlp/yt-dlp). A prebuilt zipapp lives in
> `vendor/yt-dlp/yt-dlp` and is auto-detected — it only needs `python3`. To
> override, install yt-dlp yourself (`pip install yt-dlp` / `brew install
> yt-dlp`) or point `YTDLP_PATH` at the binary. `YTDLP_COOKIES` accepts a
> cookies.txt export for bot/age-gated videos, and `YTDLP_MAX_DURATION`
> (seconds) caps the length of importable videos. The importer uses yt-dlp's
> own default player clients (retuned by its maintainers as YouTube changes)
> and, when YouTube rejects them — e.g. *"The page needs to be reloaded"* —
> retries with the `web_embedded`/`web_safari` clients and, if cookies are
> configured, once without cookies.
>
> **Voices** come from Microsoft's online Edge TTS service, so the agent needs
> the internet to talk. `cd server && npx tsx scripts/edge-tts-smoke.ts` checks
> every Soundwave voice against the live service (CI runs it on each desktop
> build).
>
> **Voice input** (the mic) needs a local speech engine: put `whisper-cli`
> ([build whisper.cpp](https://github.com/ggml-org/whisper.cpp#quick-start) or
> take its release binary) and a ggml model such as `ggml-base.en-q5_1.bin`
> (from huggingface.co/ggerganov/whisper.cpp) in `vendor/whisper/` — or point
> `WHISPER_CLI_PATH` / `WHISPER_MODEL_PATH` at them. Without it the mic says
> why it's unavailable; typing works as usual. The desktop app bundles both.

### Tests

```bash
cd server && npm test            # vitest: unit + API tests (STT_REAL_SAMPLE=…/jfk.wav adds a real whisper.cpp run)
cd desktop && npm test           # desktop shell helpers (node --test)
cd frontend && npm run typecheck # tsc --noEmit
cd frontend && npm run build     # production build
```

---

## API surface

| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| POST | `/api/v1/auth/signup` | — | creates user, sets session cookies |
| POST | `/api/v1/auth/signin` | — | JWT session + refresh rotation |
| POST | `/api/v1/auth/signout` | ✓ | revokes session |
| POST | `/api/v1/auth/refresh` | refresh cookie | rotates refresh token |
| GET | `/api/v1/auth/session` | ✓ | current user + quota |
| POST | `/api/v1/auth/forgot-password` | — | email (log transport in dev) |
| POST | `/api/v1/auth/reset-password` | — | tokenized reset |
| POST | `/api/v1/auth/verify-email` | — | tokenized verify |
| GET | `/api/v1/auth/oauth/google` | — | starts OAuth (302 to provider) |
| GET | `/api/v1/auth/oauth/:provider/callback` | — | OAuth callback → sets session |
| GET | `/api/v1/auth/sessions` | ✓ | list / revoke sessions |
| GET | `/api/v1/voices` | — | voice metadata + sample URLs |
| GET | `/voice-samples/:voiceId.mp3` | — | static sample audio |
| POST | `/api/v1/tts/synthesize` | ✓ | server-side synthesis (Microsoft Neural) → MP3 + word timings; enforces quota |
| POST | `/api/v1/tts/usage` | ✓ | quota accounting (offline-fallback synth) |
| GET/POST | `/api/v1/projects` | ✓ | cloud projects (Pro+ for save) |
| PATCH/DELETE | `/api/v1/projects/:id` | ✓ | update / soft-delete |
| POST | `/api/v1/upload/video\|audio\|avatar` | ✓ | magic-byte validated uploads |
| POST | `/api/v1/upload/youtube` | ✓ | import a background video straight from a YouTube URL (yt-dlp) |
| GET | `/api/v1/upload/file/:key` | ✓ | stream an imported/uploaded video (Range supported, for previews) |
| GET | `/api/v1/export/jobs/:id` | — | a short's render status (SSE stream at `/events`) |
| GET | `/api/v1/export/jobs/:id/download` | — | download a finished short |
| POST | `/api/v1/agent/generate-short` | — | 1-click viral short generation (script + voice + TikTok captions + an unused Orbital NCG video imported via the YouTube link importer) |
| GET | `/api/v1/agent/defaults` | — | default 9:16 vertical short configuration & presets |
| GET | `/api/v1/agent/status` | — | agent status, binary availability & Orbital NCG background counts |
| GET | `/api/v1/agent/orbital` | — | Orbital NCG background history: used videos, unused count, skipped videos |
| POST | `/api/v1/agent/orbital/refresh` | — | re-list the Orbital NCG channel (picks up new uploads) |
| POST | `/api/v1/agent/orbital/reset` | — | forget which Orbital NCG videos were used |
| GET | `/api/v1/agent/jobs` | — | the agent's shorts, newest first (`?status=COMPLETED&kind=short&limit=`) |
| GET | `/api/v1/agent/speak/stream` | — | the agent's reply as streamed MP3 in a Soundwave voice (`?text=&voice=`) |
| POST | `/api/v1/agent/speak` | — | same, as base64 JSON (used by the Python desktop runner) |
| GET | `/api/v1/agent/speak/status` | — | why the last reply couldn't be spoken (if it couldn't) |
| GET/POST | `/api/v1/companion…` | local app only | Settings → Phone (status, on/off, pairing code, paired phones) and the conversation shared with the phone (`/conversation`, `/conversation/clear`) — desktop app only (`COMPANION=1`) |
| POST | `/api/v1/agent/transcribe` | — | voice input: body = the recording (16 kHz mono WAV; other formats via ffmpeg) → `{ text, noSpeech, durationMs, elapsedMs, model }`, transcribed locally by whisper.cpp |
| GET | `/api/v1/agent/transcribe/status` | — | whether voice input is available here (and why not) |
| GET | `/api/v1/agent/niches` | — | 7 viral niches with hooks & sample scripts |
| POST | `/api/v1/agent/generate-script`| — | generate high-retention viral scripts on demand |
| GET | `/api/v1/ghost/macros` | — | list the built-in and custom Ghost Operator macros, plus what steps can really do (`capabilities`) |
| POST | `/api/v1/ghost/macros` | — | create/save a custom macro workflow |
| DELETE | `/api/v1/ghost/macros/:id` | — | remove a custom macro |
| POST | `/api/v1/ghost/decompose` | — | turn plain English into real steps (unbuildable ones come back as `unsupported` with the reason) |
| POST | `/api/v1/ghost/execute` | — | run a macro (`macroId`), a saved `workflow`, or an `instruction` — really: every step's output is what happened on this PC |
| POST | `/api/v1/creator/jump-cut` | — | auto-edit jump cut silence removal with FFmpeg |
| POST | `/api/v1/creator/screen-frame` | — | screen recording framing with rounded corners & shadow |
| GET/PATCH | `/api/v1/user/me` | ✓ | profile + password change |
| GET | `/api/v1/user/usage` | ✓ | quota snapshot |
| DELETE | `/api/v1/user/account` | ✓ | account deletion (30-day window) |
| GET | `/api/v1/user/export-data` | ✓ | GDPR data export |
| GET | `/api/v1/billing/plans` | — | plan definitions |
| GET | `/api/v1/billing/portal` | ✓ | Stripe customer portal (stub) |
| POST | `/api/v1/billing/checkout` | ✓ | Stripe checkout (stub) |
| GET/POST | `/api/v1/api-keys` | ✓ Ent | API key create/list |
| DELETE | `/api/v1/api-keys/:id` | ✓ Ent | revoke key |

State-changing requests require the `X-CSRF-Token` header matching the
`csrf_token` cookie. Rate limiting: 300 req/min general, stricter on auth/upload.

---

## Security model

- **Sessions**: short-lived access JWT + 30-day rotating refresh JWT in
  `httpOnly` + `SameSite=Lax` + `Secure` (prod) cookies. Refresh rotation
  invalidates the old token; replay detection via `sessionVersion`.
- **CSRF**: double-submit token cookie/header on all mutating routes.
- **Headers** (Helmet): HSTS, `X-Content-Type-Options`, `X-Frame-Options`,
  referrer policy, and a strict CSP — `script-src 'self'`, `connect-src
  'self'`, `media-src 'self' blob:` (speech is server-side and streamed from
  the app's own origin, so no model CDN, WebAssembly or data: audio is needed).
- **Passwords**: bcrypt (cost 12). Reset/verification tokens are SHA-256 hashed
  at rest, single-use, 1-hour TTL.
- **Uploads**: magic-byte validation, size caps, UUIDv7 file keys, extension
  allow-list, content served as `application/octet-stream`.
- **API keys**: SHA-256 hashed, `swa_live_…` prefix retained for display,
  shown in full only once.
- **TTS**: text is sent server-side to Microsoft's Edge TTS service for
  synthesis only and is never persisted; quota is enforced before synthesis.
- **Phone companion** (desktop app only): off until the person turns it on in
  Settings → Phone. It then opens a separate listener on the local network
  that answers only `hello`, `pair` and encrypted requests — the app's own API
  stays on 127.0.0.1. Pairing uses a one-time 12-character code (QR) from
  which both sides derive a key with PBKDF2-SHA256 (the code never crosses the
  network); the PC then gives the phone its own random 256-bit key. Every
  request/answer is AES-256-GCM with per-direction HKDF keys, timestamped and
  nonce-checked (no replays), and each answer is bound to its request. Phones
  can be removed on the PC at any time. The Settings API refuses other sites
  (Origin) and DNS rebinding (Host). Details: [mobile/README.md](mobile/README.md).

## Quotas & plans

| | Free | Pro | Enterprise |
| --- | --- | --- | --- |
| Characters / month | 10k | 200k | 2M |
| Max export | 720p · watermark | 1080p | 4K · no watermark |
| Cloud project save | Local only | ✓ | ✓ |
| API access | — | — | ✓ |
| Exports / hour | 2 | 20 | 100 |

---

## Production deployment

```bash
export JWT_SECRET="$(openssl rand -hex 32)"
docker compose up --build
```

- **API** auto-selects Prisma + Postgres when `DATABASE_URL` is set (see
  `server/prisma/schema.prisma`); otherwise the JSON store is used.
- Set `STRIPE_*`, `SMTP_*`, `GOOGLE_*` env vars to activate billing,
  email, and OAuth; without them the corresponding endpoints degrade gracefully
  (billing 501 / logged email / OAuth redirect to a "not configured" notice).
- Run `prisma migrate deploy` in CI before rolling out schema changes.

### Setting up OAuth sign-in

1. **Google** — [Google Cloud Console](https://console.cloud.google.com/apis/credentials) → *Create credentials → OAuth client ID* → Web application. Add authorized redirect URI `http://localhost:5173/api/v1/auth/oauth/google/callback`, then set `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`.
2. Restart the server. In production, use your `APP_URL` origin in the redirect URI.

Users are matched by email — an existing password account is linked to the
OAuth identity; new OAuth users are created email-verified with no password.

### Feature flags & graceful degradation

| Capability | Without infra | Behaviour |
| --- | --- | --- |
| Postgres | not installed | JSON-file store, identical API |
| Redis | not installed | in-process rate limiting |
| FFmpeg | not installed | shorts fail with a clear message; everything else works |
| SMTP | not configured | emails are logged to stdout |
| Stripe | not configured | billing returns 501 stubs |
| Edge TTS (Microsoft) | unreachable | the agent shows why it can't speak (no robotic stand-in voice); a short fails with a clear message instead of being narrated by another voice |
| Speech engine (whisper.cpp) | not in `vendor/whisper/` / `WHISPER_*` unset | `/agent/transcribe` answers 503 with the reason; the mic shows it; typing works |
| Voice cloning | `VOICECLONE_URL` unset or sidecar down | `/tts/clone*` answers with a clear error; the Soundwave voices are unaffected |
| Gemini (agent brain) | no key in Settings → Brain / `GEMINI_API_KEY` | the agent still makes shorts (built-in scripts) and finds videos; other chat answers explain how to add a key — nothing is made up |
| Memory | not the desktop app (`MEMORY=1` turns it on) | no notes/summary in the agent's instruction; hosted servers never keep a shared memory |
| Weather (Open-Meteo) | unreachable / no city | Morning Setup leaves the weather out and says why (`OPEN_METEO_GEOCODING_URL` / `OPEN_METEO_FORECAST_URL` point tests at a stand-in) |
| YouTube | not linked | Morning Setup skips the channel numbers; posting buttons ask you to link it (`GOOGLE_OAUTH_*_URL` / `YOUTUBE_API_BASE` point tests at stand-ins) |

### Voice cloning (OmniVoice)

An optional sidecar in [`voiceclone/`](voiceclone/README.md) runs
[OmniVoice](https://github.com/k2-fsa/OmniVoice) (zero-shot voice cloning,
600+ languages) next to the app. It is API-only (`/api/v1/tts/clone*`): the
app no longer has a voiceover page — the agent is the only thing that makes
videos, and it narrates with the Soundwave voices.

- **Multi-user safe.** Cloned voices are owned per-user by this API (reference
  clips under `<dataDir>/voice-clips/<userId>/`); the sidecar is stateless and
  only ever sees "one clip + one text" per request.
- **Runs anywhere.** Localhost next to the API, or free/always-on options —
  Hugging Face Space (free CPU), Oracle Cloud Always Free VM, or your home PC
  behind a free Cloudflare Tunnel. See
  [voiceclone/README.md](voiceclone/README.md#4-free-hosting-no-home-pc-required).
  Set `VOICECLONE_TOKEN` on both ends whenever it's not localhost.
- **Degrades gracefully.** Unset/offline sidecar → the clone endpoints say so.
- **Controllable cost.** Same character quota as neural voices, plus
  `VOICECLONE_MIN_PLAN` (default `FREE`) if you want to reserve cloning for
  paying tiers.

The Node API proxies it under `/api/v1/tts/clone*`: quota accounting and auth
are identical to `/tts/synthesize`. OmniVoice doesn't emit word timings, so
the API derives weighted per-word estimates from the text + audio duration,
which keeps subtitle auto-cueing working.

---

## Design system

Dark-only UI: background `#0A0F1C`, cards `#111827`, primary blue `#3B82F6`,
accent violet `#8B5CF6`, success `#10B981`, danger `#EF4444`, warning `#F59E0B`.
Radii 4/6/8, 4-px spacing grid, Inter/JetBrains Mono type scale, layered
shadows, visible `:focus-visible` rings, WCAG 2.1 AA contrast. Every text
container truncates or clamps; flex children carry `min-width:0`.

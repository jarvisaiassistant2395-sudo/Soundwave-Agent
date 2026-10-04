# Soundwave — the phone companion (Android)

Chat with the Soundwave agent running on your PC from your phone: type or
talk, start shorts, watch them when they're done, run your Morning Setup.
It's the **same conversation** as the desktop Command Center. The full agent
works while Soundwave AI is running on the PC (the tray counts); when the PC
is off, the app **keeps chatting on its own** with Gemini — the conversation,
the agent's memory and its user guide — and hands everything back to the PC
when it's reachable again.

- **Capacitor 8** Android app; the UI is React + Vite + Tailwind (`src/`).
- Talks **directly to the PC** over the local network — no cloud, no account.
- Voice: the phone records, the **PC transcribes** with its local whisper.cpp,
  and replies are read aloud in the agent's Soundwave voice (synthesized on
  the PC).
- Shares plain-TypeScript modules with the desktop frontend (chat messages,
  the voice recorder, the voice list) by relative import from `../frontend/src`,
  and the **agent core** with the PC server (`../server/src/lib/brain/core`:
  the Gemini client, the tool loop, the instruction, the Soundwave guide, the
  memory tools and the Morning Setup briefing) — so the phone's own brain is
  the same agent.

## Using it

1. PC: Soundwave AI **1.2.0+** → **Settings → Phone** → turn on **Let my phone
   connect**. (Windows may ask to allow Soundwave AI on private networks.)
2. Phone: install the APK, open **Soundwave**, tap **Scan QR code**.
   No camera? **Enter code instead** and type the PC address + code shown under
   the QR code.
3. Chat. Tap the mic to talk (it sends when you stop), or hold it and release.

Away from home: install a VPN such as Tailscale on both, then pair again — the
pairing code includes the PC's VPN address. You can also add addresses (a DNS
name, a VPN hostname) with `COMPANION_HOSTS` on the PC.

### The morning briefing (app 1.2.0 + Soundwave AI 1.5.0)

The plan (topics, time, automatic) comes with the memory snapshot. When the
app is opened (or comes to the front) after the briefing time and today's
briefing hasn't been heard on this phone or the PC, it starts by itself: with
the PC reachable it asks for the briefing the PC wrote when it was due (op
`briefing.today`, `prepare: true` makes the PC write it now); with the PC off
it researches the topics with Gemini (`server/src/lib/brain/core/research.ts`
— Google Search on Gemini 2.5 Flash, else GitHub / Hacker News / Google News
fetched natively through `CapacitorHttp`), writes the briefing and adds it to
the outbox. Then it reads the whole thing aloud — through the PC's voices, or
with the PC off through the native **EdgeTts** plugin
(`android/app/src/main/java/ai/soundwave/companion/EdgeTtsPlugin.java`, OkHttp
WebSocket to Microsoft's voice service with the headers a WebView can't send).
Capacitor lets audio play without a tap, so it really starts talking on open.
"Talk when I open the app" in the app's Settings turns it off on that phone.

### When the PC is off (app 1.1.0 + Soundwave AI 1.4.0)

With **Settings → Phone → Chat from the phone when this PC is off** on (the
default) and a Gemini key in Settings → Brain, the PC gives the phone its
**brain kit** (op `brain.kit`: the key, model, fallback model, thinking level,
Morning Setup's weather city) and a **memory snapshot** (notes, the summary of
earlier conversations, the latest shorts, YouTube link status — sent with
`sync` whenever it changes). Both are stored app-private; `clearAll` (unpair,
or the PC forgot this phone) deletes them, and turning the setting off makes
the phone delete the key on its next connection.

When the PC can't be reached, `src/lib/offline.ts` answers with Gemini
directly from the WebView (only `content-type` + `x-goog-api-key` headers —
what Google's CORS allows): the same instruction (told the PC is off), the
recent conversation, the memory, and the tools `soundwave_guide`, `remember`
and `forget`. Morning Setup gives a briefing only (Open-Meteo weather, the
last known shorts, ideas) and voice input is transcribed by Gemini. Shorts,
videos and PC actions wait for the PC; replies are read aloud by the phone itself (1.2.0+). Messages made there are
labelled `answeredBy: "phone"` and wait in an **outbox** (with memory
changes); right after reconnecting — before the first sync — the client sends
it with op `merge`, so the PC's conversation and memory get everything.

## How it connects (and why it's safe)

The PC side lives in `server/src/lib/companion/` (+ `routes/companion.ts` for
Settings → Phone). The phone side is `src/lib/protocol.ts` + `src/lib/client.ts`;
the server's tests run them against each other.

- **A separate listener, only when turned on.** Settings → Phone opens
  `0.0.0.0:47800` (next free port if taken). It answers three things:
  `GET /companion/v1/hello` (app, PC name/id, time — no secrets),
  `POST /companion/v1/pair` and `POST /companion/v1/rpc`. The app's own API
  stays on 127.0.0.1.
- **Pairing.** The PC shows a one-time code (12 Crockford-base32 characters,
  60 bits; valid 10 minutes, for one phone) in a QR code:
  `soundwave://pair?c=CODE&i=pcId&n=PC-name&p=port&h=addresses`. Both sides
  derive an AES-256 key from it with **PBKDF2-SHA256** (150 000 rounds, salted
  with the PC id). The code never crosses the network. The phone's pairing
  request and the PC's answer are sealed with that key; the answer gives the
  phone its own random **256-bit device key**.
- **Every request after that** is sealed with **AES-256-GCM** using
  per-direction keys derived from the device key (**HKDF-SHA256**):

  ```
  envelope  = 0x01 ‖ iv (12 random bytes) ‖ ciphertext ‖ tag (16)
  plaintext = u32be(len(header)) ‖ header (JSON: op, args, t, n) ‖ payload bytes
  AAD       = "sw1|rpc|c2s|<deviceId>"   /  answers: "sw1|rpc|s2c|<deviceId>|<request nonce>"
  ```

  Requests carry a timestamp (±5 min) and a random nonce; the PC refuses
  replays. Answers are bound to their request. Because the payloads are
  encrypted, the transport is plain HTTP on the LAN (hence
  `usesCleartextTraffic` and `allowMixedContent`).
- **Remove a phone** on the PC (Settings → Phone → Remove) and it's locked out
  immediately; the app says so and offers to pair again. "Unpair this phone"
  in the app does the same from the phone.
- The pairing key stays on the phone: app-private storage, no backups
  (`allowBackup="false"`, data-extraction rules exclude everything).

Operations the phone can run: `hello`, `sync` (long-poll: waits up to 20 s for
news; carries the memory snapshot when it changed), `send`, `transcribe`
(payload: 16 kHz WAV), `speak` (answer payload: MP3), `video.info` /
`video.read` (a finished short, 2 MB at a time), `morning` (Morning Setup on
the PC), `briefing.today` / `briefing.heard` (the daily briefing), `brain.kit`,
`merge` (what was said while the PC was off), `unpair`.

### The shared conversation

The Command Center keeps its conversation in the window's localStorage; the
PC server keeps a copy (`DATA_DIR/agent-conversation.json`) that the window
syncs with (`frontend/src/lib/conversationSync.ts`) and the phone reads and
writes. Messages are merged by id in time order. Outcomes of shorts
("Rendered viral short…") have fixed ids and are posted by the server itself,
so a short started from the phone is reported even with no desktop window
open. "Clear" in the Command Center starts a new conversation everywhere.

## Develop

```bash
cd mobile
npm install
npm run dev          # the app in a browser at http://localhost:5174 (Preferences → localStorage)
npm test             # vitest: protocol, parsing
npm run typecheck
```

Point it at a local server started with the companion on:

```bash
cd server
COMPANION=1 COMPANION_HOSTS=127.0.0.1 npm run dev
# then Settings → Phone in the desktop UI (http://localhost:5173/settings/phone) and "Enter code"
```

In a browser, `?pair=<url-encoded soundwave:// link>` pairs directly.

## Build the APK

CI does it (`.github/workflows/android-companion.yml`): typecheck + tests →
`vite build` → `cap sync android` → `./gradlew assembleRelease assembleDebug`
→ checks the signature/package/permissions → uploads
`SoundwaveCompanion-<version>.apk` → installs the debug build on an Android 15
emulator and drives it end to end against the real PC server
(`e2e/android-e2e.mjs`, screenshots in the `companion-e2e-screenshots`
artifact).

Locally (needs JDK 21 + the Android SDK):

```bash
cd mobile && npm run build && npx cap sync android
cd android && ./gradlew assembleDebug        # app/build/outputs/apk/debug/app-debug.apk
```

**Signing.** Release builds are signed with the keystore in `SW_KEYSTORE`
(+ `SW_KEYSTORE_PASSWORD`, `SW_KEY_ALIAS`, `SW_KEY_PASSWORD`). In CI, set the
repository secrets `ANDROID_KEYSTORE_BASE64` (base64 of a PKCS12/JKS keystore),
`ANDROID_KEYSTORE_PASSWORD` and optionally `ANDROID_KEY_ALIAS` so every build
uses the same key and updates install over each other:

```bash
keytool -genkeypair -keystore soundwave.p12 -storetype PKCS12 -alias soundwave \
  -keyalg RSA -keysize 3072 -validity 36500 -dname "CN=Soundwave AI"
base64 -w0 soundwave.p12    # → ANDROID_KEYSTORE_BASE64 (keep the .p12 and password safe)
```

Without those secrets each CI build signs with a one-off key (so a keystore
never sits in this public repo): uninstall the previous test build first.

**Version:** `package.json` → versionName; `1.2.3` → versionCode `10203`.

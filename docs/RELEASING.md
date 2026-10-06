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
app (`server/`, `frontend/`, `desktop/`, or the workflow)
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
stands in for Open-Meteo) and a stand-in voice
(`server/scripts/fake-edge-tts.ts --port 4200`, speaking Microsoft's own
WebSocket framing with real MP3 — `EDGE_TTS_WSS_URL` points the PC at it, and
the test writes the same URL in the app's own storage so the phone's native
voice goes there too; the *live* voice is checked non-blocking by the desktop
build): without a key the agent tells the phone to add
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

Shop setup (once): `docs/SET_UP_YOUTUBE_ONECLICK.md` is the click-by-click
guide for creating the one Desktop-app OAuth client the builds ship.

1.5.6 gives the agent eyes: `read_video` (a YouTube link → transcript, title,
channel, length; uploader subtitles or YouTube's automatic captions, and it says
which), `read_web_page` (a link → readable text; direct fetch first, the free
reader service `JINA_READER_URL` as fallback, login walls refused) and
`search_youtube` (titles/channels/lengths/view counts, no API key). Pure rules
in `brain/core/transcript.ts` — WebVTT → text with YouTube's rolling
auto-captions collapsed without ever dropping spoken words, HTML → text,
`capText` — and the fetching in `lib/eyes.ts` (SSRF guard: public http(s) only).
yt-dlp gains `fetchTranscript` (5-minute cache, `--write-subs --write-auto-subs
--write-info-json`, friendly "no captions" error, metadata fallback) and
`searchVideos`. Tools are desktop-only and injectable (`ctx.eyes`) so tests never
touch the network; `server/tests/eyes.test.ts` holds 22 (parsers, URL guard,
tools, and a real HTTP round trip through a stand-in reader). The E2E reads a
real TED talk and example.com each run and reports the result as an annotation
(informational — YouTube bot-checks make a real read a bad hard gate), and the
smoke test requires the three tools in the crafted tool list. Guide section
"reading" covers all of it, including the honest limits.

1.5.5 makes connecting YouTube comfortable: release builds ship Soundwave's
own Google OAuth client, so Settings → **YouTube & Shorts** → **Connect
YouTube** is one press and a Google sign-in — the customer never opens Google
Cloud. Create ONE **Desktop app** client for the shop and save it as the
repository secrets `SOUNDWAVE_YOUTUBE_CLIENT_ID` / `SOUNDWAVE_YOUTUBE_CLIENT_SECRET`;
the release workflow writes `desktop/config/youtube-client.json` (gitignored),
`assemble.mjs` stages it as `app/config/youtube-client.json`, and
`desktop/src/server-env.cjs` turns it into `SOUNDWAVE_YOUTUBE_CLIENT_*` for the
bundled server (it also reads `<userDataDir>/youtube-client.json` first — a
local copy for testing wins over the shipped one and survives app updates) (a variable already in the environment wins — handy for testing
against another client). `server/src/lib/youtube.ts` prefers the person's own
client when they pasted one, else the built-in one, and `connectionState()`
reports `needsReconnect` when a saved token was minted by a different client
instead of pretending to be connected. Builds without the secrets say so
honestly and show the short own-client path: one box that takes the downloaded
`client_secret_….json` or both values (`extractOAuthClient`), the three deep
links to Google's own pages, and a single Connect button that saves and
connects. Signing in still uses the installed-app loopback flow with PKCE;
`/api/v1/youtube/status` gained `oneClick`, `clientSource` and `needsReconnect`,
and `/api/v1/youtube/oauth-guide` is mode-aware (3 steps one-click / 4 steps
own-client). Covered by `server/tests/youtube_oneclick.test.ts` (7 tests) and
`desktop/test/youtube-client.test.cjs` (3), with the existing connect tests
unchanged.

1.5.4 adds watched channels: `watch_youtube_channel` (@handle or channel link),
`list_watched_channels` and `stop_watching_channel`, plus `lib/channelWatch.ts`
— a store in `channel-watches.json`, a check every 5 minutes while the server
runs (4-minute floor per channel, one newest-15 listing each), a queue of new
uploads that hands one video at a time to the clips pipeline while nothing else
renders (a busy machine just waits for the next tick; a failed video is retried
three times, then given up on out loud). Adding a watch remembers everything
already up — only new uploads are clipped — unless "clip the latest one too".
The pure rules (channel references, `planWatch`, status text) are in
`brain/core/watch.ts`, covered with the tools and a real tick in
`server/tests/channel_watch.test.ts` (15 tests: fake channel listings, fake
clips pipeline, busy/retry/broken-check paths).

1.5.3 adds shorts cut out of a long video: `make_shorts_from_video` takes a
YouTube link (downloaded with yt-dlp, like every import) or a file on the PC,
the agent listens to it (ffmpeg → 16 kHz PCM → the same whisper.cpp engine as
voice input), picks the moments worth posting (Gemini with a key — the windows
and their transcripts are sent; without one, the loudest talking wins), and
renders each as a vertical Short with the original audio and burned captions
(`lib/videoClips.ts`; the pure rules — window planning, scoring, pick parsing,
caption timing — are in `brain/core/clips.ts`, unit-tested in
`server/tests/clips.test.ts`). The tool's wiring (busy rules, honest refusals,
count limits) is pinned in `server/tests/clips_tool.test.ts`; the desktop E2E
builds a 13-second video from whisper.cpp's jfk.wav, asks the agent to cut a
clip out of it and plays the rendered MP4 in the chat.

1.5.2 (phone 1.3.0) added alarms on the phone: the agent's `set_phone_alarm`
tool (time HH:MM or in_seconds, label, briefing delay) leaves a control message
in the shared conversation, and the phone app runs it through its native
`Alarm` plugin — an AlarmManager alarm clock with its own alarm screen over the
lock screen (Snooze, Turn off), re-armed after a reboot — so it rings with the
PC off. Turning one off starts the morning briefing by itself after the user's
delay (Settings → "Alarm & the briefing", 0–600 s, default 30). Covered by
`server/tests/phone_alarm.test.ts`, `mobile/src/lib/alarm.test.ts`, the fake
Gemini's alarm branch and the phone E2E (sets one through the chat, checks
Android's own alarm list, rings a 20-second alarm, turns it off on its screen
and waits for the briefing to start talking).

1.3.3 also made the PC *say why* it can't write a briefing. In the same run the
phone was told "your PC has no briefing to read out yet" while the PC had a key,
a topic and a briefing written seconds later by its own scheduler — so the phone
could not tell "nothing to research here" from "still writing it". The listener
now answers `prepareRefused` ("no-key" / "no-topics" / "no-memory") when a
`prepare` produced nothing, the refusal is logged on the PC
(`[briefing] not writing today's briefing (phone asked): no-key`), and the phone
(a) keeps asking while the PC has neither handed one over nor named what is
missing — up to a minute, which is the scheduler-race window — and (b) when the
PC really can't, writes its own and names the missing piece in the message it
leaves behind ("Your PC couldn't write today's briefing (no Gemini key on the PC
yet), so it was researched and written on the phone."). One more server test in
`companion_brain.test.ts` pins the three answers.

1.3.3 (phone-only, with the PC's companion): the briefing after an alarm works
before the planned time, too. The emulator run caught the real case a person
would hit every morning: an alarm set for 06:30 with the briefing planned for
07:00. The PC refused to write one because 07:00 had not arrived (`briefing.today`
with `prepare` consulted the 10-hour window, like the automatic paths do), so the
phone was told the PC "has no briefing to read out yet" — and minutes later the
PC wrote it on its own schedule, far too late to be heard. Asking to prepare is
the person asking, so that path (like `/api/v1/morning/run` and the 🌅 chip) no
longer consults the window: the PC writes today's briefing when the phone asks,
even before the planned time, and still refuses without a key or without topics,
so no placeholder becomes "today's briefing". On the phone, two things: if the PC
answers that it is still writing, `deliverBriefing` waits and asks again (up to a
minute) instead of concluding it has nothing, and the failure sentence now says
what actually happened ("couldn't write today's briefing when this phone asked it
just now") rather than blaming a PC that may well have topics and a key. Pinned
by a test in `server/tests/companion_brain.test.ts` that plans the briefing for
later today and checks the automatic path hands nothing over while `prepare`
writes it anyway. The same run also taught the tool table a rule it already
followed elsewhere: `set_phone_alarm` needs the desktop app (that is where a
phone can be paired at all), so a hosted server no longer offers it.

1.3.2 (phone-only): the briefing after an alarm is never left unspoken. Turning
an alarm off is the user asking to be briefed, so when the PC hands over nothing
— no topics or no key there yet, its 10-hour morning window long past, or today's
briefing missing from the conversation it shares with the phone — the phone now
researches and writes the briefing itself through the same path it uses with the
PC off (`writeBriefingOnPhone` in `mobile/src/state/useCompanion.ts`) and speaks
it, instead of showing "today's briefing never came through". The bar says
"Researching on the phone" (it used to say "Your PC is off" even with the PC up),
and when even that isn't possible the error names the real reason (no topics or
no key on the PC, and no key of its own). The emulator E2E prints what the PC
and the phone each held whenever this step fails (`briefingDiagnosis` in
`mobile/e2e/android-e2e.mjs`) — the app's own sentence alone cannot say which
side came up empty, and once cost a run to interpret. Still unverified on a real
phone.

1.3.1 (phone-only): the ring in Bluetooth earbuds and a briefing that could
stay quiet. `AlarmAudio` now asks Android for the audio focus, sets the
preferred output before *and* after `prepare()`, and then verifies the sound
really started (a started player advances its position) — a phone that accepts
the earbud route and plays nothing gets the alarm on its own speaker, with the
alarm screen saying where it really rang (`AlarmActivity` re-reads it after the
service starts). On the app side, `lib/voice.ts` puts a watchdog on playback:
if the phone never starts making a sound (a dead route, a stuck player) the
briefing stops with an honest error instead of reading on in silence, one retry
covers a Bluetooth link that is still waking up, and a briefing the user asked
for (after an alarm, or "Hear today's briefing now") turns a *zero* media volume
up — the alarm raises the alarm stream, not the media one the voice plays on —
and puts the level back when it is done. The PC's voice service failing now
falls back to the phone's own Soundwave voice instead of skipping the speech.
The ring plays on the connected
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

1.5.7 protects the part of the code that is worth copying. The installer hands
the customer the whole server as real files (`asar: false`, because the bundled
server runs from those paths) and the APK hands over the phone page, which
compiles the shared agent core — the instruction, the short-script shape, the
guide, the plans. `desktop/assemble.mjs` rewrites the staged server and
`mobile/scripts/protect-dist.mjs` rewrites the app page (with
javascript-obfuscator: names → hex, every string literal → an encoded array,
comments dropped; the options live in `code-protection.json`), and both steps
**fail the build** if a phrase from that file is still readable, or if a
`.map`/`.ts` file appears in a shipped tree. The Android workflow also greps the
signed APK for the agent's instruction. The UI bundle and the Electron shell hold
none of that (checked, not assumed) and ship as built — the first attempt
obfuscated them too and the packaged-app E2E then timed out at the Command
Center's mic with nothing to read in the failure, so the rule is: protect a tree
only when it holds the brain *and* CI drives it end to end. That run also bought
the E2E its page-log/on-screen diagnostics. What this does and doesn't buy, and
how to add a marker or debug an obfuscated crash:
[PROTECTING_THE_CODE.md](PROTECTING_THE_CODE.md).

1.5.8 lets the agent change its own voice from chat and report on views. Two
new tools: `list_voices` (every name, which one is in use) and `set_voice`
("use Ava", "switch to Ryan") — the name is resolved against `lib/voices.ts`
(nickname, full id, an unambiguous partial name; anything else is refused by
listing the real names), and the choice is written into the shared conversation
(`setConversationVoice` now bumps the revision, so the desktop's long-poll
adopts it: `conversationSync` saves the voice into localStorage — the phone
already speaks with it, and the next short is narrated with it). `youtube_views`
reads each connected channel's numbers with that channel's own sign-in
(`lib/channelInsights.ts`: totals + latest uploads + deltas from
`data/youtube/view-history.json`), and words them through the pure helpers in
`brain/core/insights.ts`; Morning Setup uses the same per-channel numbers when
channels exist. The Command Center's sidebar gained a minimize button (a 4rem
icon rail, remembered in `soundwave_sidebar_collapsed`). Tests:
`server/tests/voice_choice.test.ts` (7, including "the server's voice list
equals the UI's" and a voice change waking the open window),
`server/tests/channel_insights.test.ts` (11, two channels on the fake Google, a
dead sign-in, deltas, and the wording), the guide checks in
`memory_guide.test.ts`, and the desktop E2E drives the minimize button (rail,
labels as tooltips, still minimized after a reload) and proves a voice set on
the PC's conversation reaches the open window.

1.3.4 (phone-only, with the PC's companion 1.6.4): an alarm-triggered briefing can fetch the brain
kit it needs. The Android run at c6e43ab failed the alarm stage one more time —
and this time the run said why: `prepareRefused: no-key` on the PC, with the
phone's diagnosis showing `own key false`, i.e. the phone held no kit (the shared
brain kit, which is where the phone's research key comes from). So after an alarm
the phone could neither get a briefing from the PC nor write one itself, and
reported failure — even though the PC it was talking to could have handed the kit
over. `deliverBriefing` now calls `ensureKit()` before writing its own briefing:
if the kit isn't in memory and the PC is reachable, it asks the PC for it
(`fetchKit`) and writes the briefing with it. The e2e's diagnosis also stopped
mislabeling that flag ("own key" → "kit from the PC") and now prints the PC's
brain state (key set / NO KEY, and whether it comes from the environment) — the
one line that would have explained this failure a run earlier.

1.6.8 (phone 1.3.7) is the build where the agent sends email — and sends it when
you said. Scheduled sends are what people asked for in those words ("send this to
that guy at 5 pm"), so the agent writes the message when it is asked and sends it
at five with no second confirmation: `server/src/lib/emailSchedule.ts` keeps the
draft with the time it is due, a one-minute ticker fires it through the same
`sendMessage`/`sendReply` path every other send uses — the send switch, the daily
cap and the duplicate rule are applied when the message actually goes out, not
when it was written — and a send more than six hours late is reported as *missed*
instead of arriving at midnight. An interrupted send is never repeated blindly:
the entry is marked `sending` before the network call and, if it is still marked
that ten minutes later, reported once with a pointer to Gmail's Sent folder.
Settings → Email lists what is waiting ("Waiting to go out", cancel button and
all) and what happened to the rest; the agent cancels one by id, exact subject, or
words you say in chat. It ships with the rest of the Google pass: `send_email`,
`send_reply`, `draft_email`, `find_contact`, `list_calendar`, `search_drive`,
`gmail_status` and the two schedule tools are real tools over the scopes the
consent screen granted (`gmail.readonly`, `gmail.compose`, `contacts.readonly`,
`calendar.readonly`, `drive.readonly`), and a tool whose scope nobody granted
answers `SCOPE_NOT_GRANTED` naming it instead of failing at the socket. Mail
content is treated as untrusted — a message in your inbox cannot make the agent
send anything — and addresses are never invented. Tests:
`server/tests/email.test.ts`, `email_schedule.test.ts` (12, including "nothing
sends early", the fire-time cap, and a slow Gmail overlapping the next tick) and
`workspace.test.ts`.

Clip hunting stopped being a coin toss. `server/src/lib/brain/core/clips.ts`
reads the audio before it chooses anything: a 100 ms RMS profile, the noise floor
as its 10th percentile, speech runs bridged across gaps up to 0.32 s with the
very short ones dropped, then a score over speech coverage, loudness, dynamics
and hook words. A clip is 12–59 s, candidates are at least 12 s apart, each
moment is snapped to the surrounding speech so a cut does not start mid-syllable,
and only the moments that survive are transcribed — eight at most — so the
sharper picks cost fewer Gemini calls than the old blind `-ss` slices did.

The trend scout reads popular Shorts for free (YouTube.js first, yt-dlp when
YouTube's own reader refuses; Gemini only if you press refresh and both fail) and
now stays out of the way of your voice: it waits until the app has been open two
minutes instead of twenty-five seconds, and it steps aside while the speech
engine has work — `sttBusy()` in `server/src/lib/stt.ts`, checked in the scan's
worker loop. That fix comes straight from a run of the packaged-app end-to-end
job, where a scan's yt-dlp timeouts on a two-core machine pushed a voice command
past the engine's 90-second limit.

The interface is black: a true-black page, near-black panels and a neutral grey
scale instead of navy, on the phone as well (`mobile/src/index.css`), and the
fonts the interface is drawn in now travel inside the install
(`frontend/src/fonts.css`, `assets/fonts/` → the install's `bin/fonts/`, notices
in `THIRD-PARTY-NOTICES.txt`) instead of being fetched from a font CDN at runtime
— an installer for an offline PC should look right on its first launch. The
profile banner in the bottom-left corner is real: the name and avatar open the
Profile page (name, avatar, plan, today's ideas) and the chevron opens Profile /
Plan & Billing / Settings / Sign out; in the collapsed rail the avatar itself is
the link. Voice setup looks after itself — `desktop/src/kokoro-manager.cjs`
starts the managed install 1.2 s after the window opens, on every launch — and
setup now ends by importing the whole service (`voiceclone/preflight.py`), so a
package the engine needs and the installer forgot (loguru was one) fails during
setup with a named step instead of after the first sentence you ask it to say.
Retries back off from 20 s to five minutes to half an hour, and Settings can
cancel or retry by hand.

1.6.7 and phone 1.3.6 were the theme-only builds from the UI pass; this build
carries that theme plus everything above.

1.6.6 stops spending Gemini quota on trends. The trend scout used to ask
Gemini + Google Search every three days; now `server/src/lib/shortsTrends.ts`
reads this week's popular Shorts straight from YouTube's search through
YouTube.js (MIT, no API key, no quota) — "#shorts", "viral shorts" and one query
per niche, both as under-3-minute videos and as Shorts, sorted by popularity —
and turns them into findings without a model: fastest climbers (views per hour
since upload), hook shapes that are landing (POV, questions, numbers…), rising
hashtags, topics across several channels, typical length. It runs twice a day
and works with no Gemini key. Gemini search is only a fallback when YouTube
can't be read *and* a person presses refresh; background refreshes never call
it. `.github/workflows/shorts-trends-smoke.yml` runs a real scan weekly and on
changes, because YouTube changes its layout now and then.

1.6.5 ships the font captions are drawn in. Every caption asked for "DejaVu
Sans" — a font Soundwave does not ship and Windows does not have — so libass
substituted whatever each machine happened to own: the same short looked
different on every PC, and the style's own weight (800) was written into the ASS
as Bold=0, so captions rendered regular. Now `assets/fonts/` carries Inter
(OFL-1.1, the same family the app's interface uses) and `server/src/lib/
captionFont.ts` hands libass both the family name and a `fontsdir=` on the
subtitles filter, so the font travels with the install and a machine that has
never heard of Inter still draws our captions.

Three things came out of doing it against a real ffmpeg rather than from memory,
and all three are why the test renders a frame:

- **The family name is the trap.** `Inter_800ExtraBold.ttf` declares its family
  as **"Inter ExtraBold"**, not "Inter". Asking libass for `Inter` with Bold=1
  picked the *Regular* cut when both were present, and picked *DejaVu* when only
  ExtraBold was — measured, both cases. So the constants sit beside the files
  they describe and `server/tests/caption_font.test.ts` reads libass' own
  `fontselect:` line out of a render: `(Inter ExtraBold, 700, 0) -> Inter-
  ExtraBold`. The test fails if the constant or the file ever drifts apart.
- **`fontsdir` works on this build** (ffmpeg 7.0.2, libass + fontconfig), and
  the font is loaded from the directory — no system install needed.
- **A missing font is not a crash.** With no fontdir the same ASS renders in
  DejaVu Sans Bold, which is what every build before this one did.

The watermark line uses the Regular cut. The "tiktok" preset's "Montserrat" —
also a font we don't ship — became our own. `desktop/assemble.mjs` and the
Windows build stage `assets/fonts` into `bin/fonts` and `server-env.cjs` points
`SOUNDWAVE_FONT_DIR` at it; the licence audit treats the font as a bundled
program and **refuses the build** if `bin/fonts` holds the font but not its
`OFL.txt` (verified by removing the file and watching it refuse). The Android
app already drew its interface in Inter, so a short now looks like the product
that made it.

**The briefing no longer waits for the phone to make up its mind (1.3.5).** The
phone's job with the PC away is to research and write the morning briefing with
the key it keeps from the PC. `deliverBriefing` only did that in the exact state
`offline`; any other state — `connecting` (knocking on the address it was paired
with) or `searching` (sweeping the known /24s when that address moved), both of
which can take seconds right after the app opens — fell through to a sentence
that blamed a missing key, and no briefing. A CI run showed exactly that: the
app force-stopped and reopened at the briefing time, the phone-mode banner on
screen (which only renders when the phone *holds* the key), and an error saying
it didn't. The rule is now "can this phone write it?" — true whenever it is not
forgotten and holds the key — so the app starts the briefing straight away
instead of waiting for a verdict it doesn't need; `ensureKit()` likewise asks
for the key in any state but `forgotten`. The failure sentence is built from
what was actually true (`mobile/src/lib/briefingSource.ts`, tested): a phone
holding the key is never told it has none, and a PC that never answered is
called unreachable rather than off.

**A failed briefing must not quote yesterday's reason.** The refusal note the
phone shows came from a `useRef` that nothing ever cleared, so a delivery that
failed late could be blamed on something the PC said an hour earlier — in the
alarm run it read "no Gemini key on the PC" while the PC had been given a key
before the alarm was even set, which is exactly the kind of sentence that sends
someone looking in the wrong place. Each attempt now starts with a clean slate
(`lastPrepareRefused.current = null`), the sentence is built from this attempt's
facts (`briefingFailureNote(..., { pcRefusedNote, hasKit })`, tested), and the
ingredients — state, kit, plan, what the PC refused — go to the console as one
`[briefing]` line, which the phone e2e keeps in its failure annotations.

**An informational stage may not abort the run.** The desktop e2e's eyes stage is
informational on purpose (YouTube bot-checks the CI runner), yet a Playwright
timeout there — `fill: Timeout 30000ms exceeded` for the Command Center's
message box — took the whole run down, so the acceptance-critical stages after it
(wake word, push-to-talk, tray, alarm) were skipped three runs in a row. The
stage now asks through one helper (`askAgent`) that, when the box isn't usable,
reports the truth about it — does it exist, is it visible, disabled, read-only,
what is on top of it, what is on screen — and a failure inside the stage is
recorded as a warning and the run continues.

**One microphone at a time.** The wake word ("Hey Soundwave", 1.6.0) put a
hidden window on the PC that listens and transcribes what it hears in the
background. That window and the person both want the same thing: this PC's
single whisper.cpp. Only the voice bar told the shell it was recording, so
talking into the **Command Center's own microphone** left the wake listener
listening too — two captures, one engine, and a recording that could fail or sit
behind a background check with nothing said about it. Now:

- `useVoiceCapture` (the Command Center's mic *and* the voice bar) reports its
  phase to the shell as source `mic`; the voice bar keeps reporting as `voice`.
  Two sources, two reasons in one pause set — neither cancels the other, and
  `mic` is cleared when the window goes away.
- The wake listener's requests are marked `?background=1`. The engine serves the
  person first: a background check is refused (429 `STT_BUSY`) the moment
  anything is queued, and the listener drops that utterance and checks the next
  one. It never sits *in front of* a person's recording, and it can never fill
  the queue. Its state line doesn't call that an error — being busy is the
  designed answer — and the interpreter treats a refusal as ordinary.
- A failed transcription is no longer silent: `useVoiceCapture` logs
  `[voice] transcription failed: …` and `[voice] nothing heard …` to the
  console, where a person (and a CI page log) can read it. The desktop e2e's mic
  stage retries once, *says* that it retried, and on failure reports the
  engine's own `lastError`/`lastTranscribedAt` from
  `/api/v1/agent/transcribe/status` instead of a bare timeout.

Server suite: `tests/stt.test.ts` proves the order — a slow stand-in whisper, a
person's request in the engine, a background request refused, the person's
request still answered, and the same background request served once the engine
is free.

1.6.4 gives the agent a second way to read a hard page: Scrapling on this PC.

`read_web_page` already fetched the page and pulled the article out locally
(Mozilla's Readability), but a page that answered that fetch with a bot check —
"are you a robot?" — or that only exists after JavaScript ran had exactly one
next step, and it was the reader service on the internet (r.jina.ai): the page's
address left the machine. The audit's whole point this round has been to cut
those paths, so this closes the biggest one left.

`scrapling/` is a small optional service (FastAPI) that fetches such a page
*here*, on this PC, using [Scrapling](https://github.com/D4Vinci/Scrapling)
(BSD-3-Clause): `curl_cffi` with a real browser's TLS/HTTP-2 fingerprint for the
fast path, and — only if the person installs it explicitly — a headless browser
for the hardest cases. It returns HTML and nothing else; the server's single
article extractor (Readability + Turndown) turns it into text, so a page read
through the sidecar is read by exactly the same code as a page fetched directly.
`server/src/lib/eyes.ts` tries it before the reader service and only when
`SCRAPLING_URL` is set (`via: "scrapling"` in the result); unset, Soundwave
behaves exactly as before. `server/tests/eyes.test.ts` proves the order with two
stand-ins: a walled page is read through the sidecar and the reader service is
never asked, a page the sidecar can't make an article of still falls through, and
an unset or unreachable sidecar changes nothing.

It is never bundled: the installer ships no Python (`electron-builder.yml` copies
`bin/` only), and `scripts/license-audit.mjs` records Scrapling, curl_cffi,
patchright, browserforge, msgspec, protego, apify-fingerprint-datapoints and
Camoufox (MPL-2.0 — run as a separate program, not modified, not linked, not
shipped) as NOT BUNDLED, the same rule the voice service has. Two things only
running it could teach, both now in the code: plain `scrapling` installs only the
parsers — its fetchers import playwright, so `requirements.txt` installs
`scrapling[fetchers]`; and importing `StealthyFetcher` succeeds with no browser
downloaded, so readiness is checked against the disk, not the import, and the
health endpoint says "no stealth browser is downloaded (run: python3 -m scrapling
install)" rather than "ready". It refuses `localhost`, private ranges and service
ports itself, so a URL can't be used to make it poke the machine's own services,
and it never follows a link or touches a login.

1.6.3 makes the channels people post to — and the channels they *watch* —
things you can see and press instead of sentences you have to remember.

**Watching creators** is a new card on the Command Center: paste a creator's
@handle and every watched channel gets a row saying how many shorts it cuts per
video, what it looks for, how many videos it has clipped, when it last checked
and — in amber — why the last check failed. Each row has three icon buttons:
the scissors (cut the newest video now, even though it was already up when the
watch started), a settings button (shorts per video, what to look for, saved in
place) and the bin (stop watching). The header's “i” explains the whole thing in
place. It is the same store, timer and render queue the agent's
`watch_youtube_channel` tool uses — `server/src/routes/watch.ts` (new) over
`lib/channelWatch.ts` (now with `watchViews`/`updateWatchById`/`removeWatchById`/
`clipLatestNow`) — so the card and the chat can never disagree. “Cut the newest
one now” answers honestly: it awaits the tick and says “next in line …” when
something else is already rendering rather than claiming it started.

**Connect another channel** is now a button. Once one channel was connected the
YouTube & Shorts tab only said “Linked to …”, and the only way to add a second
one was to know that signing in again does it — the exact thing the multi-channel
feature is for. The button says what the second sign-in means (each Google
account adds one channel with its own plan). The Channels card counts them
(“3 channels · 2 on autopilot”) and a channel that is off says what to do about
it instead of just “Off”.

Covered by `server/tests/watch_routes.test.ts` (8 tests: add, refuse, edit,
clear a focus, cut now — including the busy case — stop, hosted server) and a new
stage in `desktop/e2e.mjs` that checks the card is on the Command Center, that
the “i” explains the cadence, and that a handle which isn't a channel is refused
with the reason and changes nothing.

1.6.2 reads web pages here, the way Firefox's reader mode does. `read_web_page`
now runs Mozilla's Readability (Apache-2.0) over the fetched HTML and Turndown
(MIT) turns that article into markdown: headings, lists, quotes and links
survive, navigation, ads, footers and scripts do not. Both are pure JavaScript
in the bundled server (`server/src/lib/eyes.ts`, `articleMarkdown()`), so the
page never leaves the person's PC on this path — and jsdom is created without
`runScripts`, so parsing untrusted markup stays passive (content a page would
only have after running its scripts is provably not in the output; the tests pin
that). The reader service (`JINA_READER_URL`, r.jina.ai by default) is now only
the fallback for pages that hand back nothing usable — a JavaScript-only shell,
a wall — and pages behind a login are still refused rather than guessed at. A
page too short to be an article (a definition, a changelog entry) keeps the old
plain-text path, so nothing got worse for short pages. Four new tests in
`server/tests/eyes.test.ts` (30 in the file) cover the chrome-stripping, the
script rule, the size/parse refusals and link/image handling.

1.6.1 is voice, hands-free:

- **Push to talk** (`desktop/src/keywatch.cjs`, `desktop/src/wake.cjs`):
  `vkCodesFor()` maps an accelerator to Windows virtual keys (or says it can't),
  `keyWatchScript()` builds the PowerShell watcher that reports "ready"/"down"/
  "up" from `GetAsyncKeyState`, and `createKeyWatcher()` drives it: pre-warmed
  while the setting is on, restarted up to three times if it dies (and a death
  mid-hold ends the recording instead of holding forever), stopped with the app,
  and honest about why when it can't run at all. The overlay gained
  `hold-start`/`hold-end` commands: releasing with speech sends immediately, and
  releasing before you've said anything falls back to tap-to-talk rather than
  closing on nothing. A tap of the shortcut (or a machine where the watcher
  can't run) keeps the old press-to-start/press-to-send behaviour.
- **The wake word** ("Hey Soundwave"): a hidden window loads `/wake`
  (`frontend/src/pages/WakeListener.tsx`), which keeps the microphone open and
  cuts speech into utterances (`frontend/src/lib/wakeCapture.ts`, the same
  adaptive-floor approach as the recorder), transcribes each one locally through
  the existing `/api/v1/agent/transcribe` (whisper.cpp), and reports the text to
  the shell. `wakeHit()` in `desktop/src/wake.cjs` decides — a greeting plus the
  name, one word or two, and the words after it become the command; ordinary
  speech, including the app's own name in a sentence, never wakes it. The shell
  ignores wake hits while the bar is already open, pauses the listener whenever
  Soundwave records or speaks (and for 1.2 s after), shows the tray tooltip
  "say Hey Soundwave", and the Settings page polls the real state.
- Settings → Voice & Desktop gained both switches with honest state lines, the
  tray menu gained both, and `desktop/test/wake.test.cjs` (11 tests, run by
  `npm test` in the desktop package) pins the matcher's yes/no cases and the
  watcher's behaviour through a fake child process.
- The packaged end-to-end test drives it with real input, not simulated events:
  it watches the hidden listener for up to 90 s while the fake microphone talks
  (it has to transcribe locally and wake on none of it), a PowerShell helper
  holds Ctrl+Shift+Space with `keybd_event` so the watcher really sees the key
  state go down and up and the release sends, it flips the Settings switch off
  and on again (the microphone must actually be released and reopened), and
  finally it restarts the app with a recording of its own voice saying "Hey
  Soundwave. What can you do?" as the fake microphone — nobody touches anything
  and the agent has to answer by itself. If the online voice service is
  unreachable in a run, that last stage says so and skips instead of pretending.
- The agent's instruction tells it voice turns arrive as text and to answer like
  a person speaking; the guide's voice section covers the hold and the wake word
  and where hold-to-talk can't run.

1.6.0 is the "hands and eyes" release — four new abilities, all of them real,
all of them tested without a Windows machine in CI:

- `look_at_screen` (`lib/screen.ts`): the desktop shell gains
  `captureScreen()` (Electron `desktopCapturer`, the display the app window is
  on, long edge scaled to 1920 px, nothing written to disk) and the server sends
  that PNG to Gemini as `inlineData` with an instruction that forbids guessing
  and tells it to say when a word is too small to read. Without a Gemini key it
  says exactly that (`needsBrain`) instead of inventing an answer;
  `server/tests/screen.test.ts` pins the request shape, the fake-host capture,
  the blank/no-shell failures and every tool's answer (14 tests).
- `read_file` (`lib/files.ts`): text files come back whole (cut at 200 KB with
  `truncated` set, size and line count included), folders list with sizes and
  dates, binaries and >40 MB files are refused with the reason, and a missing
  path says there's no file at that path. `server/tests/files.test.ts` (10 tests).
- `set_volume` (`lib/pcControl.ts`): master volume and mute through Windows'
  own `IAudioEndpointVolume` (inline C# over PowerShell, no download). The
  script and the `"62|0"` report are pure functions
  (`volumeScript`/`parseVolumeReport`), the runner is injectable so CI on Linux
  drives the whole path, and **an unreadable report throws** instead of a
  made-up number. `server/tests/pcControl.test.ts` (11 tests).
- Timers and reminders (`lib/reminders.ts`, `brain/core/reminders.ts`):
  `parseWhen` is a pure parser ("in 10 minutes", "1h30", "half an hour", "in
  20", "at 17:30", "8pm", "tomorrow at 8", "tonight", "friday at 9") that
  refuses what it can't read; the store keeps `DATA_DIR/reminders.json`, rings
  each one exactly once (`firedAt` set and saved *before* announcing, so a
  throwing announcement can't double-ring), appends a `tag: "SYS"` message to
  the shared conversation so the phone sees it, and pops a Windows notification.
  `initReminders()` ticks every 20 s (unref'd) from `server/src/index.ts`.
  `server/tests/reminders.test.ts` (14 tests).
- The Command Center card for long videos → Shorts: `POST/GET /api/v1/clips`
  (`routes/clips.ts`) starts the same `startClipsJob` the agent's tool uses,
  with the honest 409 when one video is already being cut and the source's real
  error passed straight through; the card hides itself when `DESKTOP_APP` is
  off. `server/tests/clips_tool.test.ts` (route blocks) and the packaged E2E
  asserts the card and its controls exist on the Command Center.
- The chat guide's four "can't yet" lists are gone; what remains is what is
  still true (no emails or messages, no signing in, no clicking inside other
  apps, other PC settings than the volume). The macros section now says a
  *macro* can't contain a volume/screenshot step while the agent itself can.

1.5.9 is the minimal pass over the whole UI: the screens keep the information
and drop the prose. Buttons that had a caption now show the icon alone (download
the MP4, post to YouTube, open on YouTube, refresh, forget a note, export the
chat) — every one of them keeps its tooltip and its accessible name, so nothing
became unfindable; the checklists inside Settings, the generator modal and the
Command Center's cards lost their explanatory paragraphs to those tooltips, the
orb-state grid keeps the names and moves the descriptions into the title, and
system stats drop the two labelled bars that repeated the tiles. The niche
picker is the shape you asked for: one button per niche carrying only its title
and an "i" at the right end — the "i" grows that button and prints its
description underneath (`NicheButton` in `AgentHub.tsx`). The Voice Library's
"Agent's voice" badge no longer pushes itself out of the card (the badge row
wraps, and the badge says "In use"). E2E follows the two labels it clicked by
name: the chat placeholder is now `Message…` and the settings tab carries
`data-testid="youtube-tab"`. Two E2E lessons are enforced by checks instead of
by memory now: the sidebar rail is desktop-layout-only, so the E2E asks the
shell for a 1400×900 window and records the real page width instead of assuming
a screen size; and `server/tests/desktop_scripts.test.ts` reads
`e2e.mjs`/`smoke.mjs`/`verify-runtime.mjs` with the TypeScript compiler on every
build, failing on any name that doesn't exist in them (`node --check` sees
syntax, not a helper that was never written — "sleep is not defined" cost one
Windows run to find).

## Licences — the gate every build runs

Three things must be true of anything that ends up in the installer, and the
build checks all three from the real trees rather than from memory
(`scripts/license-audit.mjs`, run by both workflows):

1. **Nothing copyleft inside our code.** A library under GPL/AGPL/SSPL/BUSL
   would force Soundwave's own source open; a non-commercial licence (CC-BY-NC,
   CPML) cannot be sold at all. The audit fails the build on either, and prints
   every component it could not place against its known-permissive list so a new
   dependency can never slip in unnoticed.
2. **Bundled programs carry their paper.** `ffmpeg.exe` is a separate program
   (mere aggregation, so its GPLv3 does not touch our licence), but GPLv3 still
   requires its licence text and a written source offer to travel with it.
   `scripts/write-binary-licenses.mjs` writes `FFMPEG-LICENSE.txt` and
   `FFMPEG-SOURCE-OFFER.txt` into `desktop/bin/` — called by `assemble.mjs` on
   every packaging run — and the audit refuses a build where the binary is
   present without them. `desktop/bin/` is git-ignored, so these are build
   outputs, not files to keep in step by hand.
3. **The notices are generated, not written.** `THIRD-PARTY-NOTICES.txt` is
   regenerated by the desktop workflow (`--write`) and copied into the packaged
   app by `assemble.mjs`. Never edit it by hand; run
   `node scripts/license-audit.mjs --write`.

Locally: `node scripts/license-audit.mjs` (add `--write` to refresh the notices).
It needs `npm ci` to have run in the trees it audits; if `node_modules` is
missing it says so and audits the rest instead of pretending.

**Why this exists.** A licence review on 2026-10-04 found, in the shipped
product: two unlicensed MP3s staged into the installer for no purpose, an MIT
`LICENSE` file over `soundwave-agent/` that granted away the shorts engine, a
voice-cloning model whose *weights* are CC-BY-NC (OmniVoice) sitting behind paid
plan tiers, and ffmpeg shipping with no licence text. All four are fixed, and
items 1–3 above are the tripwire so none of them can come back. Two standing
rules came out of it: **never** ship model weights without checking the weights'
own licence (a permissive code licence says nothing about them), and **never**
bundle media without a licence file next to it. The specific traps that look
fine but are not: XTTS v2 (Coqui CPML), F5-TTS (CC-BY-NC-4.0), Higgs Audio
(non-commercial), Piper's current fork (GPL-3.0), Remotion (paid above three
employees), firecrawl (AGPL), Pixabay Music and the YouTube Audio Library (not
redistributable inside software).

## Versioning

Bump `desktop/package.json` → `version` (this drives artifact names), tag
`vX.Y.Z`, push the tag. Release notes are generated automatically.

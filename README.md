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
| `read_video` | reads a YouTube video's transcript (uploader subtitles, else auto captions) |
| `read_web_page` | fetches a page and returns the article as markdown, parsed on your PC (Firefox's reader mode; reader service only as fallback) |
| `search_youtube` | searches YouTube — titles, channels, lengths, view counts |
| `get_short_progress`, `list_my_videos`, `show_video` | reads the real jobs; `show_video` puts the player in the chat |
| `get_pc_status` | live CPU load, memory, disk, uptime of this PC |
| `open_website` | opens an http(s) page in the default browser |
| `open_app` | opens an app from the Windows Start menu (`Get-StartApps`) |
| `run_morning_setup` | Morning Setup: opens the morning items (Settings → Morning Setup), researches the briefing topics and returns the facts for the briefing |
| `update_morning_briefing` | the daily briefing plan — topics (anything), time, automatic — saved in the agent's memory |
| `remember`, `forget` | the agent's notes (memory, shared with the phone; never keys or passwords) |
| `list_voices`, `set_voice` | the Soundwave voices — list every name, switch the one the agent speaks and narrates with |
| `youtube_views` | how the person's videos are doing: per-channel totals, latest uploads, and what changed since the last look |
| `soundwave_guide` | the built-in user guide — every feature, exact steps and button names (`server/src/lib/brain/core/guide.ts`) |
| `list_emails`, `read_email`, `draft_email`, `draft_email_reply` | reads the connected mailbox and saves unsent drafts (id-and-body verified) |
| `send_email`, `send_reply` | sends what the person asked for — guarded by the switch, the daily cap and a no-duplicates rule (below). A time they named ("at 5 pm") goes in `when`, and the email is written now and sent then with no further confirmation |
| `list_scheduled_emails`, `cancel_scheduled_email` | what is waiting to go out (with the moment), and taking one back before it does |
| `find_contact`, `list_calendar`, `search_drive` | the rest of the Google account, read-only: a name → address, the next days of the calendar, a file on Drive |
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

**Local page reader** (optional, `scrapling/`): a page that answers Soundwave's
own fetch with a bot check ("are you a robot?"), or that only exists after
JavaScript runs, is fetched next by Scrapling (BSD-3-Clause) **on this PC** —
`./install.sh` in `scrapling/`, run the service, and set
`SCRAPLING_URL=http://127.0.0.1:8110`. The server keeps the single article
extractor, so a page read this way becomes text by exactly the same code as a
page read directly. Without it, hard pages fall back to the reader service
(r.jina.ai), which does send the page's address off the machine — the local
reader exists so that doesn't have to happen. It is never bundled with Soundwave
(the installer ships no Python), it fetches one page at a time, follows no links,
and refuses local and private addresses. The stealth browser for the hardest
pages is a separate, explicit download (`STEALTH=1 ./install.sh`) and the service
says so instead of claiming to be ready.

**The viral edit — popup photos, sound effects and a moving camera** (desktop
1.7.0): a short was gameplay, a voice and captions, and nothing ever *changed*
on screen. Now every short is planned frame by frame against the narration's
own sentences (`server/src/lib/brain/core/storyboard.ts` — the plan, pure and
shared; `brain/shortMedia.ts` — the part that touches the world): a **hook card**
lands in the first second with an impact, **photos pop in** on exactly the
sentence they illustrate (freely-licensed pictures from Wikimedia Commons, no
key, non-free licences refused, every photographer credited in the description —
`lib/photos.ts`), a **stat card** holds the number the sentence is about,
**sound effects** a riser in the first second, a whoosh on each cut, a ding under
the follow card — are *synthesized on this PC with FFmpeg* from recipes in
`lib/sfx.ts` (nothing licensed, nothing downloaded, cached under `DATA_DIR/sfx`),
a **percussion bed** runs under the voice and ducks while it speaks
(`sidechaincompress`), and the camera **punches in on each beat** instead of
showing a still frame (`lib/ffmpeg.ts` builds the whole graph; the ASS file
carries the cards on their own layer above the captions). Gemini plans it when
there is a key and the script plans it when there isn't; a plan is normalized
before it renders (timings snapped to sentences, photos capped at six, sounds
spaced, the follow card never covered), and every part of it can be switched off
in the generator's **Viral edit** switch or with `enhance: false` — which renders
exactly what earlier versions did. There is one `-filter_complex` graph and it is
readable as a string: `server/tests/short_render.test.ts` asserts the beats, the
mix and the camera move without running FFmpeg, then renders a real short and
probes the file it produced.

**Captions have a font** (desktop 1.6.5): shorts are rendered with the font
Soundwave ships — Inter (OFL-1.1, `assets/fonts/`), the same family the app's
interface uses — instead of asking ffmpeg for "DejaVu Sans" and letting each
machine substitute what it had. libass loads it from `bin/fonts` via `fontsdir`,
so a PC with no Inter installed still renders our captions, and the style's 800
weight is written into the ASS rather than dropped. The licence travels with it
and the audit refuses a bundle that drops it. Proof, not a promise: a test
renders a frame and reads libass' `fontselect:` line back out.

The phone's morning briefing got the same treatment: with the PC off, the phone
writes the briefing itself (that is the point of the key it keeps), and it now
does so whether the app has decided the PC is away yet or not — opening the app
at 06:30 used to fail if the phone was still trying to reach the PC, with a
message blaming a key the phone was holding.

The same release settles who the microphone belongs to. "Hey Soundwave" listens
in a hidden window; the Command Center's mic and the voice bar now tell the
desktop shell when they are recording, so the listener stays quiet instead of
transcribing the person twice — and its own checks are marked as background
work, which the speech engine refuses rather than queues whenever something you
asked for is using it. If a recording ever fails to transcribe, the reason is in
the log now, not just in a toast that disappears.

**Watched channels** (desktop 1.5.4): tell it "watch @MrBeast, 2 shorts each" and
that's it — the PC checks the channel every few minutes while Soundwave AI runs
and, the moment something new is up, announces it in the chat and cuts the
shorts out of it automatically (same pipeline as below). Only videos posted
after you asked (or "clip the latest one too"); up to 10 channels; three videos
per check at most, so a channel posting five videos doesn't swamp the PC; ask
"what channels are you watching?" or "stop watching @MrBeast" any time. It also
has a card of its own — **Watching creators** on the Command Center: paste a
@handle and every watched channel gets a row with the scissors (cut the newest
video now), the settings button (shorts per video, what to look for) and the bin
(stop watching), so none of it needs a sentence.
`lib/channelWatch.ts` + `brain/core/watch.ts` (pure rules: channel references,
new-upload planning, status text). It lives on the PC: a video posted while it
was off is picked up when it starts.

**Your voice, and how the videos are doing** (desktop 1.5.8): the agent speaks
with the Soundwave voices, and you can change the one it uses just by asking —
"use Ava", "switch to Ryan", "speak with Sonia" — or "which voices do you
have?" to hear the names. `list_voices` / `set_voice`
(`brain/tools.ts`, `lib/voices.ts`) match what a person says (a nickname, a full
id, a partial name when it's unambiguous), refuse a name that isn't real by
listing the ones that are, and the choice goes into the shared conversation — so
it sticks for spoken replies on the PC *and* the phone, and for the narration of
the shorts made from then on. Ask "how many views do my videos have?", "brief
me on the views" or "how is the last short doing?" and `youtube_views`
(`lib/channelInsights.ts`) reads each connected channel's real numbers from
YouTube with that channel's own sign-in: total views, subscribers, video count,
the latest uploads with each video's views — and, because every look is
remembered (`data/youtube/view-history.json`), what changed since last time
("+415 views since yesterday"). A channel that isn't connected, or whose
sign-in died, is named as such instead of showing a zero. The Command Center's
sidebar also has a **minimize** button (the small chevron at its top): it folds
to a 4rem rail of icons — same tabs, labels as tooltips — and remembers the
choice between restarts.

**Push to talk, and "Hey Soundwave"** (desktop 1.6.1): talk to it without
touching the app. *Hold* the shortcut — **Ctrl+Shift+Space** from any program —
and speak: the voice bar appears, listens for as long as you hold, and sends the
moment you let go (a quick tap still works the old way: it keeps listening and
sends when you pause). Electron only reports the press, never the release, so a
tiny Windows key watcher polls the OS for exactly your shortcut's keys — it runs
only between the press and the release, and where it can't run the app says so
and keeps press-to-start/press-to-send. *Say* **"Hey Soundwave"** and it answers
without a key at all: a hidden window keeps the microphone open, each burst of
speech is transcribed **on your PC** with the bundled whisper.cpp, and the shell
checks the transcript for the phrase (`desktop/src/wake.cjs`). Everything that
isn't the phrase is thrown away on the spot — no audio is written to disk, no
account, nothing uploaded — and it pauses itself while Soundwave is already
recording or speaking. Say just the phrase and the bar opens for the next
sentence; say it with the question ("Hey Soundwave, what's on my screen?") and
it answers straight away. Both switches live in Settings → Voice & Desktop and
in the tray menu, and the Settings line says honestly what it is doing
("Listening", "Paused", the last phrase it heard, or why it can't).

**Its hands and eyes on your PC** (desktop 1.6.0): the agent can finally look
and touch, for real, with the key you already have — no extra service. *Look at
the screen*: "what does this error say?", "what's on my screen?", "which button
do I press?" — the app photographs the screen it is on (`desktopCapturer`,
nothing written to disk) and Gemini reads that picture, answering exactly and
only from it and saying so when a word is too small to read instead of guessing
(`lib/screen.ts`, the new `look_at_screen` tool). *Read a file*: give a full
path — "what does C:\Users\me\notes.txt say?", "what's in my Downloads
folder?" — and it reads that file (or lists that folder) and answers from the
real contents; read-only, never searching your disk on its own, refusing
binaries and huge files by saying why (`lib/files.ts`, `read_file`). *The
sound*: "turn it down to 30%", "mute", "how loud is it?" — Windows' own CoreAudio
through PowerShell, and every change is read straight back so the number it
reports is the real one (`lib/pcControl.ts`, `set_volume`). *Timers and
reminders*: "remind me in 10 minutes to check the render", "at 17:30 tell me to
go", "tomorrow at 8am", "what's waiting?", "cancel the render one" — they ring
into the conversation (the phone sees it) with a Windows notification while
Soundwave runs, once each, never twice (`lib/reminders.ts` +
`brain/core/reminders.ts`, `set_reminder`/`list_reminders`/`cancel_reminder`).
And the long-video pipeline now has a face: the Command Center's left column
carries a **"Shorts from a video"** card — paste a YouTube link or a video file
path, pick how many, press the scissors — which starts the *same* job as the
chat's `make_shorts_from_video` (`POST /api/v1/clips`, one video at a time,
clips posted into the conversation). The guide's "can't yet" lists were rewritten
to the limits that are still true (no emails, no signing in, no clicking inside
other apps) instead of listing volume, screen and files.

**Minimal screens** (desktop 1.5.9): the same features with far less writing on
them. Actions with an unmistakable icon are icon-only, with the words kept as
the tooltip and the screen-reader name (`components/ui/IconButton.tsx`) —
download the MP4, post to YouTube, open it on YouTube, refresh, forget a note,
export the chat, test the voice. The Command Center's cards (System, Backgrounds,
YouTube, Latest short, Uptime) keep their numbers and drop their captions; the
chat header is two icons; the quick chips under the composer are two icons; the
orb states are names with the descriptions in the tooltip. Settings, the short
generator and the macros modal lost their paragraphs to one-line hints and
tooltips. The niche picker is one button per niche, title only, with an "i" at
the right end that grows the button to show the description underneath. In the
Voice Library the "In use" badge no longer overflows the card (the row wraps).

**The agent's eyes** (desktop 1.5.6): it can *read* what it is pointed at, with
no setup, no logins and no API keys. `read_video` takes a YouTube link and comes
back with the transcript (the uploader's subtitles, or YouTube's automatic
captions, and it says which) plus title, channel and length — so "summarize this
video" and "pull the five best hooks out of it" have something real to work
from. `read_web_page` fetches a page and pulls the article out of it *here*, with the
reader-mode machinery Firefox uses (Mozilla's Readability, Apache-2.0) and
Turndown (MIT) writing it as markdown — headings, lists, quotes and links kept,
navigation, ads and scripts dropped — for "summarize this article" or "give me
ten short ideas from this"; parsing untrusted HTML never runs its scripts. Only
when a page hands back nothing usable (a JavaScript-only shell, a wall) does the
free reader service come in (`JINA_READER_URL`, r.jina.ai by default, which
means that page's address goes to it), and pages behind a login or paywall are
refused rather than guessed at. `search_youtube` searches
YouTube (no API key) and answers with titles, channels, lengths and view counts
for niche research. All three run on the PC through the bundled yt-dlp and plain
HTTP; the pure parsing (rolling auto-captions, HTML → text, caps) lives in
`brain/core/transcript.ts` — with the article parser and the tools covered by
`server/tests/eyes.test.ts`,
including a real HTTP round trip through a stand-in reader. They deliberately
don't touch Twitter/Instagram/TikTok/Reddit: those need a logged-in session, and
the app doesn't ask for cookies or passwords.

**Shorts from a long video** (desktop 1.5.3): ask for it with a YouTube link or
a video file already on the PC — "cut the best bits out of this", "3 clips from
this video, the part about pricing". The agent downloads it (links), listens to
it with the same whisper.cpp engine voice input uses, picks the moments that
stand on their own, and renders each as a vertical Short: the video cropped to
9:16, the sound exactly as recorded, captions of what is said burned in.
`lib/videoClips.ts` + `brain/core/clips.ts` (pure rules: windows, scoring,
picking, caption timing).

**Chat & Files** (desktop 1.7.0): a tab of its own for documents rather than for
talking to the agent — drop in any file (or paste a screenshot) and ask about it.
What happens to the file is decided per file and always said on the chip under
the question:

- **read on this PC** — text, code, CSV, JSON, YAML, HTML, RTF, subtitles, Word,
  Excel, PowerPoint, EPUB, and PDFs with a text layer. No dependency and no
  Gemini quota: the PDF reader pulls the text out of the content streams itself
  (Flate, literal and hex strings, PDFDocEncoding and UTF-16) and the Office
  formats are read straight out of their ZIPs (`lib/docText.ts`, `lib/pdfText.ts`,
  `lib/zipText.ts` — pure, and unit-tested against real files built byte by byte
  in the tests);
- **sent to Gemini** — a photo, a recording, a video, a scanned PDF, or anything
  nothing here could read. Uploaded once to the Files API and referred to by URI
  afterwards, so asking again costs nothing extra (`lib/geminiFiles.ts`);
- **listened to on this PC** — a recording or video when there is no key: the
  first minute is transcribed locally, and the answer says it is partial.

A file that reached neither is named in the request, so the answer says it
cannot read that one rather than pretending the file was empty. Answers stream
in (`core/gemini.ts` gained `streamGenerateContent`, assembled back into the
ordinary response so the stored answer is identical to a non-streamed one) and
are written out with real formatting — headings at real sizes, bold, tables as
tables, code blocks with a Copy button — from a small Markdown parser of our own
(`frontend/src/lib/markdown.ts` + `components/gemini/Markdown.tsx`; no
`innerHTML`, links only ever http(s)/mailto, and a half-written answer renders
without a hiccup). **Many chats** are kept on this PC, each named after its first
question, renamed or deleted in place; pressing Stop keeps the part already
written. **Notebooks** hold sources (files or links — a link is read with the
same reader the agent uses) and notes (typed by hand, or pinned from an answer),
and every question asked inside one is answered against all of it.

**Where viewers actually were** (desktop 1.5.10): for a YouTube link the clipper
no longer judges a moment by how lively it sounds. It reads YouTube's own
most-replayed curve for that video (yt-dlp's `heatmap` — the seconds real
viewers rewound), the top comments that name a timecode ("2:14 had me
crying", weighted by likes), and what is getting views on Shorts this week
(the saved trend digest's real view counts). Those become an interest score per
moment (`brain/core/interest.ts`, pure and unit-tested), which decides who gets
listened to first (speech recognition is the slow part), which moments become
clips, and *how they are ordered* — the strongest clip is posted and played
first. Each clip carries the percentage and the sentence behind it in the chat
("Viewers replayed this part: 96% of the video's own peak (around 4:58)", "A
comment points here…"), and the clip itself begins at the measured moment
rather than at the start of the talking around it. A video YouTube has no data
for behaves exactly as it did before. One video renders at a time, shorts
included.

**Alarms on the phone** (desktop 1.5.2 / phone 1.3.2): ask the agent for one
("set an alarm for 6:30", "wake me in 20 minutes") and it arms a real alarm on
the paired Android phone — `set_phone_alarm` leaves a control message in the
shared conversation, and the phone's native `Alarm` plugin puts it in Android's
alarm clock (its own alarm screen over the lock screen, Snooze and Turn off,
re-armed after a reboot), so it rings with the PC off. Turning one off starts
the morning briefing by itself after the seconds the user chose (phone app →
Settings → **Alarm & the briefing**, 0–600, default 30; the agent can give a
per-alarm delay too), which is also how the briefing starts when the phone is
all the user has. If the PC has nothing ready for today, the phone writes that
briefing itself rather than staying silent with a reason. Alarms live in the phone app (1.3.0+; the earbud routing above is 1.3.1) — the PC learns the
app's version when the phone connects, and if it's older it says to update
instead of claiming an alarm it can't set. The ring plays in the connected
Bluetooth earbuds/headset (Soundwave picks the output itself — Android often
sends alarm audio to the phone's speaker — asks Android for the audio route and
then checks the sound really started: a phone that accepts the request and plays
nothing gets the alarm on its own speaker instead, with the alarm screen saying
where it really rang. The alarm volume is lifted for the ring, with a switch in
Settings → "Alarm & the briefing" to keep it on the speaker.)

**Memory** (desktop 1.4.0+): `%APPDATA%\Soundwave AI\data\agent-memory.json`
— notes, Gemini's running summary of earlier conversations (written by the
lighter Flash-Lite model when the chat outgrows the 24 messages sent along,
and when you press Clear), and the last Morning Setup. Command Center → gear
→ **Memory** shows and edits it.

**Connect YouTube** (desktop 1.5.5+): Command Center → gear → **YouTube &
Shorts** → **Connect YouTube** → sign in with Google. That is the whole
setup — one press, nothing to create in Google Cloud, because release builds
ship Soundwave's own Google client (the app catches the loopback redirect with
PKCE and saves the refresh token). Two repository secrets make it so for every
installer: create one **Desktop app** OAuth client for the shop, save it as
`SOUNDWAVE_YOUTUBE_CLIENT_ID` / `SOUNDWAVE_YOUTUBE_CLIENT_SECRET`, and the
release workflow bakes it into `app/config/youtube-client.json` (gitignored;
a packaged app also reads `<user data>/youtube-client.json` —
`%APPDATA%\Soundwave AI\youtube-client.json` — so a local copy wins over the
shipped one and survives updates;
`desktop/src/server-env.cjs` reads it — an already-set environment variable
wins, so a developer can point a build at a different client). Developer and
self-hosted builds without it say so honestly and fall back to the person's
own free OAuth client: three clicks in Google Cloud (the panel links to the
exact pages), set your Gmail as a test user or hit *Publish app*, download the
client JSON, paste it — one box takes the file's contents or both values — and
press Connect. Uploads from unaudited projects stay private until YouTube's
API audit, and "Testing" consent screens expire the sign-in after 7 days
(publish the app to avoid it). The agent explains all of this on request.

## Email, contacts, calendar and Drive (desktop)

One sign-in in **Settings → Email → Connect Google** covers the whole account:
Gmail (read, draft, send), contacts, Calendar and Drive. Gmail is the required
part; the other three are offered on Google's screen and can be refused — the
Email tab then shows them as not granted and the readers that need them simply
aren't offered to the model. Code: `server/src/lib/gmail.ts` (the connection,
MIME, recipients, the sending policy and the record of what was sent) and
`server/src/lib/googleWorkspace.ts` (People, Calendar and Drive, read-only).

Sending is a first-class capability, not a hidden one — **and it stays on the
person's leash**:

- it happens only when the person asks for it in their own words
  (`send_email` / `send_reply`); the instruction inside the model's prompt says
  so, and email content is marked untrusted everywhere, so a message asking the
  agent to send something is never a user instruction;
- **Settings → Email** carries the switch and the daily cap (on, 25/day by
  default). When either says no, the send is refused with the reason, and the
  agent saves a draft instead of retrying;
- addresses are never invented: what the person gave, or `find_contact`
  (`people:searchContacts`), and if that finds nothing the agent asks;
- the exact same message to the same person inside five minutes is refused
  (`DUPLICATE_SEND`) — models and retries double-send;
- a draft the agent saved can be sent later with "send it", but only while
  Gmail still has it exactly as it was (fingerprint checked), otherwise the
  review card is required;
- every send is recorded (`<dataDir>/gmail/sent.json`, hashed body, no plain
  text of the message) and listed in the Email tab with who, what and when —
  and it appears in the chat with the recipient and subject, so "sent" is never
  just a claim;
- drafting and sending share `POST /api/v1/email/drafts/:id/send`, which still
  demands a fresh reviewed fingerprint when the person presses Send themselves.

**"Send this to that guy at 5 pm."** A time makes it a *scheduled* email
(`when` on `send_email` / `send_reply` → `server/src/lib/emailSchedule.ts`,
queue in `<dataDir>/gmail/scheduled.json`):

- it is written and checked **when the person asks** — the address, the body and
  the moment are all validated there and then, so a mistake is answered while
  they are still in the conversation, not silently at 17:00;
- at that moment it goes out **by itself, with no confirmation** — asking twice
  is not what "send it at 5" means, and a scheduled email that waits for someone
  to be at the keyboard is not scheduled at all. The reply says exactly when it
  will go;
- **Settings → Email → “Waiting to go out”** shows every queued email with its
  moment, the full text and a Cancel that really cancels (`GET/DELETE
  /api/v1/email/scheduled`); the chat shows the same note for the message that
  created it;
- the same guards as an immediate send apply *at the moment it fires*: the
  sending switch, the daily cap, the address check and the no-duplicates rule
  all run through `gmailService.sendMessage`, so "sending is off" means a queued
  email does not slip out either — it is marked failed and the person is told
  why (a refusal is never retried forever; Google's own 5xx is retried twice
  with a backoff, then reported);
- it lives on this PC and the app must be running for the moment to be kept. A
  PC that was off sends at the next start **and says how late it was**; more
  than six hours late it is kept, marked *missed*, and **not** sent — a stale
  email arriving unannounced is worse than being asked;
- an interrupted send is reported, never repeated: the entry is marked *sending*
  durably before the network call, and a send the app died in the middle of is
  left for the person to check in Gmail's Sent folder rather than risking a
  second copy.

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
| Backend | Express 5 + TypeScript, PostgreSQL + Prisma (JSON-file store fallback), JWT sessions (httpOnly cookies + refresh rotation + CSRF), Stripe billing (Checkout + Billing Portal + signed webhooks), SSE export jobs |
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
├── voiceclone/          # Kokoro narrator + optional Chatterbox sidecar (see its README)
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
> **On Windows, check which ffmpeg you actually have.** `vendor/ffmpeg/ffmpeg`
> in this repository is a *Linux* build, so on Windows the app skips it and uses
> whatever `ffmpeg.exe` it finds next — `winget`/`chocolatey`/`scoop`, a copy in
> `Downloads`, or nothing. An old one is a quiet source of failures: some test
> fixtures and filters need a current build (`winget install Gyan.FFmpeg` gets
> the essentials build, 7.x). Set `FFMPEG_PATH` to pin it exactly, and run
> `ffmpeg -version` in the same shell you build from if something ffmpeg-shaped
> fails — every render failure now names the binary and its version it used.
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
| POST | `/api/v1/auth/google/start` | — | begins "Continue with Google" (URL + one-time `loginId`/`secret`) |
| GET | `/api/v1/auth/google/callback` | — | Google redirects the browser here; finds/creates the account |
| GET | `/api/v1/auth/google/wait` | — | the app polls whether Google has come back |
| POST | `/api/v1/auth/google/claim` | — | the app takes the session (sets its cookies) |
| POST | `/api/v1/auth/dev-session` | local app only | opens the app on a dev build with no Google app |
| POST | `/api/v1/auth/signout` | ✓ | revokes session |
| POST | `/api/v1/auth/refresh` | refresh cookie | rotates refresh token |
| GET | `/api/v1/auth/session` | ✓ | current user + plan |
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
| GET | `/api/v1/email/status` | local app only | Google connection, the permissions it has, the sending switch, calls left today |
| GET/PUT | `/api/v1/email/policy` | local app only | "let the agent send" + daily cap (1–200), with the last sends (`sent`), newest first |
| POST | `/api/v1/email/drafts/:id/send` | local app only | sends a draft with `confirmSend` + the reviewed `fingerprint` (a person's own action; not capped) |
| GET | `/api/v1/email/scheduled` | local app only | email waiting to go out (`scheduled`, with its moment, full text and how far off) and what recently happened to the finished ones (`history`) |
| DELETE | `/api/v1/email/scheduled/:id` | local app only | cancels a queued email — it will not be sent (404 when nothing matches) |
| GET | `/api/v1/user/me` | ✓ | profile |
| GET | `/api/v1/user/usage` | ✓ | quota snapshot |
| DELETE | `/api/v1/user/account` | ✓ | account deletion (30-day window) |
| GET | `/api/v1/user/export-data` | ✓ | GDPR data export |
| GET | `/api/v1/billing/plans` | — | plan definitions + whether billing works here |
| GET | `/api/v1/billing/status` | ✓ | this account’s plan and its subscription |
| POST | `/api/v1/billing/create-checkout` | ✓ | Stripe Checkout session → `{ url }` to open in a browser |
| POST | `/api/v1/billing/create-portal` | ✓ | Stripe Billing Portal → `{ url }` (change card, cancel) |
| POST | `/api/v1/billing/reconcile` | ✓ | ask Stripe what this account has paid for and apply it |
| GET | `/api/v1/billing/invoices` | ✓ | receipts (Stripe’s, with PDFs; the stored record otherwise) |
| POST | `/api/v1/billing/webhook` | signature | signed Stripe events set the plan |
| POST | `/api/v1/billing/apply-plan` | ✓ | development only: switch a plan without paying |
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

- **The part worth copying isn't readable.** The installer keeps the server and
  the APK keeps the phone page as real files, so both are rewritten (names,
  string literals moved into an encoded array, comments gone) before they are
  ever packed — and the build fails if the agent's instruction, the script rules
  or the guide still read anywhere in the shipped tree or in the signed APK. The
  UI bundle and the Electron shell carry none of that and ship as built. It stops
  the cheap copies; it doesn't pretend code can't be recovered by someone with
  the app and enough patience — see
  [docs/PROTECTING_THE_CODE.md](docs/PROTECTING_THE_CODE.md).

## Quotas & plans

| | Free | Pro | Enterprise |
| --- | --- | --- | --- |
| Price | $0 | $15/mo ($12/mo billed yearly) | $39/mo |
| Video processed / month | 60 min | 300 min | 1,200 min |
| Clips / month | 30, kept 7 days | Unlimited | Unlimited |
| Max export | 720p · watermark | 1080p | 4K · no watermark |
| Cloud project save | Local only | ✓ | ✓ |
| API access | — | — | ✓ |
| Exports / hour | 2 | 20 | 100 |

There is also a **Founder lifetime** — one payment of $199, everything
Enterprise gives, capped at the first 100 buyers. It is only possible because a
user's marginal cost here is their own Gemini key and their own CPU, which is
the one business model a cloud clipper cannot copy. Subscribers who bought
before the October 2026 repricing keep the price they signed up at.

The character limits are still there, but as the fair-use guard they always
were (`server/src/lib/metering.ts`), not as the thing being sold.

The Windows app is built in two editions from one tree (see
`docs/RELEASING.md`): the sold **Soundwave AI**, and **Soundwave AI — Dev**, the
owner's own build — no payments in it, everything unlocked, its own appId and
data folder so both can be installed side by side. The difference is one value
(`SOUNDWAVE_EDITION`), which the desktop shell passes to the API.

---

## Production deployment

```bash
export JWT_SECRET="$(openssl rand -hex 32)"
docker compose up --build
```

- **API** auto-selects Prisma + Postgres when `DATABASE_URL` is set (see
  `server/prisma/schema.prisma`); otherwise the JSON store is used.
- Set `STRIPE_*` and the Google client env vars to activate billing and
  sign-in; without them the app degrades honestly (Billing says it isn't
  configured and switches the plan locally, and the first screen explains what
  the build is missing).
- Run `prisma migrate deploy` in CI before rolling out schema changes.

### Setting up Google sign-in

Soundwave has one account: the Google account it is linked to when the app is
first opened. There are no passwords — no sign-up form, no reset email, nothing
to verify.

1. **Google** — [Google Cloud Console](https://console.cloud.google.com/apis/credentials) → *Create credentials → OAuth client ID* → **Desktop app**
   (the sign-in runs the installed-app loopback flow, so no redirect URI has to
   be registered — any `http://127.0.0.1:<port>` is allowed). Ship its Client ID
   and secret as `SOUNDWAVE_YOUTUBE_CLIENT_ID` / `SOUNDWAVE_YOUTUBE_CLIENT_SECRET`
   (the same client the YouTube features use); a person can also paste their own
   client in Settings → YouTube & Shorts.
2. Restart the server. The first launch shows one button — "Continue with Google".
3. On a development build with no client configured, `POST /api/v1/auth/dev-session`
   opens the app locally (it answers 404 on a packaged build, and it never
   answers when a Google client is present).

The sign-in asks only for identity (`openid email profile`); YouTube, Drive or
Gmail permissions are separate grants, asked for when that feature is first used.
Sessions on the person's own PC are permanent — signing out is a deliberate act,
not an expiry.

### Setting up billing (Stripe)

Plans are Stripe subscriptions. Paying happens in the person's own browser —
Stripe Checkout for upgrading, the Billing Portal for changing a card or
cancelling — so no card details ever reach this app.

1. In the Stripe dashboard, create **four recurring prices**: Pro monthly, Pro
   annual, Enterprise monthly, Enterprise annual.
2. Set `STRIPE_SECRET_KEY` and the four `STRIPE_PRICE_*` ids (see
   `server/.env.example`). A plan with no price id is simply not offered.
3. Webhooks (a hosted deployment): add an endpoint for
   `checkout.session.completed`, `customer.subscription.*` and `invoice.*`
   pointing at `https://your-host/api/v1/billing/webhook`, then set
   `STRIPE_WEBHOOK_SECRET`. Locally: `stripe listen --forward-to
   http://127.0.0.1:4000/api/v1/billing/webhook`.
4. Restart the server. Settings → Billing shows the plans and opens Checkout.

Two paths keep the plan in step, on purpose: the signed webhook (instant) **and**
`POST /billing/reconcile`, which asks Stripe about this account's customer. The
second one is what makes the desktop app work — a PC at home has no public
address for Stripe to call, so the app asks instead (when someone comes back
from Checkout, opens Billing, or while the payment page is open). Without any
Stripe keys, Billing says so plainly and its buttons switch the plan locally.

### Feature flags & graceful degradation

| Capability | Without infra | Behaviour |
| --- | --- | --- |
| Postgres | not installed | JSON-file store, identical API |
| Redis | not installed | in-process rate limiting |
| FFmpeg | not installed | shorts fail with a clear message; everything else works |
| SMTP | not configured | emails are logged to stdout |
| Stripe | not configured | Billing says so and the plan switches locally (development) |
| Edge TTS (Microsoft) | unreachable | the agent shows why it can't speak (no robotic stand-in voice); a short fails with a clear message instead of being narrated by another voice |
| Speech engine (whisper.cpp) | not in `vendor/whisper/` / `WHISPER_*` unset | `/agent/transcribe` answers 503 with the reason; the mic shows it; typing works |
| Voice cloning | `VOICECLONE_URL` unset or sidecar down | `/tts/clone*` answers with a clear error; the Soundwave voices are unaffected |
| Kokoro narration | on packaged Windows desktop, setup runs automatically; elsewhere, `LOCAL_VOICE_URL` unset or sidecar down | Kokoro choices stay unavailable; Soundwave voices continue to work, and an explicitly chosen Kokoro voice never silently changes |
| Gemini (agent brain) | no key in Settings → Brain / `GEMINI_API_KEY` | the agent still makes shorts (built-in scripts) and finds videos; other chat answers explain how to add a key — nothing is made up |
| Memory | not the desktop app (`MEMORY=1` turns it on) | no notes/summary in the agent's instruction; hosted servers never keep a shared memory |
| Weather (Open-Meteo) | unreachable / no city | Morning Setup leaves the weather out and says why (`OPEN_METEO_GEOCODING_URL` / `OPEN_METEO_FORECAST_URL` point tests at a stand-in) |
| YouTube | not linked | Morning Setup skips the channel numbers; posting buttons ask you to link it (`GOOGLE_OAUTH_*_URL` / `YOUTUBE_API_BASE` point tests at stand-ins) |
| Trends (free scout) | YouTube and the Google Trends feed unreachable | the digest keeps the last good findings and says why it couldn't look (the Shorts readers have test seams; `GOOGLE_TRENDS_FEED_URL` points tests at a stand-in) |
| Google account (email) | not connected | the email tools aren't offered to the model; `gmail_status` says to connect in Settings → Email (`GMAIL_API_BASE` / `PEOPLE_API_BASE` / `CALENDAR_API_BASE` / `DRIVE_API_BASE` point tests at stand-ins) |
| Google sending | switch off / daily cap reached | the send is refused with the reason, the agent saves a draft instead and says where the setting is |
| Contacts, Calendar, Drive | that permission not granted | the reader says so and the tool isn't offered; Gmail itself keeps working (a token refresh picks up a permission granted later, no reconnect needed) |

### On-device narration (Kokoro)

On the packaged **Windows x64 desktop app**, Kokoro sets itself up automatically
on first launch: a checksum-verified Python runtime, CPU-only PyTorch, the
speech engine, pronunciation assets, the model and **all 28 advertised voice
packs** are cached in per-user app data. It starts as a hidden background
service whenever Soundwave runs and stops when the app exits. No terminal,
manual environment setup or Chatterbox install is required; first setup needs
internet and enough free disk space; after setup, later starts load from the
verified cache offline and narration runs locally.
The Voice Library and Settings report runtime, package and model/asset progress,
and let you cancel without affecting Soundwave's voices. If setup is cancelled
or fails, choose **Retry setup** in the same session: completed verified files
are reused, incomplete downloads are cleaned up, and network/disk blockers are
called out. Later starts are silent once setup succeeds. CI can disable first-run
setup with `SOUNDWAVE_DISABLE_KOKORO_AUTO_SETUP=1`.

Standalone Node servers, development builds and non-Windows installs still use
the optional service instructions in [`voiceclone/README.md`](voiceclone/README.md)
and `LOCAL_VOICE_URL`.

### Voice cloning (Chatterbox)

The optional full sidecar in [`voiceclone/`](voiceclone/README.md) runs
[Chatterbox](https://github.com/resemble-ai/chatterbox) (Resemble AI's zero-shot
voice cloning) for the API-only `/api/v1/tts/clone*` endpoints. The agent uses
the selected Soundwave or Kokoro voice to narrate shorts.

**Why Chatterbox:** its license is MIT for the code *and the pre-trained
weights*, so cloned voices can lawfully be offered on paid plans. The model this
replaced (OmniVoice) has Apache-2.0 code but CC-BY-NC weights — the maintainers
confirm on the model card that the pre-trained model "can't be used
commercially" — which is why it was removed on 2026-10-04. Do not substitute
XTTS v2 (Coqui CPML), F5-TTS (CC-BY-NC-4.0), Higgs Audio or Piper's GPL-3.0 fork.

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
are identical to `/tts/synthesize`. Chatterbox doesn't emit word timings, so
the API derives weighted per-word estimates from the text + audio duration,
which keeps subtitle auto-cueing working. Chatterbox has no speed knob either:
a cloned-voice request asking for a speed other than 1.0 is refused with a
sentence saying speed belongs to the narration voice.

---

### Licences and third-party components

Soundwave AI's own code is proprietary (Copyright © 2026 Soundwave AI, all rights
reserved). Everything bundled with it is listed, with its licence, in
[`THIRD-PARTY-NOTICES.txt`](THIRD-PARTY-NOTICES.txt) — generated from the real
dependency trees by [`scripts/license-audit.mjs`](scripts/license-audit.mjs),
which both build workflows run and which **fails the build** on anything
copyleft inside our code or non-commercial outright.

- **ffmpeg** (gyan.dev static Windows build) is GPLv3. It ships as a separate
  program, which does not affect our licence, and the installer carries its
  licence text and a written offer of corresponding source
  (`desktop/bin/FFMPEG-LICENSE.txt`, `FFMPEG-SOURCE-OFFER.txt`, written on every
  packaging run).
- **whisper.cpp** (MIT) does the local speech recognition; **yt-dlp** (Unlicense)
  does the YouTube imports.
- A licence review on 2026-10-04 removed three things from this repo that had no
  business being in a product for sale: two unlicensed MP3s staged into the
  installer (nothing referenced them), an MIT `LICENSE` file in
  `soundwave-agent/` that granted away the shorts engine, and the OmniVoice
  voice-cloning model — its code is Apache-2.0 but its **weights are CC-BY-NC**
  (the maintainers say so on the model card), and cloned voices were behind paid
  plan tiers. Cloning now runs on **Chatterbox**, which is MIT for both code and
  weights. If you add a model here, check the *weights'* licence, not the repo's.

## Design system

Dark-only UI: background `#0A0F1C`, cards `#111827`, primary blue `#3B82F6`,
accent violet `#8B5CF6`, success `#10B981`, danger `#EF4444`, warning `#F59E0B`.
Radii 4/6/8, 4-px spacing grid, Inter/JetBrains Mono type scale, layered
shadows, visible `:focus-visible` rings, WCAG 2.1 AA contrast. Every text
container truncates or clamps; flex children carry `min-width:0`.

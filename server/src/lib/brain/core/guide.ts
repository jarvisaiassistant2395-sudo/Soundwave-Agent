// ── The Soundwave guide: what the agent knows about its own app ─────────────
// Every feature, explained the way the agent should explain it — with the
// exact button and menu names (desktop app 1.4.0 / phone app 1.1.0). The
// agent's instruction lists the sections (guideIndex); Gemini fetches the
// one it needs with the soundwave_guide tool and explains from it.
// Shared by the PC and the phone app (pure TypeScript, no imports).
//
// Keep it true: when a screen changes, change its section here too
// (server/tests/guide.test.ts checks the key facts).

export interface GuideSection {
  id: string;
  title: string;
  /** One line for the index in the agent's instruction. */
  summary: string;
  text: string;
}

export const GUIDE_SECTIONS: GuideSection[] = [
  {
    id: "overview",
    title: "What Soundwave AI is",
    summary: "the app in one page: the agent, shorts, YouTube, brain, memory, voice, phone, Morning Setup",
    text: `Soundwave AI is a Windows desktop app with an AI agent (you, "Soundwave") that makes vertical YouTube Shorts and talks with the user.

Main parts:
- Command Center: the main page (it opens first). Type or talk to the agent; it makes shorts, answers questions, explains the app, opens websites and apps, and checks the PC.
- Shorts: the agent writes a script for the topic (with Gemini), narrates it in a Soundwave voice, adds big word-by-word captions over gameplay from the Orbital NCG YouTube channel, and renders a 9:16 video — a few minutes per short.
- YouTube: link a channel once and shorts can be posted automatically or with one click.
- Brain: Google Gemini with the user's own free API key (Settings → Brain).
- Memory: notes the agent saves, a summary of earlier conversations, and the list of shorts made — so it remembers what you did together.
- Voice: tap the mic, hold it to talk, or press Ctrl+Shift+Space from any app. Speech is recognized on the PC; replies are spoken in Microsoft neural voices.
- Phone app (Android): the same conversation on the phone. It can keep chatting with the agent even when the PC is off.
- Morning Setup and the daily briefing: every morning Soundwave researches the topics you chose (anything — AI news, trending GitHub repos…) with Gemini and starts talking when you open the app, with the weather, your shorts and ideas for today; the chip also opens your morning websites and apps on the PC.

Other pages in the left sidebar: Overview (dashboard), Projects (every short), Voice Library, Generate Short, Activity, Settings, Help & Docs.`,
  },
  {
    id: "command-center",
    title: "The Command Center screen",
    summary: "every part of the main screen: top bar, left cards, orb and dock buttons, conversation, chips",
    text: `The Command Center has a top bar and three columns.

Top bar (left to right): the assistant's name, "Online", the brain pill (shows the Gemini model, "Add Gemini key" or "Gemini: problem" — click it to open Settings → Brain), the clock and date, the voice picker (the Soundwave voice for replies and shorts), the "unused Orbital videos" counter (click it for the background history), and the gear button (Assistant Configuration).

Left column (scrolls on its own):
- System Stats: live CPU, memory and disk of this PC (refresh button).
- Orbital NCG Backgrounds: how many channel videos are still unused, how many were used (never reused), the last imported background, a link to youtube.com/@OrbitalNCG, a clock button for the history and a refresh button that re-checks the channel for new uploads.
- YouTube Automation: shows the linked channel (or "NOT LINKED"), the Auto-Post switch, the default visibility, "Post to YouTube" for the latest video, and "Setup" (opens the YouTube settings).
- Latest Rendered Video (after the first short): a player, "Download Short (MP4)" and "1-Click Post to YouTube Shorts".
- System Uptime: how long the PC has been on, session and command counters, system load.

Center: the thinking orb (click it to talk) with a status line under it, and the dock with four buttons — film icon (1-Click Viral Short Generator), microphone (tap to talk, hold for push-to-talk), workflow icon (Ghost Operator macros) and gear (Assistant Configuration).

Right column — Conversation: "Clear" starts a fresh conversation (the memory keeps a summary of the old one), "Export"/"Extract Conversation" downloads it. Messages from the phone are labelled "YOU (PHONE)", spoken ones "YOU (VOICE)". Agent replies have a speaker button to hear them again. Finished shorts appear with a player, "Download Video (MP4)" and "Post to YouTube". Above the message box: a live progress bar while a short renders, and the chips "🌅 Morning Setup" and "🎬 Make Short".

Assistant Configuration (gear) has four tabs: General & Voice (assistant name, Soundwave voice with "Test Voice", Speak Replies Aloud, voice input status), Memory (the agent's notes and conversation summary), YouTube API & Shorts (link YouTube, auto-publish, privacy) and Thinking Orb (orb animation style).`,
  },
  {
    id: "make-short",
    title: "Making a short",
    summary: "how to start a short (chat, Generate button, generator window) and what happens step by step",
    text: `Three ways to make a short:
1. Ask in the chat (PC or phone): "make a short about black holes". Add details if you like — audience, tone, facts to include ("for kids", "mention the event horizon"). The agent passes them on to the script.
2. The film button in the dock, the "🎬 Make Short" chip or "Generate Short" in the sidebar open the 1-Click Viral Short Generator: pick a niche (Psychology & Dark Mind Tricks, Mind-Bending Facts, Untold History, Money & Wealth, AI & Future Tech, Deep Motivation, Cosmic Horror) or type a custom topic, choose the narrator voice and resolution (720p renders fastest, 1080p is sharper), optionally tick "Automatically post to YouTube Shorts after rendering", then press "Generate Short".
3. From the phone app, by typing or talking.

What happens (a few minutes; a progress bar shows each step):
1. Script: Gemini writes a 90–140 word narration for the topic, with a hook first. Without a Gemini key the agent uses a built-in viral script.
2. Voiceover in the chosen Soundwave voice (Microsoft neural voice, needs the internet).
3. Word-by-word captions, timed to the voice.
4. Background: the agent picks an Orbital NCG video it has never used, pastes its link into the YouTube link importer and imports only the stretch of gameplay the short needs.
5. Render: FFmpeg makes a vertical 9:16 MP4 (720p or 1080p).
6. If YouTube is linked and auto-publish is on, it uploads the short.

When it's done the video appears in the conversation with a player, "Download Video (MP4)" and "Post to YouTube"; it's also in the Latest Rendered Video card and on the Projects page. On the phone it shows a Watch button. With notifications on, Windows tells you when it's ready.

Only one short renders at a time — asking again while one is rendering just tells you it's busy. The video files are kept on the PC in %APPDATA%\\Soundwave AI\\uploads.

To cut Shorts out of a video that already exists (a long recording, someone else's video), that's a different thing: see "Shorts from a long video" — the agent listens to it and clips the best moments.`,
  },
  {
    id: "clips",
    title: "Shorts from a long video",
    summary: "paste a long video (a YouTube link or a file) and the agent cuts the best moments into vertical Shorts with captions",
    text: `Ask for it in plain words — "make shorts out of this video", "cut the best bits out of <link>", "find 3 clips from this" — and give a YouTube link, or the path of a video file already on this PC. The agent downloads the video (links only) and listens to it: it looks for the parts that stand on their own — a hook, a surprising fact, a strong opinion, a laugh — ignoring intros and housekeeping. You can steer it: "the funny bits", "the part about pricing".

It then cuts each moment into a vertical Short: the video cropped to 9:16, the sound exactly as recorded, and captions of what is being said, burned in. Nothing else is added — no narration, no new background — it's your own footage. Ask for 1 to 5 (3 by default); 720p or 1080p comes from Settings → Quality, as for every short.

Rendering takes a few minutes per clip; the clips are posted in this chat as they're ready, and can be watched, downloaded and uploaded to YouTube from here (Settings → YouTube API & Shorts). This runs on the PC, so it needs Soundwave AI running — the phone asks the PC for it, like every short. The speech engine (whisper.cpp, the same one voice input uses) writes the captions; without it the clips are still cut, just without captions, and a video with no speech (music, gameplay) is cut without them too.

Only one video renders at a time (this and the normal shorts share that). Nothing is ever posted anywhere by itself.`,
  },
  {
    id: "watch-channel",
    title: "Watching a channel",
    summary: "follow a creator and get shorts cut from every new video automatically — how to start, what it checks, limits",
    text: `Tell the agent to watch a creator and every new video gets clipped by itself: "watch @MrBeast", "clip everything MrBeast posts, 2 shorts each", "keep an eye on @SomeChannel and cut the funny bits". Give the channel's link or its @handle — a video link is a different thing (that's the one-off "cut shorts out of this video").

What happens: the PC checks the channel every few minutes. When a new video appears, the agent announces it in the chat and cuts the shorts you asked for (3 by default, 1–5), exactly like "shorts from a long video" — the agent's picks, vertical, captions, your clip limits — and posts them here as they're ready. You can give a focus ("the funny bits", "the part about pricing") that applies to every video.

It only clips videos posted **after** you asked, unless you also say "and clip the latest one". So following a channel with 900 videos does not start 900 renders. If a channel posts several videos at once, the agent takes them in small batches (up to 3 per check) so the PC isn't swamped, and says when more are waiting.

It runs on the PC while Soundwave AI is running — if the PC was off when the video was posted, it's picked up the next time Soundwave AI starts (the checks are about what's been seen, not about the clock). Ask "what channels are you watching?" any time for the state, and "stop watching @MrBeast" (or "stop watching all") to stop.

One video renders at a time, clips and normal shorts together — that's why a queue can wait a few minutes. Up to 10 channels can be watched at once. The clips are the creator's own footage: keep them for yourself or use them where you have the right to (a repost of someone else's video needs their permission).`,
  },
  {
    id: "backgrounds",
    title: "Orbital NCG backgrounds",
    summary: "where the gameplay backgrounds come from, the never-reuse rule, history, reset, import problems",
    text: `Every short uses gameplay from the YouTube channel Orbital NCG (youtube.com/@OrbitalNCG). The agent picks a video it has never used before, pastes its link into the YouTube link importer and imports just the part the short needs. A video counts as used once a short has been rendered from it — so no background is ever repeated.

Where to see it: the "unused Orbital videos" counter in the top bar, the Orbital NCG Backgrounds card on the left, and the background history (click the counter or the clock icon on the card). The history window lists the used videos (with the short's topic and the stretch used) and any videos that were skipped because they couldn't be imported, with the reason.

Buttons in the history window:
- Re-check Channel: looks for new uploads on the channel right away (it's also re-checked automatically).
- Reset History: makes every video available again. Only needed if all of them have been used — the agent will say so.

If importing fails: YouTube sometimes blocks downloads ("Sign in to confirm you're not a bot"). The app keeps its YouTube downloader (yt-dlp) updated automatically every time it starts, skips a video it can't import and tries another one. If many fail in a row, wait a while and try again — it's YouTube limiting downloads, not a problem with your setup.`,
  },
  {
    id: "youtube-link",
    title: "Linking a YouTube channel (step by step)",
    summary: "the complete walkthrough: Google Cloud project, YouTube Data API, consent screen, Desktop OAuth client, Connect button, common errors",
    text: `Linking lets Soundwave upload shorts to your channel. It's free and takes about 10 minutes once. You create your own small "app" in Google Cloud (Google requires it), then connect it in Soundwave.

Part A — in Google Cloud (use the Google account that owns the YouTube channel):
1. Open console.cloud.google.com and sign in.
2. Create a project: click the project picker at the top → New Project → name it, e.g. "Soundwave" → Create. Make sure it's selected at the top.
3. Turn on the YouTube API: menu (☰) → APIs & Services → Library → search "YouTube Data API v3" → open it → Enable.
4. Set up the sign-in screen: menu → Google Auth platform (older consoles: APIs & Services → OAuth consent screen) → Get started. App name: "Soundwave"; support email: your Gmail → Next. Audience: External → Next. Contact email: your Gmail → Next. Agree to the policy → Continue → Create.
5. Allow your account: Google Auth platform → Audience → Test users → Add users → enter the same Gmail → Save. (Or press "Publish app" here instead — see "Good to know" below.)
6. Create the client: Google Auth platform → Clients → Create client → Application type: Desktop app → name "Soundwave desktop" → Create. Copy the Client ID (ends in .apps.googleusercontent.com) and the Client secret (starts with GOCSPX-). It must be the "Desktop app" type.

Part B — in Soundwave on the PC:
7. Command Center → gear button → "YouTube API & Shorts" tab. Paste the Client ID and the Client Secret, then press "Save API Keys".
8. Press "Connect YouTube account". Your web browser opens Google's sign-in: pick the account (and the channel, if it asks). Google warns "Google hasn't verified this app" — that's expected because it's your own app: click Continue. Allow both permissions (upload videos, see your YouTube account) → Continue. The page says "YouTube is connected" — close it and go back to Soundwave. The badge now shows your channel name.
9. Optional: tick "Auto-Publish Shorts to YouTube upon generation", pick the Privacy (Public, Unlisted, Private) and press "Save API Keys". "Test Connection" checks the link any time.

Good to know (important):
- Private lock: YouTube restricts videos uploaded through the API from new, unaudited Google Cloud projects to private viewing. Uploads work, but they stay Private until your project passes YouTube's API compliance audit — request it with the YouTube API Services audit form (support.google.com/youtube/contact/yt_api_form). Until then, to publish publicly, download the MP4 in Soundwave and upload it in YouTube Studio.
- Weekly re-linking: while the app in Google Auth platform is in "Testing", Google ends the sign-in after 7 days and uploads fail until you press "Connect YouTube account" again. To avoid that, open Google Auth platform → Audience → "Publish app" (In production). No review is needed for your own use; you'll just see the "unverified app" warning when connecting.
- Limits: up to 100 uploads per day per Google Cloud project — plenty for shorts.

If something goes wrong:
- "redirect_uri_mismatch": the client isn't a Desktop app — create a new client with type Desktop app (step 6) and paste its ID and secret.
- "Access blocked" / "access_denied" / "has not completed the Google verification process": add your Gmail as a test user (step 5) or publish the app. If you pressed Cancel, just connect again.
- "invalid_grant" or uploads suddenly failing: the sign-in expired or was removed — press "Connect YouTube account" again.
- "No YouTube channel": that Google account has no channel — create one at youtube.com, or connect with the right account.
- "insufficientPermissions" on Test Connection: connect again and allow both permissions.

Advanced alternative: paste a refresh token from Google's OAuth 2.0 Playground (needs a "Web application" client with https://developers.google.com/oauthplayground as redirect URI, and the scopes youtube.upload and youtube.readonly) into the "OAuth Refresh Token" field.

To unlink: delete the fields and save, and remove the app's access at myaccount.google.com/permissions.`,
  },
  {
    id: "youtube-publish",
    title: "Posting shorts to YouTube",
    summary: "auto-publish, the Post to YouTube buttons, titles and descriptions, privacy, the private lock",
    text: `Once YouTube is linked (see the linking guide):
- Auto-publish: with "Auto-Publish Shorts to YouTube upon generation" on (gear → YouTube API & Shorts, or the Auto-Post switch on the YouTube Automation card, or the checkbox in the generator window), every finished short is uploaded right after rendering. The chat message then includes the Shorts link.
- By hand: press "Post to YouTube" under a video in the chat, on the Latest Rendered Video card ("1-Click Post to YouTube Shorts") or on the YouTube Automation card.

What gets uploaded: the title comes from the start of the script, with " #shorts #viral" added; the description is the script plus a credit for the Orbital NCG background; tags are the defaults (shorts, viral and more); category Entertainment; privacy is the one you picked (Public, Unlisted or Private).

Remember YouTube's rule for new Google Cloud projects: uploads stay Private until the project passes YouTube's API audit (the linking guide explains it). You can always download the MP4 and upload it yourself in YouTube Studio.`,
  },
  {
    id: "brain",
    title: "The agent's brain (Gemini key and Settings → Brain)",
    summary: "getting a free Gemini API key, Settings → Brain options, free limits, errors, privacy",
    text: `Soundwave thinks with Google Gemini, using your own API key. It's free.

Get a key:
1. Open aistudio.google.com/apikey and sign in with a Google account.
2. Click "Create API key" and copy it (it starts with AIza).
3. In Soundwave: Settings → Brain → paste it into "Gemini API key" → press "Save & test". It says "Gemini is connected" with the model that answered.

Settings → Brain also has:
- Model: Gemini 3.8 Flash is recommended. Others: 3.7 Flash, 3.5 Flash-Lite (fastest), 3.1 Flash-Lite, "Newest Flash (automatic)", plus anything else your key can use.
- Thinking — "How long Gemini thinks": Quick (fastest, best for talking), Balanced, Deep (hard questions, slowest).
- Search the web: live answers with Google Search. It needs a key with billing turned on; on the free tier the agent answers without it.
- "What the agent can do": the list of its real abilities on this PC.
- "Remove the key".

Free limits: Google gives each model a number of free requests per day (they reset at midnight Pacific time) and per minute. If the chosen model runs out or is overloaded, the agent automatically tries Gemini 3.5 Flash-Lite, which has its own free quota. You can also pick another model, or turn on billing for the key in Google AI Studio.

Common errors: "the key isn't valid" — copy it again from AI Studio; "free requests are used up" — wait for the reset or pick another model; "per-minute limit" — wait a minute; "overloaded" — try again shortly; "Google doesn't offer the Gemini API here" — the account's country isn't supported. The brain pill in the Command Center turns amber when something's wrong; Settings → Brain shows Google's exact message.

Privacy: your messages and the recent conversation go to Google with your key (on the free tier Google may use them to improve its products). The key is stored only on your PC (in %APPDATA%\\Soundwave AI\\data\\brain.json) — and on your paired phones if "Chat from the phone when this PC is off" is on. Without a key the agent still makes shorts, with built-in scripts.`,
  },
  {
    id: "chat-tools",
    title: "What the agent can and can't do in chat",
    summary: "its real abilities (shorts, videos, PC actions, memory, Morning Setup, guide) with example requests, and its limits",
    text: `In the chat (typed or spoken, on the PC or the phone) the agent can:
- Make shorts: "make a short about the deep sea, for kids". Only one renders at a time.
- Follow progress: "how far is my short?", "how many backgrounds are left?"
- Find videos: "list my shorts", "show me my last video" (puts a player in the chat), "show the one about octopuses".
- Open websites in the PC's browser: "open YouTube Studio", "search YouTube for minecraft parkour".
- Open apps on the PC (Windows Start menu apps): "open Spotify", "open Notepad".
- Check the PC: "how's my PC doing?" (CPU, memory, disk, uptime).
- Remember: "remember that my channel is about space", "what do you remember about me?", "forget that".
- Run the Morning Setup: "good morning, run my morning setup".
- Change the daily briefing: "brief me on trending GitHub repos every morning", "make my briefing 7:30", "remove the football topic".
- Explain Soundwave: any question about a feature, setting or setup.
- Talk: answer questions, brainstorm topics, hooks, titles and descriptions, write scripts, translate, quick maths.
- Search the web, if Search is on in Settings → Brain (needs billing).

It can't (yet): change the volume or other PC settings, read the screen or files, set timers or reminders, send emails or messages, or edit videos after they're made. It never claims to have done something it didn't.

When the PC is off, the phone's agent can chat, explain the app, use the memory, change the daily briefing and give it (researching your topics with Gemini) — making shorts, videos and PC actions wait for the PC.`,
  },
  {
    id: "memory",
    title: "The agent's memory",
    summary: "what it remembers (notes, conversation summary, your shorts), how to add, see, edit and forget",
    text: `Soundwave remembers, so it doesn't start from zero:
- Notes: facts it saved because you asked ("remember that…") or because they matter later — your name, your channel's niche, preferences. Up to 60 notes.
- A summary of earlier conversations: as the chat grows (only the latest messages are sent to Gemini each time) and whenever you press Clear, Gemini updates a short summary of what you talked about and did.
- What you made: the list of your shorts, their results and YouTube links.

Where to see it: Command Center → gear → Memory tab. You can read and delete notes, add your own ("Add a note"), see the conversation summary, and "Forget everything".

By voice or chat: "remember that I post every day at 6 pm", "what do you remember about me?", "forget that I like Ryan's voice".

Where it's kept: on the PC (%APPDATA%\\Soundwave AI\\data\\agent-memory.json). Paired phones get a copy so they know it when the PC is off; notes saved on the phone go back to the PC when it reconnects. The summary is written by Gemini, so conversation text goes to Google for that. Passwords and API keys are never stored in memory.`,
  },
  {
    id: "voice-input",
    title: "Talking to Soundwave (voice input)",
    summary: "mic button, hold-to-talk, auto-send, the Ctrl+Shift+Space voice bar, Settings → Voice & Desktop, microphone problems",
    text: `On the PC:
- Tap the microphone in the dock (or the orb) and talk. It sends by itself when you pause; tap again to send sooner. Hold the mic instead for push-to-talk (it sends when you let go).
- From any app: press Ctrl+Shift+Space. A small voice bar appears above the taskbar, listens, answers out loud and shows the reply. Press the shortcut again to send right away. Your words and the answer also land in the Command Center's conversation.

Speech is recognized on your PC by whisper.cpp with a built-in English model — no account, no key, your voice is never uploaded. (Replies are spoken with Microsoft's online voices.)

Settings → Voice & Desktop:
- Voice input: test your microphone ("I heard: …").
- Send when I stop talking: on = sends after a short pause; off = tap again to send.
- Sound cues: a soft chime when listening starts and stops.
- Speak replies aloud.
- Voice shortcut: choose the key combination (or turn it off).

Microphone blocked? On Windows: Settings → Privacy & security → Microphone → turn on "Microphone access" and "Let desktop apps access your microphone".

On the phone: tap the mic in the app. While the PC is reachable the recording is recognized by the PC; when the PC is off, Gemini transcribes it.`,
  },
  {
    id: "voices",
    title: "The agent's voices",
    summary: "the Soundwave voices (which sound most natural) and every place to change them, reading replies aloud on PC and phone",
    text: `Soundwave speaks and narrates shorts with Microsoft's neural voices — all free, nothing to install. The most natural ones are the newest "Multilingual" generation: Ava and Emma (US female) and Andrew and Brian (US male). The classic set is still there: Guy, Christopher (US male), Ryan (UK male), Jenny, Ana (US female) and Sonia (UK female). Pick the ones marked "most natural" in the Voice Library first — they are noticeably warmer and less flat. The same voice is used for replies and for the shorts it makes.

Change it in any of these places: the voice picker in the Command Center's top bar; the generator window ("Narrator"); gear → General & Voice → Soundwave Voice ("Test Voice" plays a sample); Settings → Preferences → Agent voice; or the Voice Library page (preview each voice, then "Use in Command Center").

Reading replies aloud: gear → General & Voice → "Speak Replies Aloud" (also in Settings → Voice & Desktop). Every reply has a speaker button to hear it again. Replies start playing while they're still being made, at a natural pace with a short pause at each sentence, and long explanations are read to the end (they're spoken in pieces, so nothing stops halfway).

On the phone: Settings → "Read replies aloud" (When I talk / Always / Never) and "Voice" (same as the PC, or pick one for the phone).

The voices come from Microsoft's online speech service, so they need the internet. If it can't be reached the app says so instead of using a robotic fallback voice, and a short is never rendered with a stand-in voice. When the PC is off, the phone app (1.2.0+) speaks the same voices itself.`,
  },
  {
    id: "phone",
    title: "The phone app (Android)",
    summary: "installing and pairing, what works with the PC on and off, chatting without the PC, syncing, privacy, problems, updating",
    text: `The Soundwave phone app is the agent in your pocket — the same conversation as the Command Center.

Install and pair (once):
1. Install the Soundwave APK on the Android phone (Android 7 or newer; allow installing from that source when Android asks).
2. On the PC: Settings → Phone → turn on "Let my phone connect". A QR code appears (Windows may ask to allow Soundwave AI on private networks — allow it).
3. In the app: "Scan QR code". No camera? Choose "Enter code" and type the PC address and the code shown under the QR code. The phone remembers the PC.

With the PC on (Soundwave AI running — the tray counts — and the phone on the same Wi-Fi): chat and talk to the full agent, make shorts, watch finished shorts (Watch button), hear replies in the Soundwave voices, and run the Morning Setup (it opens your morning apps on the PC). Messages from the phone show as "YOU (PHONE)" on the PC.

With the PC off or out of reach: the app keeps chatting — Gemini answers directly on the phone, with the conversation and the agent's memory, so it knows what you did. It can explain every Soundwave feature, change your morning briefing, give you the daily briefing on your own topics (it researches them with Gemini), and set alarms on the phone itself. Voice input works (Gemini transcribes it) and replies are read aloud in your Soundwave voice by the phone itself. It can't make shorts, show or download videos, or open things on the PC until the PC is back. Everything you said goes back into the PC's conversation and memory as soon as the phone reaches the PC again.

Chatting without the PC needs "Chat from the phone when this PC is off" in Settings → Phone on the PC (on by default) and a Gemini key in Settings → Brain. The PC then gives your paired phones a copy of the key and the memory, end-to-end encrypted. Turn it off and phones delete the key next time they connect.

Privacy: the phone talks straight to the PC over your Wi-Fi, end-to-end encrypted with the key from the QR code. When the PC is off, the phone talks to Google's Gemini directly.

If it says "Can't reach your PC": check Soundwave AI is running on the PC, "Let my phone connect" is on, both are on the same Wi-Fi, and Windows Firewall allows Soundwave AI on Private networks (and the Wi-Fi is set to Private). Away from home: install a VPN such as Tailscale on both, then pair again.

Updating the app: test builds are signed with a new key each time, so uninstall the old app first, install the new one and pair again. "This phone isn't paired anymore": it was removed on the PC — pair again. Unpair from the phone in its Settings, or remove phones in Settings → Phone on the PC.`,
  },
  {
    id: "alarms",
    title: "Alarms on the phone",
    summary: "ask the agent for an alarm, Snooze and Turn off, ringing in Bluetooth earbuds, the morning briefing starting after you turn it off, the seconds setting, permissions",
    text: `The agent can set an alarm on your Android phone. Just ask: "set an alarm for 6:30" or "wake me at 7 with an alarm called Gym".

Alarms need the Soundwave phone app 1.3.0 or newer — they live in the app itself. (If the phone's app is older, the PC says so instead of setting anything: install the newest SoundwaveCompanion APK and ask again.)

What happens: Soundwave's own alarm screen opens at that time (over the lock screen) and the alarm rings — Snooze (9 minutes) or Turn off. The alarm lives on the phone, so it rings with the PC off, and it shows in the phone's notification bar while it's set.

Sleep with earbuds in? The alarm rings in your Bluetooth earbuds or headset when they're connected: Soundwave routes the sound there itself (Android often sends alarm audio to the phone's speaker anyway), and it turns the alarm volume up for the ring, putting it back when you turn the alarm off — so it can wake you with the earbuds in. The alarm screen says where it rings, under the time, and phone app → Settings → "Alarm & the briefing" shows it too ("Rings on Pixel Buds Pro") with a switch to keep it on the phone speaker instead. With nothing connected it rings on the phone speaker. The briefing that starts afterwards plays wherever your phone's sound comes out — the earbuds included.

After you turn it off, your morning briefing starts by itself a few seconds later: the phone already has it, or writes it there if the PC is off. The wait is yours to set — phone app → Settings → "Alarm & the briefing": "Start my briefing ___ seconds after I turn off an alarm" (default 30, 0–600). You can also say it in the chat: "start my briefing a minute after I turn off my alarm".

Ask for an alarm from the PC too (Command Center): if your phone is connected, it's set there; if it isn't, the alarm is set the next time the phone app is open — the agent tells you which happened. Ask the phone itself when the PC is off and it sets it on the spot.

If the alarm doesn't ring, the phone needs to be allowed to notify: open the phone app → Settings → "Allow notifications" (Android 13+ asks the first time you set an alarm). Alarms are exact timers, so Android may also ask for "Alarms & reminders" permission the first time. Keep the phone's battery saver off for Soundwave if your phone has a strict one (Xiaomi, Huawei, Samsung) — otherwise the alarm can be delayed while the screen is off. Turning an alarm off before it rings: phone app → Settings → "Next alarm" → Cancel.`,

  },
  {
    id: "morning-setup",
    title: "Morning Setup and the daily briefing",
    summary: "the automatic morning briefing on your own topics (researched with Gemini), when it talks, the Morning Setup chip, PC off, how to change it",
    text: `There are two ways to get your morning briefing:
1. Automatically: every morning at the time you choose (08:00 by default) Soundwave prepares your briefing — it researches your topics with Gemini — and starts talking as soon as you open the Soundwave app on your phone, or the Command Center on the PC, after that time. Once you've heard it on one device it isn't spoken again on the other (it stays in the chat). It's offered until about 10 hours after the briefing time.
2. Right now: press the "🌅 Morning Setup" chip (Command Center or phone app) or say "good morning, run my morning setup". That one also opens your morning websites and apps on the PC (YouTube Studio by default).

What's in it: the day and date, the weather for your city, what happened with your shorts since the last briefing, your YouTube channel's numbers (if linked), what you were working on (from memory), your own topics, and three fresh short ideas. Say "make idea 1" to start one.

Your own topics can be anything, in your own words — for example "the latest news about open-source, free AI tools", "new trending GitHub repositories", "football results from Serbia", "one motivational quote". Up to 8.

How the topics are researched: for each one Gemini 2.5 Flash searches Google (free with a free Gemini key — up to 500 searches a day). If search isn't available for your key, Soundwave reads fresh items from GitHub, Hacker News and Google News and Gemini sums them up instead. The briefing only tells you what was found, and says so when there's nothing new.

Set it up — either way works, and both are saved in my memory (so the phone knows them too):
- Settings → Morning Setup → "Your daily briefing": turn on "Brief me every morning", pick the time, and add your topics (Add topic; the bin icon removes one).
- Or just tell me: "brief me on trending GitHub repos every morning", "remove the football topic", "make my briefing 7:30".

With the PC off: the phone does everything itself. When you open the app after the briefing time it researches your topics with Gemini, writes the briefing and reads it aloud in your Soundwave voice (the phone app can speak Microsoft's voices on its own). Weather and your last known shorts are included; nothing is opened on the PC. If the PC was on at briefing time, the briefing is already waiting and the phone starts talking right away. Either way it goes into the PC's conversation.

Another way it starts by itself: set an alarm (ask the agent) and the briefing begins a few seconds after you turn the alarm off — the wait is set in the phone's Settings → "Alarm & the briefing" (30 seconds by default).

On the phone: tap Stop to stop it, or the speaker button to hear it again. The phone's Settings → "Talk when I open the app" turns the automatic speaking off on that phone (the alarm still starts it when you ask for an alarm).

Other Morning Setup settings (Settings → Morning Setup): the city for the weather (by default your PC's time zone city), the websites and apps the chip opens, "Open them when I start it from my phone", and "Include three short ideas". Without a Gemini key the briefing still has the weather and your shorts, but no research or ideas.`,
  },
  {
    id: "pages",
    title: "Overview, Projects and Voice Library pages",
    summary: "the other pages in the sidebar and what's on them",
    text: `- Overview (dashboard): "Welcome back" with today's date; cards for shorts made by the agent, shorts posted to YouTube, Orbital NCG videos left and the agent's voice; quick actions (Generate a short, Talk to the agent, Pick the agent's voice); and your recent shorts.
- Projects: every short the agent has made, newest first, with a search box ("Search by topic or background…"). Each card plays the video and lets you download it.
- Voice Library: the Soundwave voices with search and filters (gender, accent). Play a sample, then "Use in Command Center" to make it the agent's voice.
- Generate Short (sidebar): opens the Command Center's generator window. Activity (sidebar): the Command Center's activity view.
- Help & Docs: a short written guide to the app.`,
  },
  {
    id: "settings",
    title: "All settings",
    summary: "every Settings tab and the desktop options",
    text: `Settings (sidebar):
- Profile: your name and password.
- Brain: the Gemini API key, model, thinking level, web search, and what the agent can do.
- Billing: your plan's limits (resolution, watermark, video size).
- Preferences: the agent voice, the thinking orb style, "Download my data".
- Voice & Desktop: microphone test, send when I stop talking, sound cues, speak replies aloud, the voice shortcut (Ctrl+Shift+Space by default), keep running in the tray, start with Windows, notifications.
- Phone: let my phone connect (pairing QR code), chat from the phone when this PC is off, paired phones, help if the phone can't connect.
- Morning Setup: your daily briefing (every morning at…, your topics), weather city, websites and apps to open, open them from the phone, short ideas.

In the Command Center, the gear button opens Assistant Configuration: General & Voice, Memory, YouTube API & Shorts, Thinking Orb.`,
  },
  {
    id: "desktop-app",
    title: "The desktop app (Windows)",
    summary: "tray, starting with Windows, notifications, where files live, bundled tools, updates",
    text: `- Tray: closing the window keeps Soundwave running in the system tray, so the voice shortcut keeps working and shorts keep rendering. Click the tray icon to open it; right-click it to quit. Turn it off in Settings → Voice & Desktop ("Keep running in the tray").
- Start with Windows: starts quietly in the tray when you sign in (Settings → Voice & Desktop).
- Notifications: a Windows notification when a short is ready or fails while you're in another app.
- Where things live: %APPDATA%\\Soundwave AI — data (settings, the conversation, the memory, brain.json) and uploads (your videos).
- Built in: FFmpeg (rendering), yt-dlp (the YouTube link importer — updated automatically at every start) and whisper.cpp (speech recognition with an English model). Nothing else to install.
- Updates: new versions come as a new installer; install it over the old one (your data stays).`,
  },
  {
    id: "workflow-macros",
    title: "The Workflow button (Ghost Operator macros)",
    summary: "saved multi-step automations that really run on the PC — and what they can't do yet",
    text: `The workflow icon in the dock opens "Ghost Operator Macros": saved multi-step automations that really run on this PC.
- Built in: "🎬 1-Click Viral Short" (starts a real short and reminds you to check it) and "🧹 Workspace & System Diagnostics" (scans the Soundwave data folder for real — size, biggest files, what hasn't been touched in 30+ days — then reports the PC's live CPU, memory, disk and uptime and reads your memory; nothing is deleted).
- Steps can really: open a web page or an app, search the web in the browser, read the PC's live status, scan a folder, read the clipboard, set a reminder (a chat message now, a Windows notification when it's due), start a short, run Morning Setup, and read the agent's memory.
- Steps Soundwave can't do yet — changing the system volume, screenshots, moving windows, running code — are skipped and the reason is shown. Nothing is faked.
- Your own macros are kept per user in DATA_DIR/macros/, and plain English works too: "open youtube, set a 5 minute timer and check system stats".`,
  },
  {
    id: "troubleshooting",
    title: "Fixing common problems",
    summary: "quick fixes: no answers, Gemini errors, voice, shorts failing, YouTube, phone",
    text: `- The agent says it needs a Gemini key: add one in Settings → Brain (free from aistudio.google.com/apikey).
- Gemini errors (amber brain pill): open Settings → Brain to see Google's message. Invalid key → paste it again; daily free requests used up → wait until midnight Pacific time or pick another model; per-minute limit → wait a minute.
- No voice / replies not spoken: the Soundwave voices need the internet; check "Speak Replies Aloud" is on.
- The mic doesn't work: allow microphone access for desktop apps in Windows (Settings → Privacy & security → Microphone), then test it in Settings → Voice & Desktop.
- A short failed: the message says why. Background import problems ("Sign in to confirm you're not a bot") are YouTube limiting downloads — the app skips that video and updates its downloader; try again later. Voice service errors mean the internet or Microsoft's service was down.
- "All Orbital videos used": reset the background history (top-bar counter → Reset History).
- YouTube upload problems: see the linking guide — most often the 7-day sign-in expiry (connect again or publish the app) or the private lock for unaudited projects.
- Phone can't reach the PC: Soundwave AI running, "Let my phone connect" on, same Wi-Fi, firewall allows private networks. The phone can still chat on its own if chatting without the PC is on.
- Something else: ask me — and describe exactly what you see.`,
  },
  {
    id: "privacy",
    title: "Privacy: what goes where",
    summary: "which data stays on the PC and what is sent to Google, Microsoft and YouTube",
    text: `- Stays on your PC: the conversation, the memory, your videos, settings, the Gemini key and YouTube credentials (all in %APPDATA%\\Soundwave AI). Speech recognition runs on the PC — your voice isn't uploaded.
- Google Gemini: your messages, the recent conversation, the memory notes and summary, and short topics go to Google's Gemini API with your key (free tier: Google may use them to improve its products).
- Microsoft: the text of replies and scripts goes to Microsoft's speech service to be spoken.
- YouTube: only the shorts you post (automatically or by pressing Post to YouTube); the Orbital NCG backgrounds are downloaded from YouTube.
- Phone: talks straight to the PC, end-to-end encrypted. With "Chat from the phone when this PC is off", paired phones keep a copy of the Gemini key and the memory, and talk to Gemini directly when the PC is off.`,
  },
];

export const GUIDE_IDS = GUIDE_SECTIONS.map((s) => s.id);

/** One line per section, for the agent's instruction. */
export function guideIndex(): string {
  return GUIDE_SECTIONS.map((s) => `- ${s.id}: ${s.summary}`).join("\n");
}

export function guideSection(id: string): GuideSection | undefined {
  return GUIDE_SECTIONS.find((s) => s.id === id);
}

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ");

/** Best sections for free text (when the id isn't one of ours). */
export function searchGuide(query: string, limit = 2): GuideSection[] {
  const words = norm(query).split(" ").filter((w) => w.length > 2);
  if (!words.length) return [];
  return GUIDE_SECTIONS.map((s) => {
    const hay = norm(`${s.title} ${s.summary} ${s.text}`);
    const head = norm(`${s.id} ${s.title} ${s.summary}`);
    return { s, score: words.reduce((n, w) => n + (head.includes(w) ? 3 : hay.includes(w) ? 1 : 0), 0) };
  })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.s);
}

/** The soundwave_guide tool (no context needed). */
export function guideTool<C>() {
  return {
    declaration: {
      name: "soundwave_guide",
      description:
        "The Soundwave AI user guide — exact steps, button and menu names for every feature. Call it before explaining how anything in Soundwave works, how to set something up (Gemini key, linking YouTube, pairing the phone, Morning Setup, memory…) or how to fix a problem. Pick the section that fits; call it again for another section.",
      parameters: {
        type: "OBJECT",
        properties: {
          section: { type: "STRING", enum: GUIDE_IDS, description: "Which part of the guide." },
        },
        required: ["section"],
      },
    },
    async run(args: Record<string, unknown>, _ctx: C): Promise<Record<string, unknown>> {
      const id = String(args.section ?? "");
      const exact = guideSection(id);
      const found = exact ? [exact] : searchGuide(id);
      if (!found.length) return { found: false, sections: GUIDE_IDS };
      return { found: true, sections: found.map((s) => ({ id: s.id, title: s.title, text: s.text })) };
    },
  };
}

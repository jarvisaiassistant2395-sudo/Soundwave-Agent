# Beating the market: where Soundwave AI stands, and the plan

Written October 2026. Every price below was checked against the vendor or a
review that cites it, this month; sources are at the bottom. Prices in this
market move every few months — re-check before putting a number on a page.

## The one-paragraph verdict

Soundwave AI bundles four product categories that are sold separately and
expensively — an AI assistant (~$20/mo), a long-video clipper ($15–29/mo), a
voice studio with cloning ($6–22/mo), and PC automation agents ($20–40/mo) —
and sells the lot for **$12/mo (Pro)** or **$39/mo (Enterprise)**, running on the
customer's own machine, with their own Gemini key, their own CPU, and no upload.
The market's weakness is exactly our design: every competitor is a **cloud tool
you visit, metered by credits, holding your footage**. Ours is an **agent that
lives on your PC, owns your files and accounts, and never meters a minute**.
The plan is to make that difference loud, close the three gaps that matter
(publishing, first-run friction, updates), and repackage the plans so a buyer
can compare us to Opus Clip and see a landslide.

## What we sell today

| | Free | Pro | Enterprise |
| --- | --- | --- | --- |
| Price | $0 | $12/mo ($9.60/mo annual) | $39/mo ($31.20/mo annual) |
| Public meter | 10K TTS chars | 200K TTS chars | 2M TTS chars |
| Caps | watermark, 720p, 2 exports/h, 100 MB video | no watermark, 1080p, 20 exports/h, 500 MB | 4K, 100 exports/h, API access, 2 GB |

Shipped capabilities that matter here: long-video → Shorts with **measured
interest** from real audience data, built-in caption burn-in, silence removal,
trends and viral-niche discovery, YouTube channel reading, Gmail/Calendar/Drive,
reminders, local Whisper dictation + wake word, local (free) Edge TTS + Chatterbox
voice cloning, PC control (open apps/websites, volume, screenshots, macros), an
Android companion, and a Gemini-powered agent that runs in-process on the PC.

## The market, October 2026

### 1. Long-video → Shorts clippers (our closest rivals)

| Tool | Free | Entry paid | Mid | Notes |
| --- | --- | --- | --- | --- |
| Opus Clip | 60 min/mo, watermark, clips expire in 3 days | **$15** Starter (150 min, monthly only, no scheduler) | **$29** Pro (300 min, scheduler, auto-post, B-roll) / ~$14.50–19.43 annual | virality score, team seats, brand templates |
| Vizard | 60 min/mo, 720p, watermark, 3-day storage | **$29** Creator (~$14.50 annual, 600 min, 4K, API) | **$39** Business (teams) | 100+ languages dubbing |
| Submagic | trial only | **$19** Starter ($12 annual, ≤2-min videos, 15/mo) | **$39** Growth ($23 annual) | caption templates, auto-zoom, eye contact |
| Descript | screenshot hour | **$24** Hobbyist ($16 annual) | **$35** Creator | transcript editing, studio sound |
| Klap | trial | **$29** | $79 / $189 | dubbing 29 languages |
| quso.ai | 75 min, 720p | **$19** Lite (annual) | $26 / $33 | scheduling on every paid plan |
| CapCut | generous free editor | ~**$10–20** Pro | — | manual editing, no agent |

What they all share: minutes/credits are the meter, the footage is uploaded to
their cloud, social scheduling starts on the mid tier, and **none of them can
touch anything else on your PC**.

### 2. Faceless / auto-posting generators

AutoShorts.ai **$19/39/69–79**, FlowShorts **$19/39/69** (8/30/60 videos),
faceless.so **$29**, Crayo/Vadoo **$13**, Shortspilot **$15**, Vid.ai **$39**,
AITuber **$29–39**, AutoAIShorts **$4.99/wk**.
Auto-posting to YouTube/TikTok/Instagram is table stakes; everything else is
metered per video. This category got riskier in 2026: YouTube's inauthentic-content
enforcement makes purely synthetic channels a monetization gamble, which is
precisely why our "your real footage, repurposed" positioning is stronger.

### 3. AI assistants

ChatGPT **Free / Go $8 / Plus $20 / Pro $100–200**; Google **AI Plus $4.99–7.99 /
AI Pro $19.99 / Ultra $99.99–199.99**; Microsoft 365 **Personal ~$8.33 /
Premium ~$16.67**, Copilot Pro ~$20; Claude **Pro $20 / Max $100–200**;
Perplexity Pro $20.

None of them clip your footage, run on your machine, or keep working when the
network is gone. All of them know nothing about your files until you upload them.

### 4. Computer-use agents

Manus **$20 / $40 / $200** (credit-metered, mostly a cloud VM);
Lindy **from $29.99/user/mo**; Perplexity Computer **$200/mo**;
Claude Cowork and Copilot Actions inside $20–200 plans.
They either operate *their* machine (cloud) or only the apps they have
integrations for. Ours operates *your* PC, with your logged-in accounts, and is
included in the price.

### The stack a creator actually pays for, assembled

| Piece | Cheapest credible option | Cost |
| --- | --- | --- |
| Clipping | Opus Clip Pro annual / Vizard Creator annual | $14.50–19.43/mo |
| Voice + cloning | ElevenLabs Starter → Creator | $6 → $22/mo |
| Assistant | ChatGPT Go / Google AI Plus | $4.99–8/mo |
| Dictation | a Wispr-Flow-class tool | ~$10–12/mo |
| PC automation agent | Manus Standard | $20/mo |
| **Total** | | **~$55–80/mo** |

We charge **$12** for the whole box. That is either our best marketing asset or
a pricing mistake — see move 5.

## Where we already win (say these out loud)

1. **Nothing is uploaded.** Cloud clippers hold a copy of the customer's
   unreleased footage; we render locally with bundled ffmpeg. For anyone under
   NDA, in a company, or just private, this is decisive — and it is a claim no
   competitor in category 1 can make.
2. **No meters.** No credits, no processing minutes, no per-video caps, no
   watermark games, no export window that expires in three days. Our only
   real cost is the customer's own Gemini key.
3. **Clips chosen by measured interest, not a virality guess.** We score moments
   from the audience's own view data on the source video (`brain/core/interest.ts`)
   and show the evidence line on the clip card. Competitors ship one opaque
   "virality score".
4. **The agent has hands.** It opens apps, drives the browser, reads the screen,
   sends the email, sets the reminder, watches a channel, then cuts the clip.
   Opus Clip cannot send an email; ChatGPT cannot open your app.
5. **One purchase covers PC + phone**, with the phone as a companion to the PC's
   account rather than a second subscription.
6. **A real funnel that costs us nothing**: local TTS and local STT mean a Free
   user is not a bill.

## Where we lose (be honest)

1. **Nothing gets published.** Competitors' killer feature is "clip → schedule →
   post". Our clips land in a folder and a human does the rest.
2. **First run is a cliff.** Every rival is create-account-and-go; we ask for a
   Google account *and* a Gemini API key created in a developer console.
3. **Plans are metered in the wrong unit.** "200K characters" means nothing to a
   creator. Rivals sell "600 minutes of video" or "30 videos a month". Our
   cheapest paid tier *reads* stingier than a $15 clipper while actually being
   far more capable.
4. **Updates require a re-download**, and the exe is unsigned (SmartScreen).
5. **One caption style, no brand kit**, where Submagic and Opus compete on
   caption templates and fonts.
6. **Windows + Android only** (no Mac, no iOS, no web).
7. **No analytics loop**: we know a clip's measured interest in the source, but
   we never learn how the *posted* clip did.

## The plan

Six moves, in order of payoff per week of work. Each one is scoped to this repo.

### Move 1 — Close the loop: publish, then learn (the moat)

**What:** upload finished Shorts straight to the user's YouTube channel
(scheduled or queued), then read back views/retention for each posted clip and
feed it into the next clip selection.

**Why it wins:** it is the one thing no competitor can copy. Cloud clippers don't
own the channel; YouTube-native analytics tools don't cut the video. We own both
ends, on the customer's machine. Every posted clip makes the next one better —
for *that* creator's audience — which is compounding and impossible to churn
away from. It also fixes our biggest functional gap in one stroke.

**Scope here:**
- `server/src/lib/youtubeChannels.ts` / `youtubeOAuth.ts`: add the
  `youtube.upload` scope (resumable `videos.insert`), plus a scheduler in the
  shape of `server/src/lib/emailSchedule.ts` (it already does persisted,
  cancellable, retried sends — copy that pattern).
- New agent tools: `publish_short`, `schedule_short`, `list_scheduled_posts`,
  alongside the existing `make_shorts_from_video` / `get_short_progress`.
- `server/src/lib/youtube.ts` already reads channel + latest-video statistics;
  extend it to per-upload stats after 24 h / 7 d, store them next to the clip,
  and let `interest.ts` weight them.
- UI: a "Ready to post" strip on the clip cards + a Scheduled list in Settings;
  a weekly line in the daily briefing — "your Tuesday clip did 3× your average".

**Effort:** the largest item here (~2–3 weeks). Do it before anything cosmetic.

**Caveat:** YouTube's API quota is 10,000 units/day and an upload costs 1,600 —
one or two uploads per user per day. Say so in the UI rather than failing
mysteriously.

### Move 2 — Make the first ten minutes effortless

**What:** a first-run wizard: link Google → get a free Gemini key (button opens
AI Studio, paste, tested in place) → connect YouTube (one press) → pick a voice →
say something and watch it answer.

**Why it wins:** our rivals' biggest structural advantage is a 60-second signup.
Every step of ours already exists — the wizard is choreography, not invention.
It also converts better: a buyer who reaches "it answered me" never asks for a
refund.

**Scope here:** `frontend/src/pages/Welcome.tsx` already has phases and a 2 s
poll; add the steps; `server/src/routes/brain.ts` already tests the key; reuse
the existing `/auth/providers` and `/youtube/config` routes.

**Effort:** ~3–5 days. Highest conversion-per-hour on this list.

### Move 3 — Sell like software, not like a developer tool

**What:** repackage the plans around what a creator buys, and add a lifetime tier.

- Meter the *user-visible* thing: **minutes of video processed per month** and
  **clips per month**, using the character limit only as an internal fair-use
  guard. A buyer comparing pages sees "Pro: 300 min of video, unlimited clips"
  against Opus's $29/300 min — at a third of the price, with the assistant and
  voice studio thrown in.
- Keep Free as a real funnel: 60 min/mo, watermark, clips expire in 7 days —
  the same shape as the category, so the comparison is apples-to-apples.
- Price: **Pro $15/mo ($144/yr)** — above today's $12, still half of Opus Pro and
  a quarter of the assembled stack; **Enterprise $39 → keep**, sell it as the
  agency/heavy tier. Grandfather existing subscribers.
- Add a **Founder lifetime: $199, first 100 buyers** (a new Stripe price + a
  seat counter). Lifetime is only safe for us because marginal costs are the
  user's own key and CPU — the one business model cloud rivals structurally
  cannot match. Do this *after* auto-update exists (move 4), because a lifetime
  buyer expects fixes delivered.

**Scope here:** `frontend/src/lib/plans.ts`, `Landing.tsx` pricing card,
`server/src/config.ts` + `server/.env.example` for one new price var, Stripe
dashboard for the price objects. The billing engine already supports
monthly/annual per plan.

**Effort:** ~2–3 days of code; a pricing-page rewrite is the real work.

### Move 4 — Behave like shipped software

**What:** auto-update (edition-aware: the retail build never pulls the Dev feed,
and vice versa) and a code-signing certificate.

**Why it wins:** without updates, every fix is "please re-download"; with an
unsigned exe, every buyer meets "Windows protected your PC" at the moment of
maximum doubt. Both are table stakes that reviewers punish.

**Scope here:** `electron-updater` + a public update feed (a small public
releases-only repo, or your own site — the private app repo cannot hold the
token); `desktop/src/edition.cjs` already knows the edition, so channel selection
is a one-liner. Signing is already wired in CI (`CSC_LINK` / `CSC_KEY_PASSWORD`);
it needs a certificate (~$70–400/yr, or $19 for the Microsoft Store route).

**Effort:** ~1 week of code; the certificate is a purchase, not a task.

### Move 5 — Match the polish that wins head-to-head comparisons

**What:** caption style presets (3–5 house styles + per-channel font/colour),
a brand kit (logo, colours, intro/outro stub), and an auto B-roll toggle for
moments with no visual interest.

**Why it wins:** Submagic and Opus win on *look*, not on intelligence. Our clip
selection is better; if the output looks plain in a side-by-side, buyers never
find out.

**Scope here:** the ASS caption pipeline in `videoClips.ts` (styles are a preset
table), a `brand.json` in the data dir, `frontend` settings page. B-roll last —
it needs a stock source, so treat it as a separate project.

**Effort:** ~1 week for captions + brand kit.

### Move 6 — Turn the privacy stance into the marketing

**What:** a landing page that leads with the comparison, not the feature list:

> **Your footage never leaves your PC.**
> Opus Clip: $29/mo to upload your videos to their cloud, 300 minutes, watermark
> until you pay. Soundwave AI: $15/mo, nothing uploaded, no minute meter, plus
> the assistant, the voice studio and the PC agent in the same box.

Plus a "what you'd pay otherwise" table (clipper + voice + assistant + dictation
+ agent ≈ $55–80/mo), a "your last long video, cut and posted while you sleep"
demo video, and the measured-interest story with a real evidence line from a
real clip.

**Why it wins:** every rival's pricing page is a credits table. A page that says
"no credits, nothing uploaded" is the only one a creator will remember.

**Effort:** days, not weeks — but it needs move 1 finished to be honest about
"posted".

## What NOT to build (and why)

- **TikTok / Instagram / Reels publishing (yet).** Each is a separate API
  approval process with its own review. YouTube first — it is where our data,
  the user's channel and the Shorts economics already are.
- **A cloud render farm.** It buys nothing the local renderer doesn't do, and it
  destroys claim #1 (nothing uploaded).
- **Synthetic faceless video as the headline.** It is the crowded, price-collapsed,
  monetization-risky lane. We sell *the creator's own content*, amplified.
- **Team seats / collaboration.** An agency tier is a different product
  (approvals, shared brand kit, seats). Revisit when Enterprise has paying users.
- **Mac / iOS.** Electron makes Mac plausible, but every native dependency
  (ffmpeg, whisper.cpp, kokoro, Chatterbox) needs a Mac build and a Mac to test
  on. Not before the Windows product is fully signed and self-updating.
- **4K upscaling / dubbing / translations.** Nice-to-have parity features;
  expensive, and nobody chooses a tool for them.

## The order

**First 30 days** — Move 2 (setup wizard) and Move 4's update path, because both
are small, both are blockers for selling at volume, and both make everything
after them cheaper to ship.

**Days 30–75** — Move 1 (publish → measure → learn). This is the product; treat
it as the main workstream and let the polish wait.

**Days 75–100** — Move 3 (packaging, pricing, lifetime) once publishing makes
the "cut and posted while you sleep" promise true, then Move 5 (captions/brand
kit) and Move 6 (the page).

**The one-line strategy:** everyone else rents you credits in their cloud. We
sell you a video team that lives on your PC, learns your audience, and never
meters a minute — and we charge less for it than they charge for the clipper
alone.

## Where this stands (October 2026)

All six moves are implemented in this tree:

1. **Publish → measure → learn** — `server/src/lib/postSchedule.ts` + `routes/posts.ts`:
   schedule a finished clip, it posts from the PC at the chosen time, per-upload
   stats are read back and stored next to the clip, and the interest model uses
   them when choosing the next cuts. Agent tools `schedule_short`,
   `list_scheduled_posts`, `cancel_scheduled_post`, `my_short_performance`.
2. **First-run wizard** — `frontend/src/pages/Setup.tsx` (link Google → free
   Gemini key, tested in place → connect YouTube in one press → pick a voice →
   say something), reachable again from Settings → Brain.
3. **Packaging** — plans are metered in **minutes of video and clips**
   (`server/src/lib/metering.ts`); characters are an internal fair-use guard.
   Free = 60 min/mo, watermark, clips kept 7 days. Pro = **$15/mo ($144/yr)**
   against Opus Clip's $29/300-min tier, Enterprise stays **$39**. Founder
   lifetime **$199, first 100** (`STRIPE_PRICE_LIFETIME`, `FOUNDER_SEATS`).
   Subscribers from before the repricing keep their price.
4. **Auto-update** — `desktop/src/update.cjs` + `electron-updater`: edition-aware
   channels (retail → `latest`, Dev → `dev`, and neither can be pointed at the
   other), checked on launch and every six hours, with a Restart & update button.
   CI publishes `latest.yml` + the installer to a public releases-only feed repo.
   Signing remains a purchase, not a task — the switch to verify downloaded
   updates' signatures is one line in `desktop/electron-builder.yml`.
5. **Look** — five caption styles and a brand kit (`server/src/lib/brand.ts`,
   `<data>/brand.json`, Settings → Brand), applied by the clip renderer and
   settable by voice (`set_caption_style`).
6. **The page** — `frontend/src/pages/Landing.tsx` leads with "Your footage
   never leaves your PC" and the comparison; `Pricing.tsx` follows it.

**One correction to the figures below.** The comparison was drafted as
"≈ $55–80/mo assembled". Re-checked against each vendor's own page in October
2026, the five subscriptions a creator actually assembles come to **$106/mo at
monthly rates** (Opus Clip Pro $29 + ElevenLabs Creator $22 + ChatGPT Plus $20 +
Wispr Flow Pro $15 + Manus $20; ~$15 less if every one is billed yearly). The
landing page prints that total with the check date instead of the estimate.

## Sources (checked October 2026)

- Opus Clip plans and limits — therundown.ai/tools/opus-clip (checked 28 Aug 2026), quso.ai/blog/opus-clip-pricing, castmagic.io/blog/opus-clip-pricing
- Vizard pricing — plisio.net/ai/vizard-ai (Apr 2026), quso.ai/blog/vizard-ai-review
- Submagic / Descript / CapCut / VEED — eesel.ai/blog/captions-ai-alternatives, storycut.com/alternatives/veed, ngram.com/blog/submagic-alternatives-tested
- Klap / Munch / Vugola — klap.app/blog/vizard-ai-review, vugolaai.com/blog/automate-youtube-shorts-ai
- Faceless generators and auto-posting — autogpt.net/10-best-ai-tools-for-faceless-youtube-shorts-channels-in-2026, flowshorts.app/blog/best-faceless-video-generators-auto-post, autoaishorts.com/blog/best-faceless-video-generators
- Assistants — morphllm.com/comparisons/chatgpt-vs-gemini-vs-copilot, felloai.com/gemini-pricing, felloai.com/copilot-vs-gemini
- Computer-use agents — simular.ai/alternatives/best-ai-agent, o-mega.ai/articles/top-10-computer-use-agents-ai-navigating-your-devices-full-review-2025
- ElevenLabs — dev.to/stimlau/elevenlabs-pricing-explained-free-starter-creator-and-pro-in-2026-4p6b, flexprice.io/blog/elevenlabs-pricing-breakdown
- YouTube's inauthentic-content enforcement and the faceless risk — vugolaai.com/blog/automate-youtube-shorts-ai

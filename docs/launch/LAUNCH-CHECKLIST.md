# Soundwave AI — what stands between here and shipping

**State:** the product is built. Everything in `docs/COMPETITIVE-PLAN.md` is
implemented, on `arena/84970bc4-soundwave-agent`, and a Windows installer builds
from `scripts/build-windows.ps1` without CI.

What is left is not code. It is a certificate, an account setting, a database
migration, two hosted URLs and a set of live keys — the unglamorous half of
shipping a paid desktop app. This list exists so none of it lives only in a chat
scrollback.

**Legend:** ⛔ blocks paying customers · ⚠️ blocks a *smooth* launch · ✅ done,
kept here because it is easy to un-do by accident.

---

## 1. The build

- [ ] ⛔ **Finish one clean build end to end.** `scripts/build-windows.ps1` on the
  owner's PC. Known-good so far: preflight, backend install/typecheck, tests
  under `FFMPEG_PATH`. Installers land in `desktop\release\`.
  *Done when:* `SoundwaveAI-Setup-<version>.exe` exists, installs, and **Settings
  → Voice & Desktop** shows that version.
- [ ] ⛔ **Install it on a clean Windows machine** — one with no Node, no Python, no
  ffmpeg. This is the claim the product makes ("nothing preinstalled").
  *Check:* clips export, voice input works, YouTube import works, and no Windows
  Defender quarantine. `desktop\bin` carries ffmpeg + yt-dlp + whisper.cpp + the
  MSVC runtime precisely so this passes.
- [ ] ⚠️ **Defender false positive on first run.** `assemble.mjs` protects the
  staged server on purpose, which is exactly what a heuristic scanner flags.
  If customers hit it, the answer is the signing certificate below, not a
  weaker protection step.
- [ ] ⛔ **Creator Studio auto-edit fails on Windows.** Found by the first local
  build: `POST /creator/auto-edit` returns a job that ends `FAILED`, with
  ffmpeg's own words in the job's `errorMessage`. Silence analysis and the
  storyboard render both pass on the same machine, so it is specific to this
  path — the only `-filter_complex_script` in the codebase, and the only render
  with no Windows coverage. Undiagnosed: the response did not carry the reason
  until the fix below, which is why the first three runs could only say
  "FAILED". Re-run `npx vitest run tests/creator.test.ts` with `FFMPEG_PATH` set
  and read the message.
- [x] ✅ Local build needs Node 20+, the script refuses anything older.

## 2. Signing and updates

- [ ] ⛔ **Buy a Windows code-signing certificate** (OV ≈ $200–400/yr, EV more).
  Until then every install shows "Unknown publisher" and SmartScreen fights the
  customer. The signing env vars are already wired in CI and the workflow
  signs when they are present — this is a purchase, not a task.
- [ ] ⛔ **Publish a release and prove the update path works.** Publish with
  `scripts/build-windows.ps1 -PublishTag v1.6.7`, put `latest.yml` + the setup exe
  in the public feed repo (`soundwave-updates`), then install the **previous**
  version on a test machine and watch it update itself.
  *Gaps:* `SOUNDWAVE_UPDATE_TOKEN` secret + `SOUNDWAVE_UPDATE_REPO` variable must
  exist in the feed repo, and this end-to-end path has **never run** — CI could
  not test it (billing) and no local test covers the download.
- [ ] ⚠️ **A `-PublishFeed` switch** (offered, not built): one run publishes the
  installers *and* the feed files, instead of two manual uploads.
- [ ] ⚠️ **Decide the CI question.** Actions is blocked by account billing
  (`steps: []`, "recent account payments have failed"). Options: fix
  Settings → Billing and plans · make the repo public (free Windows runners, but
  the source of a paid product) · a third-party runner · own PC only.
  Status: no decision taken. Own-PC builds work today, so this is not urgent —
  but CI is the only thing that has ever built a Windows installer other than
  the owner's machine, so it is the safety net.

## 3. Money

- [ ] ⛔ **Stripe live keys and price IDs.** `STRIPE_PRICE_PRO_MONTHLY/ANNUAL`,
  `_ENTERPRISE_*`, `STRIPE_PRICE_LIFETIME`, `STRIPE_WEBHOOK_SECRET`. Today
  `/billing/plans` reports `lifetime.reason: "no_price"` — the Founder tier is
  coded, priced at $199, capped at 100 seats, and cannot be bought.
- [ ] ⛔ **One real purchase, end to end, in live mode** — checkout → webhook →
  plan flips → metering reflects it. Include a refund path.
- [ ] ⚠️ **Founder seat counter**: confirm `sold` increments and the 101st attempt
  gets the 409 "sold out".
- [ ] ⚠️ **Grandfathering**: `PRICING_CHANGED_AT=2026-10-06`. Anyone who subscribed
  before that keeps their old terms. Verify with a back-dated test account.

## 4. Data

- [ ] ⛔ **Prisma migration for the new columns.** `subscriptionStartedAt`,
  `videoMinutesUsed`, `clipsUsed` and the lifetime fields are in
  `server/prisma/schema.prisma` but have **no migration file** — a production
  database would not have them. `prisma migrate diff` is unusable in the build
  sandbox (binaries.prisma.sh TLS failure), so this has to be generated from a
  machine with Prisma access.
  *Done when:* `prisma migrate deploy` on a copy of production adds the columns
  and the app serves metering without error.

## 5. Accounts and keys customers need

- [ ] ⚠️ **Soundwave's own Google OAuth client for the sold build.** There is a
  product-level decision in `docs/COMPETITIVE-PLAN.md` to skip it — the fallback
  is honest and works. Revisit if buyers complain.
- [ ] ⚠️ **Gemini key path**: the first-run wizard sends people to AI Studio.
  Confirm the flow works for someone with no AI Studio account.
- [ ] ⚠️ **YouTube Data API quota**: 10,000 units/day, 1,600 per upload — fine for
  one or two uploads per user per day, but confirm nothing in the publish path
  burns quota on reads.

## 6. The website and the words

- [ ] ⛔ **Deploy the landing page.** `frontend/src/pages/Landing.tsx` and
  `Pricing.tsx` are written and deliberately **unrouted** (see the note at the top
  of each). They need a static host and a `git push`-to-deploy hook, or the
  "Your footage never leaves your PC" pitch exists only in the repo.
- [ ] ⛔ **Re-verify every price on those pages before they go up.** The figures
  were read in October 2026 and competitor pricing moves. The $106/mo stack table
  and the "3 vs 7 days" retention claim are the two most likely to age badly.
- [ ] ⚠️ **Microsoft Store listing** (optional, separate distribution): needs the
  signing certificate first, and its own copy review.

## 7. Things that are done and should not be quietly broken

- ✅ Google-only sign-in (welcome screen + button, no auto-open), Settings →
  Billing and Settings → Brain.
- ✅ Moves 1–6 of the competitive plan: post scheduler, first-run wizard,
  metered plans (60 min Free / 300 Pro / 1,200 Enterprise), auto-update plumbing,
  caption presets + brand kit, landing/pricing copy.
- ✅ Two coexisting editions: the sold build and **Soundwave AI — Dev**
  (`-Dev`, everything unlocked, no billing, separate appId and data folder).
- ✅ 70 test files / 898 tests pass on the backend; 71 desktop tests pass.

---

### If you only do three things

1. Install one build on a clean PC and use it for an hour. Everything else is
   theory until that works.
2. Buy the certificate and publish one release, then prove a machine updates
   itself. That pair is what makes this a product rather than a folder of code.
3. Turn on Stripe live keys and buy your own $15 plan. Anything broken between
   checkout and metering is invisible until money moves.

# Set up one-click "Connect YouTube" (5 minutes, once, for the shop)

This guide creates **one Google OAuth client for Soundwave itself**. After this,
every customer presses *Connect YouTube* once and signs in — they never open
Google Cloud, never paste a client ID, never see a worksheet. You do it once
here, and every build you ship inherits it.

**Reuse your existing project from the website** (the one you made when you
built the web version). Everything else in it carries over: the consent screen,
your test users, the YouTube API enablement, and any audit/quota state — all of
those are per-**project**, not per-client. You only need a **new client** of
type *Desktop app*, because the website's *Web application* client can't work
for the desktop app: Google requires web clients to redirect to a fixed URL
matching exactly, port included, and Soundwave listens on a random local port
each time it starts. *Desktop app* clients are the documented exception — any
loopback port is accepted.

**Do not delete or change the website's client.** It keeps working; two clients
live in one project happily.

---

## Before you start

- Sign in to Google Cloud with the account that **owns the YouTube channel**
  (the one whose videos will be uploaded). If the project belongs to a different
  account that's fine — but while the app is in "Testing", the *channel's*
  account must be listed as a test user, and that's the account you enter below.
- Have the JSON file you'll download ready to keep somewhere safe (password
  manager / private folder). It is a credential. Never commit it, never paste
  it into a chat, never put it in the repository.

---

## Part 1 — open your existing project

1. Go to **https://console.cloud.google.com**.
2. Look at the **project picker** in the top bar (next to the "Google Cloud"
   logo — it shows a project name).
3. Click it and select your **website's project** from the list.
   - If you can't find it, check you're signed in with the right Google
     account (top-right avatar).
   - If it was deleted, create one: project picker → **New project** → name it
     (e.g. "Soundwave") → **Create** → select it. You'll then also need Parts 2
     and 3.

---

## Part 2 — make sure the YouTube API is on

4. Open this link in the same browser (it uses the project you selected):
   **https://console.cloud.google.com/apis/library/youtube.googleapis.com**
5. Look at the button:
   - It says **Manage** (or "API enabled") → already on, go to Part 3.
   - It says **Enable** → click **Enable**, wait ~15 seconds, done.

---

## Part 3 — check the consent screen (mostly already done by the website)

6. Left menu (☰) → **Google Auth platform** → **Audience**.
   - If you see *"Google Auth platform not configured yet"* instead: click
     **Get started** and fill it in — App name (e.g. `Soundwave`), your support
     email, **Audience: External**, your contact email, tick the policy box →
     **Create**. (Your website's sign-in already did this, so you probably
     won't see this screen.)
7. On **Audience**, look at **Publishing status**:
   - **In production** → nothing to do. (This is the good case: sign-ins don't
     expire weekly.)
   - **Testing** → under *Test users* click **Add users**, type the Gmail that
     owns the YouTube channel, **Save**.
     - While it says Testing, Google ends each sign-in after **7 days** —
     harmless while you test, annoying in daily use. When you're ready for
     customers, click **Publish app** → **Confirm**. Publishing removes the
     7-day expiry. Until Google finishes verification, people see a *"Google
     hasn't verified this app"* notice with a *Continue* link — acceptable for
     you and testers, worth clearing before a real launch.

---

## Part 4 — create the Desktop app client

8. Open **https://console.cloud.google.com/auth/clients/create**
   (or: ☰ → **Google Auth platform** → **Clients** → **Create client**).
9. **Check the project name in the top bar one more time** — the client must be
   created inside your website's project, not in some other one.
10. **Application type** → select **Desktop app**.
    - This is the part that matters. Not "Web application".
11. **Name** → e.g. `Soundwave desktop`. (This name is only shown inside the
    console; customers see the app name from the consent screen instead.)
12. Click **Create**.
13. The panel *"OAuth client created"* appears, showing the **Client ID** and
    **Client secret**, with a **Download JSON** button.
    - Click **Download JSON**. You get a file named like
      `client_secret_1234567890-abc123.apps.googleusercontent.com.json`.
    - (Lost it later? **Clients** → click the client → **Download JSON** /
      copy the two values again.)
    - Desktop clients have **no redirect URI to configure** — an empty field is
      correct. Do not add one.
14. Click **OK**.

---

## Part 5 — put the JSON in the two places

### A. This PC — so you can test right now (and on any machine you like)

Pick **one** of these. The first is the friendly one — it works for an installed
app, needs no admin rights, and survives app updates.

**Option 1 — your data folder (recommended).** Save the file, **renamed exactly
to** `youtube-client.json`, in:

```
%APPDATA%\Soundwave AI\youtube-client.json
```

Paste `%APPDATA%\Soundwave AI` into the Explorer address bar to get there — it
is the same folder the app keeps your settings and data in. Your own copy wins
over whatever a build shipped, and a broken copy there never hides a working
shipped one (the app just ignores it).

**Option 2 — source checkout.** Save it as:

```
Soundwave-Agent/desktop/config/youtube-client.json
```

then rebuild the app tree: `cd desktop && node assemble.mjs` — it prints
`[assemble] one-click YouTube client (config/youtube-client.json) …`. The file
is git-ignored, so it can never be committed by accident.

15. Restart the app — quit it from the tray (right-click the tray icon →
    Quit) and start it again — and open **gear → YouTube & Shorts**. The
    one-press card appears.
16. Quick check without launching: `node desktop/smoke.mjs` prints
    *"YouTube: the shipped Google client makes Connect YouTube a single
    press"*.

> **The app you installed before this change** (any build made before the data
> folder was read) only ever sees the client it was *packaged with*. For that
> copy you can paste the file into its install folder —
> `...\Programs\Soundwave AI\resources\app\app\config\youtube-client.json`
> (create the `config` folder) — and restart it. Works, but every app update
> wipes it, so treat it as a temporary trick and move on to a fresh build.

### B. GitHub — so every installer you ship has it

17. In GitHub: your repository → **Settings** → **Secrets and variables** →
    **Actions** → **New repository secret**. Add two, **exactly these names**:
    - `SOUNDWAVE_YOUTUBE_CLIENT_ID` → the `client_id` value from the JSON
      (ends in `.apps.googleusercontent.com`)
    - `SOUNDWAVE_YOUTUBE_CLIENT_SECRET` → the `client_secret` value from the
      JSON (starts with `GOCSPX-`)
18. That's it. The next release build bakes them in; the build log says
    *"Baked Soundwave's own Google client: Connect YouTube is one press in this
    build."* Until the secrets exist, builds simply show the honest fallback
    (paste your own client, 3 clicks) — nothing breaks.

> ⚠️ **Do Part 3 step 7 before you give a build to anyone — including yourself.**
> The client is baked in, but Google still asks *the consent screen* who may
> sign in. While it says **Testing**, only the Gmail addresses on the
> **Test users** list can connect; everybody else — you with a different
> account, every customer — lands on Google's page that reads
> **"Error 403: access_denied"** with an *Access blocked* heading.
> Two ways out on **https://console.cloud.google.com/auth/audience**:
> - **Right now (you):** *Test users* → **Add users** → the Gmail that owns the
>   channel → **Save**. Connect again — it works in seconds.
> - **For customers:** **Publish app** → **Confirm**. Then *any* Google account
>   can connect (they'll see *"Google hasn't verified this app"* → **Advanced**
>   → **Continue** until Google finishes the verification review — start that
>   review early if you're launching, and note the 100-user cap stays until
>   it's approved). Publishing also stops sign-ins from expiring every 7 days.

> Prefer the command line? `gh secret set SOUNDWAVE_YOUTUBE_CLIENT_ID` and
> `gh secret set SOUNDWAVE_YOUTUBE_CLIENT_SECRET` prompt you to paste each
> value, so it never appears in a shell history or a log.
> GitHub cannot show a secret again after saving — the JSON file is your master
> copy. Keep it.

---

## Part 6 — verify and connect

19. Open Soundwave AI → **gear** → **YouTube & Shorts**. You should now see:
    *"One press: sign in with Google and Soundwave can post your shorts.
    Nothing to set up in Google Cloud."* with a single **Connect YouTube**
    button. (If you still see the 3-click path, the JSON isn't in the place the
    app reads — check step 15/16, or that the GitHub secrets are set for a
    CI-built installer.)
20. Click **Connect YouTube** → your browser opens → pick the account that owns
    the channel → if Google shows *"Google hasn't verified this app"*, click
    **Continue** → **Allow** both permissions → the tab says *"YouTube is
    connected"* → the badge in Soundwave shows your channel name.
    - If the browser instead shows a Google page headed **Access blocked** or
      **Error 403: access_denied**, nothing is wrong with the app: that Google
      account isn't allowed to sign in yet. Do Part 3 step 7 (add it as a test
      user, or Publish app) and press **Connect YouTube** again.

---

## If something goes wrong

| What you see | What it means | Fix |
| --- | --- | --- |
| `redirect_uri_mismatch` | The client isn't a *Desktop app* — usually the website's Web client | Part 4: create a **Desktop app** client and use *its* JSON |
| Google's page headed **"Access blocked"** / **`Error 403: access_denied`** | App is in Testing and this Google account isn't on the test-users list (or the audience is *Internal*) | Part 3 step 7: add that Gmail under *Audience → Test users*, or **Publish app** — the page is Google's, so the app never even sees the attempt |
| Sign-in worked, uploads fail about a week later (`invalid_grant`) | Testing status expires refresh tokens after 7 days | Publish app (Part 3), or press Connect again |
| Uploads succeed but stay **Private** forever | New project hasn't passed YouTube's API audit | Download the MP4 and post in YouTube Studio, and request the audit at support.google.com/youtube/contact/yt_api_form |
| `quotaExceeded` after ~6 uploads in a day | Default 10,000 units/day; one upload costs 1,600 | Request a quota increase on the same audit form (or spread uploads across days) |
| Panel still shows the 3-click path | App didn't find the JSON, or CI secrets absent | Check `%APPDATA%\Soundwave AI\youtube-client.json` and `desktop/config/youtube-client.json` (then `node desktop/assemble.mjs`), or step 17 (GitHub) |

---

## Quick reference

- **Client type that works:** Desktop app.
- **Project:** reuse the website's — same consent screen, test users, API state.
- **Local file (your machine):** `%APPDATA%\Soundwave AI\youtube-client.json`
  — or `desktop/config/youtube-client.json` (git-ignored) for source builds.
- **GitHub secrets:** `SOUNDWAVE_YOUTUBE_CLIENT_ID`, `SOUNDWAVE_YOUTUBE_CLIENT_SECRET`.
- **Nothing to configure:** no redirect URIs, no JavaScript origins, no keys in
  code, no token copying.

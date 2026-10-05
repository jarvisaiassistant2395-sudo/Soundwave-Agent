# Set up "Connect Gmail" (about 5 minutes, once)

Gmail sign-in uses **the same Google OAuth client you already made for
YouTube** (`youtube-client.json`, see `SET_UP_YOUTUBE_ONECLICK.md`). You don't
need a new client or a new JSON file: you only switch on the Gmail API in that
same Google Cloud project and allow its permissions.

Soundwave asks for two Gmail permissions:

- `gmail.readonly`: read the inbox so the agent can summarise and answer questions.
- `gmail.compose`: create **drafts**. The agent never sends email by itself;
  you review the draft and send it.

---

## 1. Open the project that has your YouTube client

1. Go to https://console.cloud.google.com
2. In the project picker (top bar), select the project where you created the
   **Desktop app** client for YouTube.

## 2. Turn on the Gmail API

3. Open https://console.cloud.google.com/apis/library/gmail.googleapis.com
4. Click **Enable**. If the button says **Manage**, it's already on.

## 3. Add the Gmail permissions to the consent screen

5. ☰ → **Google Auth platform** → **Data access** → **Add or remove scopes**.
6. In the filter, search `gmail.readonly` and tick it, then search
   `gmail.compose` and tick it. Click **Update** → **Save**.

## 4. Allow your Google account

7. ☰ → **Google Auth platform** → **Audience**.
8. If **Publishing status** is **Testing**: under **Test users**, click
   **Add users** and add every Gmail address you want to connect. Click **Save**.
   - While the app is in Testing, Google ends each sign-in after 7 days, so you
     reconnect weekly. That's fine for you and testers.

## 5. Connect in Soundwave

9. Restart Soundwave (tray icon → Quit, then start it again).
10. Open the gear → **Email** → **Connect Gmail**.
11. Your browser opens Google's sign-in. Pick the account. On *"Google hasn't
    verified this app"*, click **Continue** (expected while it's your own
    unverified app), tick both Gmail permissions, and click **Continue**.
12. The browser says you can close it, and Settings → Email shows the
    connected address.

---

## If something goes wrong

| What you see | Fix |
|---|---|
| "Set up a Google OAuth client in Settings → YouTube & Shorts…" | The YouTube client JSON isn't installed on this PC. Put `youtube-client.json` in `%APPDATA%\Soundwave AI\` (step 5 of the YouTube guide). |
| `access_denied` / "app is being tested" | The Gmail address isn't a test user (step 8). |
| "Gmail request failed (403)…" | The Gmail API isn't enabled in **this** project (step 3/4), or you enabled it in a different project. |
| Missing permission after sign-in | You unticked a permission on Google's screen. Connect again and tick both. |
| "The Google OAuth client changed. Reconnect Gmail" | You replaced `youtube-client.json`. Connect Gmail again. |

## Before customers use it

`gmail.readonly` and `gmail.compose` are **restricted** scopes. For anyone
outside your test-user list, Google requires you to:

1. **Publish** the app (Audience → Publish app).
2. Pass **verification** for restricted scopes. This includes a privacy policy
   page, a short video of the app using Gmail, and an annual third-party
   security assessment (CASA), because Soundwave reads mail.

Until then, keep customers on the test-user list (up to 100 accounts), or treat
Gmail as a feature for you and testers only.

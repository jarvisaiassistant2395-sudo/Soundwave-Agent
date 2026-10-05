# Set up "Connect Google" for email (about 5 minutes, once)

Gmail sign-in uses **the same Google OAuth client you already made for
YouTube** (`youtube-client.json`, see `SET_UP_YOUTUBE_ONECLICK.md`). You don't
need a new client or a new JSON file: you only switch on the Gmail API in that
same Google Cloud project and allow its permissions.

Soundwave asks for two Gmail permissions, and offers three optional ones:

- `gmail.readonly`: read the inbox so the agent can summarise and answer questions.
- `gmail.compose`: save **drafts** and **send** the mail you ask it to send.
  Sending from chat has a switch and a daily cap in Settings → Email (25/day by
  default), everything it sends is listed there, and the same message isn't
  sent twice. Google's own permission covers both, so there is nothing extra to
  enable for it.
- `contacts.readonly`, `calendar.readonly`, `drive.readonly` (optional): let the
  agent resolve "email John" to John's address, read the next days of your
  calendar and find files on Drive. You can refuse these on Google's screen —
  the Email tab then shows them as not granted, and only email works.

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
   `gmail.compose` and tick it. Optionally also tick `contacts.readonly`,
   `calendar.readonly` and `drive.readonly` (contacts/calendar/Drive read
   access). Click **Update** → **Save**.

## 4. Allow your Google account

7. ☰ → **Google Auth platform** → **Audience**.
8. If **Publishing status** is **Testing**: under **Test users**, click
   **Add users** and add every Gmail address you want to connect. Click **Save**.
   - While the app is in Testing, Google ends each sign-in after 7 days, so you
     reconnect weekly. That's fine for you and testers.

## 5. Connect in Soundwave

9. Restart Soundwave (tray icon → Quit, then start it again).
10. Open the gear → **Email** → **Connect Google**.
11. Your browser opens Google's sign-in. Pick the account. On *"Google hasn't
    verified this app"*, click **Continue** (expected while it's your own
    unverified app), tick the permissions you want (Gmail at least; contacts,
    calendar and Drive are optional), and click **Continue**.
12. The browser says you can close it, and Settings → Email shows the
    connected address plus the permissions it has (`✓ Gmail`, `✓ Contacts`…).

---

## If something goes wrong

| What you see | Fix |
|---|---|
| "Set up a Google OAuth client in Settings → YouTube & Shorts…" | The YouTube client JSON isn't installed on this PC. Put `youtube-client.json` in `%APPDATA%\Soundwave AI\` (step 5 of the YouTube guide). |
| `access_denied` / "app is being tested" | The Gmail address isn't a test user (step 8). |
| "Gmail request failed (403)…" | The Gmail API isn't enabled in **this** project (step 3/4), or you enabled it in a different project. |
| Missing permission after sign-in | You unticked a permission on Google's screen. Connect again and tick the ones you want. |
| "Soundwave doesn't have permission to read your contacts/calendar/Drive" | That optional permission wasn't granted: reconnect Google and allow it, or keep going without it (email still works). |
| The agent refuses to send: "turned off in Settings" | The switch in Settings → Email is off. Turn it back on, or let it save a draft instead. |
| The agent refuses to send: "that's the N emails a day" | The daily cap was reached. Raise it in Settings → Email, or send tomorrow. |
| "The Google OAuth client changed. Reconnect Google" | You replaced `youtube-client.json`. Connect Google again. |

## Before customers use it

`gmail.readonly` and `gmail.compose` are **restricted** scopes. For anyone
outside your test-user list, Google requires you to:

1. **Publish** the app (Audience → Publish app).
2. Pass **verification** for restricted scopes. This includes a privacy policy
   page, a short video of the app using Gmail, and an annual third-party
   security assessment (CASA), because Soundwave reads mail.

Until then, keep customers on the test-user list (up to 100 accounts), or treat
Gmail as a feature for you and testers only.

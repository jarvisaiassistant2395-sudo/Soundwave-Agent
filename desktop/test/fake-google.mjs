// A stand-in for Google's sign-in endpoints on loopback, for e2e.mjs. The app
// is pointed at it with GOOGLE_OAUTH_AUTH_URL / GOOGLE_OAUTH_TOKEN_URL, so the
// welcome screen's "Continue with Google" can be finished end-to-end on a CI
// runner — where there is no Google, no browser session and nobody to press
// "Allow". It answers exactly what server/src/lib/googleSignIn.ts asks for:
//
//   GET  /auth     → 302 straight back to the app's own loopback callback with
//                    a code and the state it sent (a browser would land here)
//   POST /token    → an ID token for the account below: issuer, audience,
//                    expiry and email_verified all pass the server's checks
//                    (the signature is never verified — the code exchange over
//                    TLS is what vouches for it, which is why a stand-in is
//                    enough here)
//   GET  /userinfo → the same account, if a build ever asks without an ID token
//
//   node desktop/test/fake-google.mjs --port 4200     (runs until stopped)
import http from "node:http";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";

export const FAKE_GOOGLE_EMAIL = "e2e@soundwave.test";
export const FAKE_GOOGLE_NAME = "Soundwave E2E";

const b64url = (value) => Buffer.from(value).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** A three-part JWT the server's decodeIdToken()/profileFromIdToken() accept. */
function idTokenFor(clientId, { email, name, expired = false, unverified = false }) {
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: "https://accounts.google.com",
    aud: clientId,
    sub: "e2e-google-user",
    email,
    email_verified: !unverified,
    name,
    iat: now,
    exp: expired ? now - 60 : now + 3600,
  };
  return `${b64url(JSON.stringify({ alg: "none", typ: "JWT" }))}.${b64url(JSON.stringify(claims))}.`;
}

/**
 * @param {object} [options]
 * @param {string} [options.email]   the account the sign-in ends as
 * @param {string} [options.name]
 * @param {boolean} [options.refuse] answer the code exchange with "invalid_grant"
 * @param {string} [options.host]
 */
export async function startFakeGoogle({ email = FAKE_GOOGLE_EMAIL, name = FAKE_GOOGLE_NAME, refuse = false, host = "127.0.0.1" } = {}) {
  /** Every request, for the checks and for failure messages. */
  const seen = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${host}`);
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      seen.push({ method: req.method, path: url.pathname, query: url.searchParams, body: raw });
      const json = (status, body) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };

      // The authorization page, answered without asking anyone anything.
      if (req.method === "GET" && url.pathname === "/auth") {
        const redirectUri = url.searchParams.get("redirect_uri") ?? "";
        const state = url.searchParams.get("state") ?? "";
        if (!redirectUri) return json(400, { error: "invalid_request", error_description: "missing redirect_uri" });
        const back = new URL(redirectUri);
        back.searchParams.set("code", `fake-code-${crypto.randomBytes(6).toString("hex")}`);
        back.searchParams.set("state", state);
        res.writeHead(302, { location: back.toString() });
        res.end();
        return;
      }

      // The code exchange. client_secret is deliberately ignored: the stand-in
      // accepts any client the app was built with.
      if (req.method === "POST" && url.pathname === "/token") {
        if (refuse) return json(400, { error: "invalid_grant", error_description: "Bad Request" });
        const form = new URLSearchParams(raw);
        return json(200, {
          access_token: "ya29.fake-soundwave-e2e",
          expires_in: 3600,
          token_type: "Bearer",
          scope: "openid email profile",
          id_token: idTokenFor(form.get("client_id") ?? "", { email, name }),
        });
      }

      if (req.method === "GET" && url.pathname === "/userinfo") {
        return json(200, { sub: "e2e-google-user", email, email_verified: true, name });
      }

      json(404, { error: "not_found", path: url.pathname });
    });
  });

  await new Promise((resolve) => server.listen(0, host, resolve));
  const port = server.address().port;
  return {
    url: `http://${host}:${port}`,
    seen,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

// Standalone, for poking at it by hand: node desktop/test/fake-google.mjs
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const fake = await startFakeGoogle();
  console.log(`[fake-google] ${fake.url} — set GOOGLE_OAUTH_AUTH_URL=${fake.url}/auth and GOOGLE_OAUTH_TOKEN_URL=${fake.url}/token`);
}

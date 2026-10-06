// Signing in: the app asks for a sign-in, the person uses their browser, the
// app claims the session. Google is the fake on loopback, so the whole round
// trip — authorization URL, code exchange, ID token, claim, cookies — is real
// except for Google itself.
import fs from "node:fs";
import path from "node:path";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { startFakeGoogle, type FakeGoogle } from "./helpers/fakeGoogle.js";
import { setConfig } from "./helpers/config.js";

vi.hoisted(() => {
  process.env.DESKTOP_APP = "1";
  process.env.DATA_DIR = process.env.DATA_DIR ?? "/tmp/soundwave-test-data";
  // The build ships Soundwave's own Google app (`builtInYouTubeClient`).
  process.env.SOUNDWAVE_YOUTUBE_CLIENT_ID = "soundwave.apps.googleusercontent.com";
  process.env.SOUNDWAVE_YOUTUBE_CLIENT_SECRET = "soundwave-secret";
});

const DATA_DIR = process.env.DATA_DIR ?? "/tmp/soundwave-test-data";

/** No saved "own" OAuth client, so `client()` answers with the built-in one. */
function forgetSavedClient(): void {
  fs.rmSync(path.join(DATA_DIR, "youtube", "youtube_config.json"), { force: true });
}

/**
 * Pretend this build has no Google app of its own: no built-in client and no
 * saved one either (`client()` prefers a saved one).
 */
async function withoutGoogleApp<T>(fn: () => Promise<T> | T): Promise<T> {
  const id = process.env.SOUNDWAVE_YOUTUBE_CLIENT_ID;
  process.env.SOUNDWAVE_YOUTUBE_CLIENT_ID = "";
  forgetSavedClient();
  try {
    return await fn();
  } finally {
    process.env.SOUNDWAVE_YOUTUBE_CLIENT_ID = id;
    forgetSavedClient();
  }
}

let app: ReturnType<typeof import("../src/app.js").createApp>;
let fake: FakeGoogle;

const local = (req: request.Test) => req.set("Host", "127.0.0.1");

/** Everything the cookies in a response set, as a Cookie header. */
function cookieHeader(res: request.Response): string {
  const raw = res.headers["set-cookie"] as unknown as string[] | undefined;
  return (raw ?? []).map((c) => c.split(";")[0]!).join("; ");
}

/** Start a sign-in and walk it through the fake Google, as the browser would. */
async function signIn(options: { claim?: boolean } = {}) {
  const started = await local(request(app).post("/api/v1/auth/google/start"));
  expect(started.status).toBe(200);
  const query = new URL(started.body.url).searchParams;
  // Google sends the browser back to this server's own callback (a loopback
  // address is what a Desktop client allows — no registered URL needed).
  expect(query.get("redirect_uri")).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/api\/v1\/auth\/google\/callback$/);

  const back = await local(
    request(app)
      .get("/api/v1/auth/google/callback")
      .query({ state: query.get("state"), code: "4/test-code" }),
  );
  const claimed = options.claim === false
    ? null
    : await local(request(app).post("/api/v1/auth/google/claim").send({ loginId: started.body.loginId, secret: started.body.secret }));
  return { started, query, back, claimed };
}

beforeAll(async () => {
  fake = await startFakeGoogle();
  forgetSavedClient();
  const { config } = await import("../src/config.js");
  const { useFakeGoogle } = await import("./helpers/fakeGoogle.js");
  useFakeGoogle(config, fake);
  const { createApp } = await import("../src/app.js");
  app = createApp();
});

afterAll(async () => {
  await fake.close();
});

const store = await import("../src/lib/store.js");
const auth = await import("../src/lib/auth.js");
const { resetGoogleSignInForTests } = await import("../src/lib/googleSignIn.js");

beforeEach(async () => {
  fake.reset();
  forgetSavedClient();
  resetGoogleSignInForTests();
  for (const name of ["soundwave-test.json", "store.json", "brain.json"]) {
    try {
      fs.rmSync(path.join(DATA_DIR, name), { force: true });
    } catch {
      /* nothing saved */
    }
  }
  const fresh = new store.JsonStore();
  await fresh.init();
  store.setStoreForTests(fresh);
});

describe("starting a sign-in", () => {
  it("hands the app a Google address, a login id and a secret", async () => {
    const res = await local(request(app).post("/api/v1/auth/google/start"));
    expect(res.status).toBe(200);
    const authUrl = (await import("../src/config.js")).config.googleOAuthAuthUrl;
    const url = new URL(res.body.url);
    expect(url.origin + url.pathname).toBe(new URL(authUrl).origin + new URL(authUrl).pathname);
    const q = url.searchParams;
    expect(q.get("client_id")).toBe("soundwave.apps.googleusercontent.com");
    expect(q.get("response_type")).toBe("code");
    // Identity only: the first launch must not ask for upload rights.
    expect(q.get("scope")).toBe("openid email profile");
    expect(q.get("code_challenge_method")).toBe("S256");
    expect(q.get("code_challenge")).toBeTruthy();
    expect(q.get("state")).toBeTruthy();
    expect(res.body.loginId).toBeTruthy();
    expect(res.body.secret.length).toBeGreaterThan(20);
    expect(new Date(res.body.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it("says plainly when this build has no Google app of its own", async () => {
    await withoutGoogleApp(async () => {
      const res = await local(request(app).post("/api/v1/auth/google/start"));
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("NO_CLIENT");
      expect(res.body.error.message).toMatch(/OAuth client/);
      expect(res.body.error.message).toMatch(/Desktop app/);
      // And the app is told which providers exist, so its screen can explain.
      const providers = await local(request(app).get("/api/v1/auth/providers"));
      expect(providers.body).toMatchObject({ providers: { google: false } });
    });
  });

  it("never signs in anyone from another site's window", async () => {
    // Starting is harmless — it only builds a URL. The session can only come
    // from a claim, and only the app that started the sign-in holds the secret.
    const started = await local(request(app).post("/api/v1/auth/google/start"));
    const state = new URL(started.body.url).searchParams.get("state")!;
    await local(request(app).get("/api/v1/auth/google/callback").query({ state, code: "4/test-code" }));
    const claim = await request(app)
      .post("/api/v1/auth/google/claim")
      .set("Host", "127.0.0.1")
      .set("Origin", "https://evil.example")
      .send({ loginId: started.body.loginId, secret: "not-the-secret" });
    // Only the window that started the sign-in holds the secret, so another
    // site's page cannot take the session even knowing the login id.
    expect(claim.status).toBe(403);
    expect(cookieHeader(claim)).toBe("");
  });
});

describe("coming back from Google", () => {
  it("creates the account, then the app claims a signed-in session", async () => {
    const { back, claimed } = await signIn();
    // The browser sees a page it can act on, not JSON.
    expect(back.status).toBe(200);
    expect(back.headers["content-type"]).toContain("text/html");
    expect(back.text).toContain("Signed in as person@gmail.com");
    expect(back.text).toMatch(/Close this tab/);

    expect(claimed!.status).toBe(200);
    expect(claimed!.body.user).toMatchObject({ email: "person@gmail.com", name: "Soundwave Person", avatarUrl: "https://x.test/me.png" });
    // No emailVerified: a Google account's address is verified by Google.
    expect(claimed!.body.user.emailVerified).toBeUndefined();

    // The session cookies are on the claim, which is the app's own request.
    const cookies = cookieHeader(claimed!);
    expect(cookies).toContain("access_token=");
    expect(cookies).toContain("refresh_token=");
    expect(cookies).toContain("csrf_token=");
    const session = await local(request(app).get("/api/v1/auth/session").set("Cookie", cookies));
    expect(session.status).toBe(200);
    expect(session.body.email).toBe("person@gmail.com");
  });

  it("stores no password anywhere, and a session that never expires", async () => {
    const { claimed } = await signIn();
    const cookie = cookieHeader(claimed!).match(/refresh_token=([^;]+)/)![1]!;
    const claims = auth.verifyRefreshToken(decodeURIComponent(cookie))!;
    const db = await (await import("../src/lib/store.js")).getStore();
    const session = await db.findSessionById(claims.sid);
    expect(session!.expiresAt).toBeNull();

    const users = (await db.countUsers()) === 1;
    const user = await db.findUserByEmail("person@gmail.com");
    expect(users).toBe(true);
    expect(user).toBeTruthy();
    expect(Object.keys(user!)).not.toContain("passwordHash");
    expect(Object.keys(user!)).not.toContain("emailVerified");
    expect(Object.keys(user!)).not.toContain("passwordResetToken");

    // A permanent session still refreshes (rotation keeps it permanent).
    const refreshed = await local(request(app).post("/api/v1/auth/refresh").set("Cookie", cookieHeader(claimed!)).set("x-csrf-token", cookieHeader(claimed!).match(/csrf_token=([^;]+)/)![1]!));
    expect(refreshed.status).toBe(200);
    const rotated = auth.verifyRefreshToken(decodeURIComponent(cookieHeader(refreshed).match(/refresh_token=([^;]+)/)![1]!))!;
    const again = await db.findSessionById(rotated.sid);
    expect(again!.expiresAt).toBeNull();
  });

  it("signs the same person back into the same account", async () => {
    const first = await signIn();
    const firstUser = first.claimed!.body.user;
    const second = await signIn();
    expect(second.claimed!.body.user.id).toBe(firstUser.id);
    const db = await (await import("../src/lib/store.js")).getStore();
    expect(await db.countUsers()).toBe(1);
    // Signing out is the person's own act; the session goes with it.
    const signOut = await local(request(app).post("/api/v1/auth/signout").set("Cookie", cookieHeader(second.claimed!)).set("x-csrf-token", cookieHeader(second.claimed!).match(/csrf_token=([^;]+)/)![1]!));
    expect(signOut.status).toBe(200);
    expect((await local(request(app).get("/api/v1/auth/session").set("Cookie", cookieHeader(signOut)))).status).toBe(401);
  });

  it("keeps a name the person chose, and takes Google's only the first time", async () => {
    const first = await signIn();
    const db = await (await import("../src/lib/store.js")).getStore();
    await db.updateUser(first.claimed!.body.user.id, { name: "My own name" });
    fake.account.name = "Renamed On Google";
    const second = await signIn();
    expect(second.claimed!.body.user.name).toBe("My own name");
  });

  it("lets only the app that started it claim the session", async () => {
    const { started } = await signIn({ claim: false });
    const wrong = await local(request(app).post("/api/v1/auth/google/claim").send({ loginId: started.body.loginId, secret: "not-the-secret" }));
    expect(wrong.status).toBe(403);
    const unknown = await local(request(app).post("/api/v1/auth/google/claim").send({ loginId: "no-such-login", secret: started.body.secret }));
    expect(unknown.status).toBe(409);
    // Once claimed, it cannot be claimed again by anyone.
    const good = await local(request(app).post("/api/v1/auth/google/claim").send({ loginId: started.body.loginId, secret: started.body.secret }));
    expect(good.status).toBe(200);
    const again = await local(request(app).post("/api/v1/auth/google/claim").send({ loginId: started.body.loginId, secret: started.body.secret }));
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("CLAIMED");
  });

  it("says 'still waiting' until Google has come back", async () => {
    const started = await local(request(app).post("/api/v1/auth/google/start"));
    const waiting = await local(request(app).get("/api/v1/auth/google/wait").query({ loginId: started.body.loginId, secret: started.body.secret }));
    expect(waiting.body).toEqual({ state: "pending" });
    const wrong = await local(request(app).get("/api/v1/auth/google/wait").query({ loginId: started.body.loginId, secret: "nope" }));
    expect(wrong.body).toEqual({ state: "unknown" });
  });

  it("refuses a callback with a state nobody started", async () => {
    const res = await local(request(app).get("/api/v1/auth/google/callback").query({ state: "made-up", code: "x" }));
    expect(res.status).toBe(400);
    expect(res.text).toMatch(/sign-in/i);
  });

  it("explains a cancellation, and can be tried again", async () => {
    const started = await local(request(app).post("/api/v1/auth/google/start"));
    const state = new URL(started.body.url).searchParams.get("state")!;
    const denied = await local(request(app).get("/api/v1/auth/google/callback").query({ state, error: "access_denied" }));
    expect(denied.status).toBe(400);
    expect(denied.text).toMatch(/Cancel|blocked/);
    const claim = await local(request(app).post("/api/v1/auth/google/claim").send({ loginId: started.body.loginId, secret: started.body.secret }));
    expect(claim.status).toBe(409);
    expect(claim.body.error.code).toBe("ACCESS_DENIED");
  });
});

describe("the account Google hands over", () => {
  it("refuses an ID token meant for another client", async () => {
    fake.account.wrongAudience = true;
    const { back } = await signIn({ claim: false });
    expect(back.status).toBe(400);
    expect(back.text).toMatch(/check out/);
  });

  it("refuses an expired ID token", async () => {
    fake.account.expired = true;
    const { back } = await signIn({ claim: false });
    expect(back.status).toBe(400);
  });

  it("refuses an address Google has not verified", async () => {
    fake.account.emailVerified = false;
    const { back } = await signIn({ claim: false });
    expect(back.status).toBe(400);
  });

  it("falls back to Google's userinfo when no ID token came back", async () => {
    fake.account.idToken = false;
    const { back, claimed } = await signIn();
    expect(back.status).toBe(200);
    expect(claimed!.status).toBe(200);
    expect(claimed!.body.user.email).toBe("person@gmail.com");
    const used = fake.seen.find((s) => s.path === "/v1/userinfo" || s.path.endsWith("v1/userinfo"));
    expect(used).toBeTruthy();
  });
});

describe("development without a Google app", () => {
  it("can open the app locally, but only in a dev build with no client", async () => {
    await withoutGoogleApp(async () => {
      const res = await local(request(app).post("/api/v1/auth/dev-session"));
      expect(res.status).toBe(200);
      expect(res.body.development).toBe(true);
      const session = await local(request(app).get("/api/v1/auth/session").set("Cookie", cookieHeader(res)));
      expect(session.body.email).toBe("dev@soundwave.local");
      expect(session.body.emailVerified).toBeUndefined();
    });
    // …and the same route refuses once Google is configured (the real app).
    expect((await local(request(app).post("/api/v1/auth/dev-session"))).status).toBe(404);
  });

  it("never opens a packaged build, even one with no Google app in it", async () => {
    const restore = setConfig("isProd", true);
    try {
      await withoutGoogleApp(async () => {
        // No Google app at all, and still: a shipped build only opens with Google.
        expect((await local(request(app).post("/api/v1/auth/dev-session"))).status).toBe(404);
        const providers = await local(request(app).get("/api/v1/auth/providers"));
        expect(providers.body).toMatchObject({ providers: { google: false }, devSignIn: false });
      });
    } finally {
      restore();
    }
  });
});

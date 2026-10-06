import { beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import fs from "node:fs";
import { createApp } from "../src/app.js";
import { config } from "../src/config.js";
import { JsonStore, setStoreForTests } from "../src/lib/store.js";
import { createUserSession, signAccessToken } from "../src/lib/auth.js";

let app: ReturnType<typeof createApp>;
let cookie = "";

function csrfFromCookies(cookies: string): string {
  const m = cookies.match(/csrf_token=([^;]+)/);
  return m ? decodeURIComponent(m[1]!) : "";
}

beforeAll(async () => {
  fs.rmSync("/tmp/soundwave-test-data", { recursive: true, force: true });
  const store = new JsonStore();
  await store.init();
  setStoreForTests(store);
  app = createApp();
  // The session a signed-in Google account has (how it is obtained end to end
  // is google_signin.test.ts; here we just need one to exercise the API with).
  const user = await store.createUser({ email: "flow@example.com", name: "Test User" });
  const bundle = await createUserSession(store, user.id, "127.0.0.1", "vitest");
  cookie = `access_token=${signAccessToken(user.id)}; refresh_token=${encodeURIComponent(bundle.refreshToken)}; csrf_token=test-csrf`;
});

describe("the account", () => {
  it("returns the session for a signed-in cookie", async () => {
    const res = await request(app).get("/api/v1/auth/session").set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(res.body.email).toBe("flow@example.com");
    // A Google account: no password, no email-verification state to report.
    expect(res.body.passwordHash).toBeUndefined();
    expect(res.body.emailVerified).toBeUndefined();
  });

  it("has no password sign-in, sign-up or reset left", async () => {
    const gone = ["/api/v1/auth/signin", "/api/v1/auth/signup", "/api/v1/auth/forgot-password", "/api/v1/auth/reset-password", "/api/v1/auth/verify-email", "/api/v1/auth/resend-verification"];
    for (const path of gone) {
      const res = await request(app).post(path).send({ email: "flow@example.com", password: "Str0ng!Pass1" });
      expect([404, 400], `${path} should be gone`).toContain(res.status);
      expect(res.status).toBe(404);
    }
  });

  it("has no password change or password-guarded deletion left", async () => {
    const change = await request(app).put("/api/v1/user/password").set("Cookie", cookie).set("X-CSRF-Token", csrfFromCookies(cookie)).send({ currentPassword: "x", newPassword: "Yy1!aaaa" });
    expect(change.status).toBe(404);
  });
});

describe("quota enforcement", () => {
  it("reports usage and enforces the FREE 10k limit", async () => {
    const csrf = csrfFromCookies(cookie);
    const res = await request(app)
      .post("/api/v1/tts/usage")
      .set("Cookie", cookie)
      .set("X-CSRF-Token", csrf)
      .send({ voiceId: "af_heart", characterCount: 9_500, audioDurationSeconds: 120 });
    expect(res.status).toBe(200);
    expect(res.body.allowed).toBe(true);

    // Exceeds the remaining 500.
    const over = await request(app)
      .post("/api/v1/tts/usage")
      .set("Cookie", cookie)
      .set("X-CSRF-Token", csrf)
      .send({ voiceId: "af_heart", characterCount: 1_000, audioDurationSeconds: 10 });
    expect(over.status).toBe(403);
    expect(over.body.code).toBe("QUOTA_EXCEEDED");
    expect(over.body.allowed).toBe(false);
  });

  it("rejects a usage report without CSRF token", async () => {
    const res = await request(app)
      .post("/api/v1/tts/usage")
      .set("Cookie", cookie)
      .send({ voiceId: "af_heart", characterCount: 100, audioDurationSeconds: 2 });
    expect(res.status).toBe(403);
  });

  it("caps a single usage report at 10,000 characters", async () => {
    const res = await request(app)
      .post("/api/v1/tts/usage")
      .set("Cookie", cookie)
      .set("X-CSRF-Token", csrfFromCookies(cookie))
      .send({ voiceId: "af_heart", characterCount: 999_999, audioDurationSeconds: 2 });
    expect(res.status).toBe(400);
  });
});

describe("voice cloning (sidecar not configured in tests)", () => {
  it("reports clone status as unavailable when VOICECLONE_URL is unset", async () => {
    const res = await request(app).get("/api/v1/tts/clone/status").set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ configured: false, available: false });
  });

  it("requires auth for clone status", async () => {
    const res = await request(app).get("/api/v1/tts/clone/status");
    expect(res.status).toBe(401);
  });

  it("blocks clone-profile creation unless explicit voice rights are confirmed", async () => {
    const res = await request(app)
      .post("/api/v1/tts/clone/profiles")
      .set("Cookie", cookie)
      .set("X-CSRF-Token", csrfFromCookies(cookie))
      .field("name", "Unconsented voice");
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("CLONE_CONSENT_REQUIRED");
  });

  it("returns a friendly 503 from /tts/clone when not configured", async () => {
    const res = await request(app)
      .post("/api/v1/tts/clone")
      .set("Cookie", cookie)
      .set("X-CSRF-Token", csrfFromCookies(cookie))
      .send({ text: "hello there", profileId: "abc-123" });
    expect(res.status).toBe(503);
    expect(JSON.stringify(res.body)).toContain("VOICECLONE_NOT_CONFIGURED");
  });

  it("validates the clone request body", async () => {
    const res = await request(app)
      .post("/api/v1/tts/clone")
      .set("Cookie", cookie)
      .set("X-CSRF-Token", csrfFromCookies(cookie))
      .send({ text: "", profileId: "" });
    expect(res.status).toBe(400);
  });
});

describe("voice cloning in the desktop app (no sign-in)", () => {
  const c = config as { desktopApp: boolean };
  const withDesktop = async (fn: () => Promise<void>) => {
    const before = c.desktopApp;
    c.desktopApp = true;
    try {
      await fn();
    } finally {
      c.desktopApp = before;
    }
  };

  it("answers clone status without a session", () =>
    withDesktop(async () => {
      const res = await request(app).get("/api/v1/tts/clone/status").set("Host", "127.0.0.1:4000");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ configured: false, available: false });
    }));

  it("reaches the clone checks (not a sign-in error) when creating a profile", () =>
    withDesktop(async () => {
      const res = await request(app)
        .post("/api/v1/tts/clone/profiles")
        .set("Host", "127.0.0.1:4000")
        .field("name", "My voice");
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("CLONE_CONSENT_REQUIRED");
    }));

  it("reaches the engine (not a sign-in error) when synthesizing", () =>
    withDesktop(async () => {
      const res = await request(app)
        .post("/api/v1/tts/clone")
        .set("Host", "127.0.0.1:4000")
        .send({ text: "hello there", profileId: "abc-123" });
      expect(res.status).toBe(503);
      expect(JSON.stringify(res.body)).toContain("VOICECLONE_NOT_CONFIGURED");
    }));

  it("refuses other websites", () =>
    withDesktop(async () => {
      const res = await request(app)
        .post("/api/v1/tts/clone/profiles")
        .set("Host", "127.0.0.1:4000")
        .set("Origin", "https://evil.example")
        .field("name", "Stolen voice")
        .field("consent", "true");
      expect(res.status).toBe(403);
    }));

  it("falls back to the local profile when a leftover login cookie is stale", () =>
    withDesktop(async () => {
      const res = await request(app)
        .get("/api/v1/tts/clone/status")
        .set("Host", "127.0.0.1:4000")
        .set("Cookie", "access_token=expired.or.bogus; refresh_token=bogus");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ configured: false, available: false });
    }));

  it("still CSRF-checks a signed-in session", () =>
    withDesktop(async () => {
      const res = await request(app)
        .post("/api/v1/tts/clone")
        .set("Host", "127.0.0.1:4000")
        .set("Cookie", cookie)
        .send({ text: "hello there", profileId: "abc-123" });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("CSRF_FAILED");
    }));
});

describe("projects", () => {
  it("blocks cloud save for FREE users", async () => {
    const res = await request(app)
      .post("/api/v1/projects")
      .set("Cookie", cookie)
      .set("X-CSRF-Token", csrfFromCookies(cookie))
      .send({ title: "P", type: "TTS", textContent: "hi", voiceId: "af_heart", voiceSettings: {}, characterCount: 2 });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("PLAN_REQUIRED");
  });

  it("lists Microsoft Neural voices with sample URLs", async () => {
    const res = await request(app).get("/api/v1/voices");
    expect(res.status).toBe(200);
    expect(res.body.voices.length).toBe(10);
    // The most natural (Multilingual) generation is listed first, like the app's picker.
    expect(res.body.voices[0].id).toBe("en-US-AvaMultilingualNeural");
    expect(res.body.voices.map((v: { id: string }) => v.id)).toContain("en-US-JennyNeural");
    expect(res.body.voices[0].sampleUrl).toContain("/voice-samples/");
  });
});

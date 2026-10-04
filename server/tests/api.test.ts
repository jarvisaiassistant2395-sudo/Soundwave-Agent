import { beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import fs from "node:fs";
import { createApp } from "../src/app.js";
import { JsonStore, setStoreForTests } from "../src/lib/store.js";

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
});

describe("auth flow", () => {
  it("signs up a user and returns session cookies", async () => {
    const res = await request(app)
      .post("/api/v1/auth/signup")
      .send({ name: "Test User", email: "flow@example.com", password: "Str0ng!Pass1" });
    expect(res.status).toBe(201);
    expect(res.body.user.email).toBe("flow@example.com");
    expect(res.body.user.plan).toBe("FREE");
    const setCookie = (res.headers["set-cookie"] ?? []) as string[];
    expect(setCookie.some((c) => c.startsWith("access_token="))).toBe(true);
    expect(setCookie.some((c) => c.startsWith("refresh_token="))).toBe(true);
    expect(setCookie.some((c) => c.startsWith("csrf_token="))).toBe(true);
    cookie = setCookie.map((c) => c.split(";")[0]).join("; ");
  });

  it("rejects duplicate signup", async () => {
    const res = await request(app)
      .post("/api/v1/auth/signup")
      .send({ name: "Test User", email: "flow@example.com", password: "Str0ng!Pass1" });
    expect(res.status).toBe(409);
  });

  it("rejects weak passwords", async () => {
    const res = await request(app)
      .post("/api/v1/auth/signup")
      .send({ name: "X", email: "weak@example.com", password: "password" });
    expect(res.status).toBe(400);
  });

  it("returns the session for an authenticated cookie", async () => {
    const res = await request(app).get("/api/v1/auth/session").set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(res.body.email).toBe("flow@example.com");
  });

  it("signs in with valid credentials", async () => {
    const res = await request(app)
      .post("/api/v1/auth/signin")
      .send({ email: "flow@example.com", password: "Str0ng!Pass1" });
    expect(res.status).toBe(200);
  });

  it("returns generic error for unknown email", async () => {
    const res = await request(app)
      .post("/api/v1/auth/signin")
      .send({ email: "nobody@example.com", password: "whatever1" });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("INVALID_CREDENTIALS");
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

import { beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import fs from "node:fs";
import { createApp } from "../src/app.js";
import { JsonStore, setStoreForTests } from "../src/lib/store.js";

// Stub out the real provider HTTP calls — we test the callback logic, not
// Google's servers.
vi.mock("../src/lib/oauth.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../src/lib/oauth.js")>();
  return {
    ...orig,
    exchangeGoogleCode: vi.fn(async () => ({ email: "oauth@example.com", name: "OAuth User", avatarUrl: "https://x.test/a.png" })),
  };
});

let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  fs.rmSync("/tmp/soundwave-test-data", { recursive: true, force: true });
  const store = new JsonStore();
  await store.init();
  setStoreForTests(store);
  app = createApp();
});

describe("OAuth flow", () => {
  it("reports provider availability so the UI can hide unconfigured buttons", async () => {
    const res = await request(app).get("/api/v1/auth/providers");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ providers: { google: false } }); // no creds in the test env
  });

  it("redirects to not_configured when no credentials are set", async () => {
    const res = await request(app).get("/api/v1/auth/oauth/google");
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain("/oauth/callback?error=not_configured");
  });

  it("redirects state mismatch to error=state_mismatch", async () => {
    const res = await request(app)
      .get("/api/v1/auth/oauth/google/callback?code=fake&state=WRONG")
      .set("Cookie", "oauth_state=RIGHT");
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain("error=state_mismatch");
  });

  it("redirects a provider denial to error=cancelled", async () => {
    const res = await request(app).get("/api/v1/auth/oauth/google/callback?error=access_denied");
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain("error=cancelled");
  });

  it("completes a Google sign-in: creates an email-verified user and sets cookies", async () => {
    const res = await request(app)
      .get("/api/v1/auth/oauth/google/callback?code=fake&state=ST1")
      .set("Cookie", "oauth_state=ST1");
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain("/oauth/callback");

    const setCookie = (res.headers["set-cookie"] ?? []) as string[];
    const cookie = setCookie.map((c) => c.split(";")[0]).join("; ");
    expect(cookie).toContain("access_token=");

    const session = await request(app).get("/api/v1/auth/session").set("Cookie", cookie);
    expect(session.status).toBe(200);
    expect(session.body.email).toBe("oauth@example.com");
    expect(session.body.emailVerified).toBe(true);
    expect(session.body.avatarUrl).toBe("https://x.test/a.png");
  });

  it("links an existing account by email instead of duplicating", async () => {
    // Sign up the same email via password first.
    await request(app)
      .post("/api/v1/auth/signup")
      .send({ name: "Existing", email: "linked@example.com", password: "Str0ng!Pass1" });

    const { exchangeGoogleCode } = await import("../src/lib/oauth.js");
    vi.mocked(exchangeGoogleCode).mockResolvedValueOnce({ email: "linked@example.com", name: "OAuth User", avatarUrl: null });

    const res = await request(app)
      .get("/api/v1/auth/oauth/google/callback?code=fake&state=ST2")
      .set("Cookie", "oauth_state=ST2");
    expect(res.status).toBe(302);

    const setCookie = (res.headers["set-cookie"] ?? []) as string[];
    const cookie = setCookie.map((c) => c.split(";")[0]).join("; ");
    const session = await request(app).get("/api/v1/auth/session").set("Cookie", cookie);
    expect(session.status).toBe(200);
    expect(session.body.email).toBe("linked@example.com");
    expect(session.body.name).toBe("Existing"); // existing user is preserved
  });

  it("rejects unknown OAuth providers", async () => {
    const res = await request(app).get("/api/v1/auth/oauth/github");
    expect(res.status).toBe(400);
    const cb = await request(app).get("/api/v1/auth/oauth/github/callback?code=fake&state=ST3");
    expect(cb.status).toBe(400);
  });
});

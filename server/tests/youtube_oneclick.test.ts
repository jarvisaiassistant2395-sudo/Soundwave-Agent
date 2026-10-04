// "Connect YouTube" the comfortable way: a build that ships Soundwave's own
// Google app (SOUNDWAVE_YOUTUBE_CLIENT_* → one button, no Google Cloud), the
// one-box paste import for builds that don't, and the honest "connect again"
// state when the client behind a saved sign-in changes.
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { startFakeGoogle, useFakeGoogle, type FakeGoogle } from "./helpers/fakeGoogle.js";

vi.hoisted(() => {
  process.env.DESKTOP_APP = "1";
});

const { config } = await import("../src/config.js");
const { createApp } = await import("../src/app.js");
const { JsonStore, setStoreForTests } = await import("../src/lib/store.js");
const { builtInYouTubeClient, extractOAuthClient, youtubeService } = await import("../src/lib/youtube.js");
const oauth = await import("../src/lib/youtubeOAuth.js");

const BUILT_IN_ID = "999-soundwave.apps.googleusercontent.com";
const BUILT_IN_SECRET = "GOCSPX-soundwave-built-in";
const OWN_ID = "123-mine.apps.googleusercontent.com";
const OWN_SECRET = "GOCSPX-my-own-secret";

let fake: FakeGoogle;
let app: ReturnType<typeof createApp>;
const local = (req: request.Test) => req.set("Host", "127.0.0.1");

const withBuiltIn = () => {
  process.env.SOUNDWAVE_YOUTUBE_CLIENT_ID = BUILT_IN_ID;
  process.env.SOUNDWAVE_YOUTUBE_CLIENT_SECRET = BUILT_IN_SECRET;
};
const status = async () => (await request(app).get("/api/v1/youtube/status")).body;

/** Press Connect and let the fake Google send the browser back. */
async function signIn(): Promise<URLSearchParams> {
  const start = await local(request(app).post("/api/v1/youtube/connect"));
  expect(start.status).toBe(200);
  const q = new URL(start.body.url).searchParams;
  const back = await request(app).get(`/?state=${encodeURIComponent(q.get("state")!)}&code=4%2Fauth-code&scope=youtube`);
  expect(back.status).toBe(200);
  return q;
}

beforeAll(async () => {
  fake = await startFakeGoogle();
  useFakeGoogle(config as unknown as Record<string, unknown>, fake);
  fs.rmSync(config.dataDir, { recursive: true, force: true });
  const store = new JsonStore();
  await store.init();
  setStoreForTests(store);
  app = createApp();
});

afterAll(async () => {
  await fake.close();
  delete process.env.SOUNDWAVE_YOUTUBE_CLIENT_ID;
  delete process.env.SOUNDWAVE_YOUTUBE_CLIENT_SECRET;
});

beforeEach(() => {
  fake.reset();
  oauth.resetYouTubeConnectForTests();
  fs.rmSync(path.join(config.dataDir, "youtube"), { recursive: true, force: true });
  delete process.env.SOUNDWAVE_YOUTUBE_CLIENT_ID;
  delete process.env.SOUNDWAVE_YOUTUBE_CLIENT_SECRET;
});

describe("pasting a Google client (what people really have in their clipboard)", () => {
  it("reads the downloaded client_secret_….json, a web client, or the two values", () => {
    const downloaded = JSON.stringify({
      installed: { client_id: OWN_ID, client_secret: OWN_SECRET, redirect_uris: ["http://localhost"] },
    });
    expect(extractOAuthClient(downloaded)).toEqual({ clientId: OWN_ID, clientSecret: OWN_SECRET });
    expect(extractOAuthClient(JSON.stringify({ web: { client_id: OWN_ID, client_secret: OWN_SECRET } }))).toEqual({
      clientId: OWN_ID,
      clientSecret: OWN_SECRET,
    });
    expect(extractOAuthClient(`${OWN_ID}\n${OWN_SECRET}`)).toEqual({ clientId: OWN_ID, clientSecret: OWN_SECRET });
    expect(extractOAuthClient(`Client ID: ${OWN_ID}\nSecret: ${OWN_SECRET}`)).toEqual({ clientId: OWN_ID, clientSecret: OWN_SECRET });
    expect(extractOAuthClient("")).toBeNull();
    expect(extractOAuthClient("just some words")).toBeNull();
    expect(extractOAuthClient(JSON.stringify({ installed: { client_id: OWN_ID } }))).toBeNull();
  });

  it("takes it in one box and saves both halves", async () => {
    const res = await request(app)
      .post("/api/v1/youtube/config")
      .send({ clientJson: JSON.stringify({ installed: { client_id: OWN_ID, client_secret: OWN_SECRET } }) });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, hasClientId: true, hasClientSecret: true, clientSource: "own" });
    expect(youtubeService.getConfig().clientId).toBe(OWN_ID);

    const bad = await request(app).post("/api/v1/youtube/config").send({ clientJson: "I don't know what this is" });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe("BAD_CLIENT_JSON");
  });
});

describe("a build that ships Soundwave's own Google app", () => {
  it("shows one-click mode and connects without the person filling anything in", async () => {
    withBuiltIn();
    expect(builtInYouTubeClient()).toEqual({ clientId: BUILT_IN_ID, clientSecret: BUILT_IN_SECRET });
    expect(await status()).toMatchObject({ connected: false, oneClick: true, clientSource: "built-in", hasClientId: false });

    const q = await signIn();
    expect(q.get("client_id")).toBe(BUILT_IN_ID);
    expect(q.get("code_challenge_method")).toBe("S256");
    const exchange = Object.fromEntries(new URLSearchParams(fake.seen.find((s) => s.path === "/token")!.raw));
    expect(exchange).toMatchObject({ client_id: BUILT_IN_ID, client_secret: BUILT_IN_SECRET, grant_type: "authorization_code" });

    expect(await status()).toMatchObject({ connected: true, oneClick: true, channelTitle: "Orbit Facts", clientSource: "built-in" });
    // The customer never typed a client ID: it stays empty in their settings.
    expect(youtubeService.getConfig().clientId).toBe("");
    expect(youtubeService.getConfig().refreshToken).toBe("1//fake-refresh-token");
  });

  it("still lets someone who made their own client use it instead", async () => {
    withBuiltIn();
    const saved = await request(app).post("/api/v1/youtube/config").send({ clientId: OWN_ID, clientSecret: OWN_SECRET });
    expect(saved.body).toMatchObject({ oneClick: false, clientSource: "own" });

    expect(builtInYouTubeClient()).toEqual({ clientId: BUILT_IN_ID, clientSecret: BUILT_IN_SECRET });
    expect(await status()).toMatchObject({ oneClick: false, clientSource: "own" });
    const q = await signIn();
    expect(q.get("client_id")).toBe(OWN_ID);
  });

  it("asks for a reconnect when the client behind the saved sign-in changes", async () => {
    withBuiltIn();
    await signIn();
    expect(await status()).toMatchObject({ connected: true, needsReconnect: false });

    // They paste their own client later: the saved token belongs to Soundwave's app.
    await request(app).post("/api/v1/youtube/config").send({ clientId: OWN_ID, clientSecret: OWN_SECRET });
    expect(await status()).toMatchObject({ connected: false, needsReconnect: true, clientSource: "own" });
  });

  it("refuses honestly when a build has neither Soundwave's app nor a pasted client", async () => {
    const res = await local(request(app).post("/api/v1/youtube/connect"));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("NO_CLIENT");
    expect(res.body.error.message).toMatch(/Advanced: your own Google Cloud project/);
  });
});

describe("the guide behind “walk me through it”", () => {
  it("is one press in one-click mode, and four short steps otherwise", async () => {
    const manual = await request(app).get("/api/v1/youtube/oauth-guide");
    expect(manual.body.mode).toBe("own-client");
    expect(manual.body.steps).toHaveLength(4);
    expect(manual.body.requiredScopes).toContain("https://www.googleapis.com/auth/youtube.upload");
    expect(manual.body.links.createClient).toMatch(/console\.cloud\.google\.com\/auth\/clients\/create/);
    expect(manual.body.headline).toMatch(/two minutes/);

    withBuiltIn();
    const oneClick = await request(app).get("/api/v1/youtube/oauth-guide");
    expect(oneClick.body.mode).toBe("one-click");
    expect(oneClick.body.steps).toHaveLength(3);
    expect(oneClick.body.headline).toMatch(/one press/i);
    expect(oneClick.body.steps[0]).toMatch(/Connect YouTube/);
  });
});

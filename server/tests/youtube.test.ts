import { beforeAll, describe, it, expect } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { JsonStore, setStoreForTests } from "../src/lib/store.js";
import { youtubeService } from "../src/lib/youtube.js";

let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  const store = new JsonStore();
  await store.init();
  setStoreForTests(store);
  app = createApp();
});

describe("YouTube Data API v3 & Auto-Publish Service", () => {
  it("reads YouTube integration status", async () => {
    const res = await request(app).get("/api/v1/youtube/status");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("configured");
    expect(res.body).toHaveProperty("autoPublish");
    expect(res.body).toHaveProperty("defaultPrivacy");
  });

  it("saves YouTube credentials and auto-publish preference", async () => {
    const res = await request(app)
      .post("/api/v1/youtube/config")
      .send({
        clientId: "test-client-id-123.apps.googleusercontent.com",
        clientSecret: "test-client-secret-abc",
        refreshToken: "test-refresh-token-xyz",
        autoPublish: true,
        defaultPrivacy: "unlisted",
        defaultTags: ["minecraft", "shorts", "gaming"],
      });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.status.configured).toBe(true);
    expect(res.body.status.autoPublish).toBe(true);
    expect(res.body.status.defaultPrivacy).toBe("unlisted");

    const cfg = youtubeService.getConfig();
    expect(cfg.clientId).toBe("test-client-id-123.apps.googleusercontent.com");
    expect(cfg.autoPublish).toBe(true);
  });

  it("serves OAuth setup guide documentation", async () => {
    const res = await request(app).get("/api/v1/youtube/oauth-guide");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("steps");
    expect(Array.isArray(res.body.steps)).toBe(true);
    expect(res.body.requiredScopes).toContain("https://www.googleapis.com/auth/youtube.upload");
  });
});

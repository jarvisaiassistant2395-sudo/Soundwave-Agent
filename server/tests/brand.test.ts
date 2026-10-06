// ── The look of a person's clips ─────────────────────────────────────────────
// The caption style used to be a constant in the clip renderer. What matters
// now: the presets are real differences, the person's colours survive a save
// and a reload, a nonsense colour or style is refused rather than half-applied,
// and the style the renderer is handed is the same one the preview shows.
import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { JsonStore, setStoreForTests } from "../src/lib/store.js";
import { CAPTION_STYLES, DEFAULT_BRAND, captionStyleFor, loadBrand, resetBrandForTests, saveBrand } from "../src/lib/brand.js";

const app = createApp();

beforeEach(async () => {
  const store = new JsonStore();
  await store.init();
  setStoreForTests(store);
  resetBrandForTests();
});

afterAll(() => {
  resetBrandForTests();
});

describe("the brand kit", () => {
  it("starts at the house look", () => {
    const brand = loadBrand();
    expect(brand.captionStyle).toBe("house");
    expect(brand.captionColor).toBe("#FFFFFF");
    const style = captionStyleFor(brand);
    expect(style.strokeEnabled).toBe(true);
    expect(style.vAlign).toBe("middle");
  });

  it("serves the presets and the applied style together", async () => {
    const res = await request(app).get("/api/v1/brand");
    expect(res.status).toBe(200);
    expect(res.body.styles.map((s: { id: string }) => s.id)).toEqual(["house", "bold", "boxed", "karaoke", "minimal"]);
    expect(res.body.applied.color).toBe("#FFFFFF");
    expect(res.body.defaults).toMatchObject(DEFAULT_BRAND);
  });

  it("keeps the outline on every preset except the boxed one", () => {
    for (const preset of CAPTION_STYLES) {
      const style = captionStyleFor({ ...DEFAULT_BRAND, captionStyle: preset.id });
      if (preset.id === "boxed") {
        expect(style.strokeEnabled).toBe(false);
        expect(style.bgOpacity).toBeGreaterThan(0);
      } else {
        expect(style.strokeEnabled).toBe(true);
        expect(style.strokeWidth).toBeGreaterThan(0);
      }
    }
  });

  it("uses the accent colour where a style wants one, and the words' colour everywhere", () => {
    const karaoke = captionStyleFor({ ...DEFAULT_BRAND, captionStyle: "karaoke", captionColor: "#FFEE00", accentColor: "#FF00AA" });
    expect(karaoke.color).toBe("#FFEE00");
    expect(karaoke.strokeColor).toBe("#FF00AA");

    // A style that doesn't want an accent keeps the black outline.
    const plain = captionStyleFor({ ...DEFAULT_BRAND, captionStyle: "bold", captionColor: "#FFEE00", accentColor: "#FF00AA" });
    expect(plain.strokeColor).toBe("#000000");
  });

  it("saves, reloads and applies a chosen look over the API", async () => {
    const put = await request(app).put("/api/v1/brand").send({ captionStyle: "boxed", captionColor: "#12ab34", accentColor: "#ff0", name: "Space Facts" });
    expect(put.status).toBe(200);
    expect(put.body.brand).toMatchObject({ captionStyle: "boxed", captionColor: "#12AB34", accentColor: "#FFFF00", name: "Space Facts" });
    // Three-digit shorthand is expanded for the renderer.
    expect(put.body.applied.bgOpacity).toBeGreaterThan(0);

    // What the next render is handed comes from the file, not from memory.
    const again = await request(app).get("/api/v1/brand");
    expect(again.body.brand.captionStyle).toBe("boxed");
    expect(again.body.applied.color).toBe("#12AB34");
  });

  it("refuses a colour or style it can't draw, without losing the rest", () => {
    saveBrand({ captionStyle: "bold", captionColor: "#123456" });
    const saved = saveBrand({ captionColor: "not-a-colour", captionStyle: "nonsense" } as never);
    expect(saved.captionColor).toBe("#123456");
    expect(saved.captionStyle).toBe("bold");
  });

  it("goes back to the house look on request", async () => {
    saveBrand({ captionStyle: "minimal", captionColor: "#000000" });
    const res = await request(app).delete("/api/v1/brand");
    expect(res.status).toBe(200);
    expect(res.body.brand.captionStyle).toBe("house");
    expect(loadBrand().captionColor).toBe("#FFFFFF");
  });

  it("gives the renderer and the preview the same style", async () => {
    await request(app).put("/api/v1/brand").send({ captionStyle: "karaoke", accentColor: "#00FF88" });
    const res = await request(app).get("/api/v1/brand");
    expect(res.body.applied).toEqual(captionStyleFor(loadBrand()));
  });
});

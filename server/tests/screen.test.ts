// ── The agent's eyes: the picture, the request, and the honest failures ─────
// The capture itself is the desktop shell's job (Electron's desktopCapturer);
// what is tested here is that the request really carries a PNG, that the
// instruction refuses guessing, and that every empty-handed path ends in a
// sentence a person understands rather than an invented answer.

import { afterEach, describe, expect, it } from "vitest";
import { captureScreen, screenAvailable, screenRequest } from "../src/lib/screen.js";
import { toolsFor } from "../src/lib/brain/tools.js";

const HOST = "__soundwaveDesktopHost" as const;

function fakePng(bytes = 4000): Buffer {
  // A real-ish PNG header then padding — captureScreen only checks the size.
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(bytes, 7)]);
}

function setHost(host: unknown): void {
  (globalThis as Record<string, unknown>)[HOST] = host;
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>)[HOST];
});

describe("captureScreen", () => {
  it("is only available when the desktop shell is there", async () => {
    expect(screenAvailable()).toBe(false);
    await expect(captureScreen()).rejects.toThrow(/desktop app/i);
  });

  it("takes the shell's picture and says which display it came from", async () => {
    setHost({ captureScreen: async () => ({ png: fakePng(), width: 1920, height: 1080, display: "Display 1 (1920×1080)" }) });
    expect(screenAvailable()).toBe(true);
    const shot = await captureScreen();
    expect(shot.png.length).toBeGreaterThan(1000);
    expect(shot.display).toBe("Display 1 (1920×1080)");
    expect(shot.width).toBe(1920);
  });

  it("accepts raw bytes and base64 too", async () => {
    setHost({ captureScreen: async () => fakePng() });
    expect((await captureScreen()).display).toBe("this screen"); // raw bytes carry no size
    setHost({ captureScreen: async () => `data:image/png;base64,${fakePng().toString("base64")}` });
    expect((await captureScreen()).png.length).toBe(4008);
  });

  it("says the screen came back blank instead of sending an empty picture", async () => {
    setHost({ captureScreen: async () => null });
    await expect(captureScreen()).rejects.toThrow(/blank/i);
    setHost({ captureScreen: async () => fakePng(100) });
    await expect(captureScreen()).rejects.toThrow(/blank/i);
  });
});

describe("what Gemini is sent", () => {
  it("sends the PNG inline, then the question", () => {
    const png = fakePng();
    const request = screenRequest("what does this error say?", png);
    const parts = request.contents[0]?.parts ?? [];
    expect(parts[0]?.inlineData?.mimeType).toBe("image/png");
    expect(parts[0]?.inlineData?.data).toBe(png.toString("base64"));
    expect(parts[1]?.text).toBe("what does this error say?");
  });

  it("asks for a description when no question came with it", () => {
    const request = screenRequest("", fakePng());
    expect(request.contents[0]?.parts[1]?.text).toContain("Say what is on this screen");
  });

  it("refuses guessing when a word is too small to read", () => {
    const instruction = screenRequest("?", fakePng()).systemInstruction.parts[0]?.text ?? "";
    expect(instruction).toMatch(/too small/);
    expect(instruction).toMatch(/Never invent/);
  });
});

describe("the tool", () => {
  const ctx = {
    userId: "u1",
    voice: "v",
    resolution: "1080p" as const,
    seconds: 30,
    desktop: true,
    platform: "win32" as NodeJS.Platform,
  };

  it("is offered inside the desktop app, and not on a hosted server", () => {
    const names = toolsFor(ctx).map((t) => t.declaration.name);
    expect(names).toContain("look_at_screen");
    expect(names).toContain("read_file");
    expect(names).toContain("set_reminder");
    expect(names).toContain("list_reminders");
    expect(names).toContain("cancel_reminder");
    expect(names).toContain("set_volume");

    const hosted = toolsFor({ ...ctx, desktop: false }).map((t) => t.declaration.name);
    expect(hosted).not.toContain("look_at_screen");
    expect(hosted).not.toContain("read_file");
    expect(hosted).not.toContain("set_volume");
  });

  it("offers the volume on Windows only, and never lies about it elsewhere", () => {
    const onMac = toolsFor({ ...ctx, platform: "darwin" });
    expect(onMac.map((t) => t.declaration.name)).not.toContain("set_volume");
  });
});

// ── The agent's eyes: the picture, the request, and the honest failures ─────
// The capture itself is the desktop shell's job (Electron's desktopCapturer);
// what is tested here is that the request really carries a PNG, that the
// instruction refuses guessing, and that every empty-handed path ends in a
// sentence a person understands rather than an invented answer.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { captureScreen, screenAvailable, screenRequest } from "../src/lib/screen.js";
import { toolsFor } from "../src/lib/brain/tools.js";
import { resetRemindersForTests } from "../src/lib/reminders.js";

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

// ── The tools as the agent calls them ───────────────────────────────────────
// Every one of them has to end in either a real fact or a sentence a person
// understands — never a made-up result.

describe("what the agent gets back", () => {
  const ctx = () => ({
    userId: "u1",
    voice: "v",
    resolution: "1080p" as const,
    seconds: 30,
    desktop: true,
    platform: "win32" as NodeJS.Platform,
    effects: { log: [] as string[] },
  });
  const tool = (name: string) => toolsFor(ctx() as never).find((t) => t.declaration.name === name)!;

  it("says the screen can only be seen inside the desktop app", async () => {
    const result = await tool("look_at_screen").run({ question: "what does this error say?" }, ctx() as never);
    expect(result.ok).toBe(false);
    expect(String(result.reason)).toMatch(/desktop app/i);
  });

  it("reads a real file, and says when there is no file there", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sw-tool-files-"));
    const file = path.join(dir, "todo.txt");
    fs.writeFileSync(file, "buy milk\ncall the plumber\n");
    try {
      const read = await tool("read_file").run({ path: file }, ctx() as never);
      expect(read).toMatchObject({ ok: true, kind: "file", name: "todo.txt", lines: 3 });
      expect(String(read.text)).toContain("call the plumber");

      const listed = await tool("read_file").run({ path: dir }, ctx() as never);
      expect(listed).toMatchObject({ ok: true, kind: "folder", count: 1 });

      const missing = await tool("read_file").run({ path: path.join(dir, "ghost.txt") }, ctx() as never);
      expect(missing.ok).toBe(false);
      expect(String(missing.reason)).toMatch(/no file at/i);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sets, lists and cancels a reminder through the tools", async () => {
    resetRemindersForTests();
    const made = await tool("set_reminder").run({ when: "in 10 minutes", label: "check the render" }, ctx() as never);
    expect(made).toMatchObject({ ok: true, label: "check the render", kind: "timer" });
    expect(String(made.note)).toMatch(/as long as Soundwave is running/i);

    const waiting = await tool("list_reminders").run({}, ctx() as never);
    expect(waiting).toMatchObject({ ok: true, count: 1 });
    expect(String((waiting.reminders as Array<{ text: string }>)[0]?.text)).toContain("⏰ Timer done — check the render");

    const cancelled = await tool("cancel_reminder").run({ which: "render" }, ctx() as never);
    expect(cancelled).toMatchObject({ ok: true, cancelled: "⏰ Timer done — check the render" });
    const after = await tool("list_reminders").run({}, ctx() as never);
    expect(after.count).toBe(0);
  });

  it("refuses a time it can't read instead of ringing at a made-up moment", async () => {
    resetRemindersForTests();
    const made = await tool("set_reminder").run({ when: "after the render finishes" }, ctx() as never);
    expect(made.ok).toBe(false);
    expect(String(made.reason)).toMatch(/can't read a time/i);
  });

  it("asks the sound for its real level — and never invents one", async () => {
    // Read-only on purpose: running the tests on a Windows dev machine must not
    // turn that machine's volume down. CI (Linux) has no PowerShell at all, and
    // the honest refusal is the answer there.
    const result = await tool("set_volume").run({}, ctx() as never);
    if (process.platform === "win32") {
      if (result.ok) expect(typeof result.level).toBe("number");
      else expect(String(result.reason).length).toBeGreaterThan(5);
    } else {
      expect(result.ok).toBe(false);
      expect(String(result.reason).length).toBeGreaterThan(5);
    }
  });
});

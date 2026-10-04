import { afterEach, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { createApp } from "../src/app.js";
import { JsonStore, setStoreForTests } from "../src/lib/store.js";
import { getConversation, resetConversationForTests } from "../src/lib/conversation.js";
import {
  NOT_BUILT_YET,
  REAL_ACTIONS,
  clearReminders,
  decomposeNaturalLanguage,
  executeStep,
  executeWorkflow,
  type GhostContext,
  type MacroStep,
  type MacroWorkflow,
} from "../src/lib/ghostOperator.js";

let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  const store = new JsonStore();
  await store.init();
  setStoreForTests(store);
  app = createApp();
});

// ── The desktop app's real capabilities (Electron), faked for the tests ─────
interface FakeHost {
  opened: string[];
  clipboard: string;
  notifications: Array<{ title: string; body: string }>;
}
let host: FakeHost | null = null;

function installFakeDesktopHost(): FakeHost {
  const fake: FakeHost = { opened: [], clipboard: "", notifications: [] };
  host = fake;
  (globalThis as Record<string, unknown>).__soundwaveDesktopHost = {
    openExternal: (url: string) => {
      fake.opened.push(url);
      return Promise.resolve();
    },
    openPath: () => Promise.resolve(""),
    readClipboard: () => fake.clipboard,
    writeClipboard: (text: string) => {
      fake.clipboard = text;
    },
    notify: ({ title, body }: { title: string; body: string }) => {
      fake.notifications.push({ title, body });
      return true;
    },
  };
  return fake;
}

afterEach(() => {
  clearReminders();
  resetConversationForTests();
  delete (globalThis as Record<string, unknown>).__soundwaveDesktopHost;
  host = null;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

// A folder with known contents, for the real file scan (created by that test).
let tempDir = "";

const ctx: GhostContext = { userId: "local-user", desktop: false, platform: process.platform, voice: "en-US-GuyNeural", resolution: "720p" };
const desktopCtx: GhostContext = { ...ctx, desktop: true };

const step = (action: string, params: Record<string, unknown> = {}, description = action): MacroStep => ({ id: "step-1", action, params, description, delayMs: 0 });
const workflow = (steps: MacroStep[]): MacroWorkflow => ({
  id: "adhoc_test",
  name: "Test workflow",
  description: "test",
  category: "custom",
  triggerPhrases: [],
  steps,
  createdAt: new Date().toISOString(),
});

describe("Ghost Operator API", () => {
  let createdMacroId = "";

  it("lists the built-in macros and what they can really do", async () => {
    const res = await request(app).get("/api/v1/ghost/macros");
    expect(res.status).toBe(200);
    expect(res.body.macros).toBeDefined();
    expect(res.body.macros.length).toBeGreaterThanOrEqual(2);
    const ids = res.body.macros.map((m: any) => m.id);
    expect(ids).toContain("workspace_cleanup_diagnostics");
    expect(ids).toContain("viral_production_autopilot");
    // Deep Focus was removed; Morning Setup is a real feature now (not a macro).
    expect(ids).not.toContain("deep_focus_pomodoro");
    expect(ids).not.toContain("creator_morning_prep");
    expect(res.body.capabilities.real).toContain("clipboard");
    expect(res.body.capabilities.real).toContain("file_processor");
    expect(res.body.capabilities.notYet).toContain("computer_settings");
  });

  it("decomposes plain English into real steps, and is honest about the rest", () => {
    const openAndCheck = decomposeNaturalLanguage("open chrome and check system stats");
    expect(openAndCheck.map((s) => s.action)).toEqual(["open_app", "system_monitor"]);
    expect(openAndCheck[0]!.params.name).toBe("chrome");

    const browse = decomposeNaturalLanguage("open youtube.com, and remind me in 5 minutes to stretch");
    expect(browse.map((s) => s.action)).toEqual(["open_website", "reminder"]);
    expect(browse[0]!.params.url).toBe("youtube.com");
    expect(browse[1]!.params.seconds).toBe(300);

    // "start/launch" phrasings for other intents don't become app launches.
    const timer = decomposeNaturalLanguage("start a timer for 5 minutes");
    expect(timer).toHaveLength(1);
    expect(timer[0]!.action).toBe("reminder");
    expect(timer[0]!.params.seconds).toBe(300);

    const short = decomposeNaturalLanguage("start a short about black holes");
    expect(short).toHaveLength(1);
    expect(short[0]!.action).toBe("soundwave_shorts");
    expect(short[0]!.params.topic).toBe("black holes");

    const briefing = decomposeNaturalLanguage("open my morning briefing");
    expect(briefing).toHaveLength(1);
    expect(briefing[0]!.action).toBe("morning_setup");

    // Volume isn't built yet: the step says so instead of pretending.
    const volume = decomposeNaturalLanguage("unmute the volume");
    expect(volume).toHaveLength(1);
    expect(volume[0]!.action).toBe("unsupported");
    expect(volume[0]!.params.reason).toBe(NOT_BUILT_YET.computer_settings);
    expect(String(volume[0]!.params.reason)).toMatch(/volume/i);

    // Whatever the sentence, the steps are only actions that exist.
    for (const sentence of [
      "take a screenshot and open spotify",
      "run this python script",
      "clean up the workspace and tell me the weather in Belgrade",
      "give me my morning briefing",
      "copy hello world to the clipboard",
    ]) {
      for (const s of decomposeNaturalLanguage(sentence)) {
        expect([...REAL_ACTIONS, "unsupported"], sentence).toContain(s.action);
      }
    }
  });

  it("really scans a folder (read-only, real numbers)", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "soundwave-ghost-"));
    fs.writeFileSync(path.join(tempDir, "notes.txt"), "x".repeat(2048));
    fs.writeFileSync(path.join(tempDir, "clip.mp3"), "y".repeat(4096));

    const result = await executeStep(step("file_processor", { path: tempDir }), ctx);
    expect(result.status).toBe("SUCCESS");
    expect(result.output).toContain("2 file(s)");
    expect(result.output).toContain(path.resolve(tempDir));
    expect(result.output).toMatch(/clip\.mp3 \(4 KB\)/);
    expect(result.output).toContain("nothing was deleted");
    // The old executor made this up: "10 files scanned, 0 issues detected."
    expect(result.output).not.toContain("10 files scanned");
  });

  it("reports this PC's real facts", async () => {
    const result = await executeStep(step("system_monitor"), ctx);
    expect(result.status).toBe("SUCCESS");
    expect(result.output).toContain(os.hostname());
    expect(result.output).toContain(`${os.cpus().length} cores`);
    expect(result.output).toMatch(/memory .+ of .+ GB in use/);
    // Never the fabricated telemetry the panel used to print.
    expect(result.output).not.toMatch(/4\.2GB|16\.0GB|Host Healthy/);
  });

  it("uses the real clipboard inside the desktop app, and says so outside it", async () => {
    const withoutDesktop = await executeStep(step("clipboard", { operation: "set", text: "hello" }), ctx);
    expect(withoutDesktop.status).toBe("SKIPPED");
    expect(withoutDesktop.output).toMatch(/desktop app/);

    const fake = installFakeDesktopHost();
    const set = await executeStep(step("clipboard", { operation: "set", text: "Soundwave macro text" }), desktopCtx);
    expect(set.status).toBe("SUCCESS");
    expect(fake.clipboard).toBe("Soundwave macro text");

    const got = await executeStep(step("clipboard", { operation: "get" }), desktopCtx);
    expect(got.status).toBe("SUCCESS");
    expect(got.output).toContain("Soundwave macro text");
  });

  it("sets reminders that really arrive (chat message + Windows notification)", async () => {
    const fake = installFakeDesktopHost();
    const before = getConversation().messages.length;
    const result = await executeStep(step("reminder", { seconds: 1, message: "Stretch" }), desktopCtx);
    expect(result.status).toBe("SUCCESS");
    expect(result.output).toMatch(/Reminder set for 1 seconds|Reminder set for 1 second/);

    await new Promise((r) => setTimeout(r, 1600));
    expect(fake.notifications.map((n) => n.body)).toContain("Stretch");
    const messages = getConversation().messages;
    expect(messages.length).toBe(before + 1);
    expect(messages[messages.length - 1]!.text).toBe("⏰ Reminder: Stretch");
    expect(messages[messages.length - 1]!.tag).toBe("SYS");
  });

  it("skips what Soundwave can't do, with the reason — and reports real failures", async () => {
    const notYet = await executeStep(step("computer_settings", { setting: "unmute" }), ctx);
    expect(notYet.status).toBe("SKIPPED");
    expect(notYet.output).toBe(NOT_BUILT_YET.computer_settings);

    const unknown = await executeStep(step("teleport"), ctx);
    expect(unknown.status).toBe("SKIPPED");
    expect(unknown.output).toMatch(/isn't something Soundwave can do/);

    const badUrl = await executeStep(step("open_website", { url: "not a url at all" }), ctx);
    expect(badUrl.status).toBe("FAILED");
    expect(badUrl.output).toMatch(/isn't a web address/i);
  });

  it("runs the built-in diagnostics macro for real, with an honest summary", async () => {
    const res = await request(app).post("/api/v1/ghost/execute").send({ macroId: "workspace_cleanup_diagnostics" });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.report.stepResults).toHaveLength(3);
    for (const s of res.body.report.stepResults) expect(s.status).toBe("SUCCESS");
    expect(res.body.report.stepResults[0].output).toContain(config_dataDir());
    expect(res.body.report.stepResults[1].output).toMatch(/cores/);
    expect(res.body.report.stepResults[2].output).toMatch(/agent's memory/);
    expect(res.body.report.summary).toMatch(/3 of 3 steps ran/);
  });

  it("creates and saves a custom automation macro", async () => {
    const res = await request(app)
      .post("/api/v1/ghost/macros")
      .send({
        name: "Morning News & Audio",
        description: "Opens the news and checks the weather",
        category: "productivity",
        triggerPhrases: ["morning news"],
        steps: [
          { action: "open_website", params: { url: "https://news.ycombinator.com" }, description: "Open Hacker News" },
          { action: "weather_report", params: { city: "Kruševac" }, description: "Check the weather" },
        ],
      });

    expect(res.status).toBe(201);
    expect(res.body.macro).toBeDefined();
    expect(res.body.macro.id).toBeDefined();
    createdMacroId = res.body.macro.id;
  });

  it("executes a saved workflow and returns per-step telemetry", async () => {
    const res = await request(app).post("/api/v1/ghost/execute").send({ macroId: createdMacroId });
    expect(res.status).toBe(200);
    expect(res.body.report).toBeDefined();
    expect(res.body.report.stepResults).toHaveLength(2);
    // The weather step can't reach Open-Meteo in tests: it is skipped honestly
    // (with the stand-in's error), never filled in with invented weather.
    const weather = res.body.report.stepResults[1];
    expect(["SKIPPED", "FAILED"]).toContain(weather.status);
    expect(weather.output).not.toMatch(/20°C, Clear Sky, Humidity 42%/);
  });

  it("deletes a custom macro cleanly", async () => {
    const res = await request(app).delete(`/api/v1/ghost/macros/${createdMacroId}`);
    expect(res.status).toBe(204);
  });

  it("runs an ad-hoc workflow built from an instruction", async () => {
    const res = await request(app).post("/api/v1/ghost/execute").send({ instruction: "check system stats and scan the workspace" });
    expect(res.status).toBe(200);
    expect(res.body.report.stepResults.map((s: any) => s.action)).toEqual(["system_monitor", "file_processor"]);
    for (const s of res.body.report.stepResults) {
      expect(s.status).toBe("SUCCESS");
      expect(s.output).not.toMatch(/successfully executed|Dispatched/);
    }
  });

  it("reports skipped steps without failing the whole workflow", async () => {
    const report = await executeWorkflow(workflow([step("system_monitor", {}, "Read the PC"), step("computer_settings", { setting: "mute" }, "Mute")]), ctx);
    expect(report.allSuccess).toBe(true);
    expect(report.stepResults.map((s) => s.status)).toEqual(["SUCCESS", "SKIPPED"]);
    expect(report.summary).toMatch(/1 of 2 steps ran/);
    expect(report.summary).toMatch(/1 skipped/);
  });
});

/**
 * The data folder the executor scans by default (config.dataDir), resolved the
 * same way lib/ghostOperator.ts prints it (Windows turns "/tmp/x" into "C:\\tmp\\x").
 */
function config_dataDir(): string {
  return path.resolve(process.env.DATA_DIR || ".");
}

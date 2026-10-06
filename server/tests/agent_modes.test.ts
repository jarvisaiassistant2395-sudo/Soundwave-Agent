// ── The modes: how the agent talks ──────────────────────────────────────────
// Three layers, each pinned here because each can break on its own:
//   the definitions (core/persona.ts) — pure words, shared with the phone app;
//   the instruction (core/prompt.ts) — that a mode really reaches Gemini, and
//     that switching tone never costs a correctness rule;
//   the wiring (lib/agentMode.ts, PUT /brain/mode, the set_agent_mode tool) —
//     that the pill, Settings and "be more formal" all land on the same mode.
//
// The invariant that matters most is asserted in a loop over every mode: a
// personality is how the agent sounds, and must never be able to weaken "plain
// text because it is spoken", "reply in their language", "never claim a tool did
// something it didn't" or "don't invent facts".

import fs from "node:fs";
import path from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ToolContext } from "../src/lib/brain/tools.js";

const { config } = await import("../src/config.js");
const { createApp } = await import("../src/app.js");
const { JsonStore, setStoreForTests } = await import("../src/lib/store.js");
const persona = await import("../src/lib/brain/core/persona.js");
const { agentInstruction } = await import("../src/lib/brain/core/prompt.js");
const modes = await import("../src/lib/agentMode.js");
const { toolsFor } = await import("../src/lib/brain/tools.js");

const { AGENT_MODES, DEFAULT_MODE, detectMode, isAgentMode, modeById, modeCatalog, personaLines } = persona;

const ctx = (desktop = true): ToolContext => ({
  userId: "modes-test",
  voice: "en-US-AndrewNeural",
  resolution: "1080p",
  seconds: 60,
  desktop,
  platform: "win32",
  effects: { log: [] },
});

const modeFile = () => path.join(config.dataDir, "agent-mode.json");
const forgetMode = () => {
  fs.rmSync(modeFile(), { force: true });
  modes._resetAgentModeForTests();
};

let app: ReturnType<typeof createApp>;

beforeEach(() => {
  const store = new JsonStore();
  void store.init();
  setStoreForTests(store);
  forgetMode();
  delete process.env.AGENT_MODE;
  (config as { desktopApp: boolean }).desktopApp = true;
  (config as { brainSettingsAvailable: boolean }).brainSettingsAvailable = true;
  app = createApp();
});

afterEach(() => {
  // One DATA_DIR is shared by every test file: a mode left saved here would
  // quietly change how the agent sounds in someone else's test.
  forgetMode();
  delete process.env.AGENT_MODE;
});

describe("the modes themselves", () => {
  it("offers the six, each fully described, with no id used twice", () => {
    const ids = AGENT_MODES.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(["professional", "friendly", "concise", "coach", "witty", "narrator"]);
    for (const m of AGENT_MODES) {
      expect(m.name.trim().length, m.id).toBeGreaterThan(0);
      expect(m.tagline.trim().length, m.id).toBeGreaterThan(0);
      expect(m.addresses.trim().length, m.id).toBeGreaterThan(0);
      expect(m.lines.length, m.id).toBeGreaterThanOrEqual(2);
      for (const line of m.lines) expect(line.startsWith("- "), `${m.id}: ${line}`).toBe(true);
    }
    expect(AGENT_MODES.some((m) => m.id === DEFAULT_MODE)).toBe(true);
  });

  it("makes Professional the executive assistant who says sir, and keeps sir out of the others", () => {
    const professional = modeById("professional");
    expect(professional.lines.join("\n")).toMatch(/executive assistant/i);
    expect(professional.lines.join("\n")).toMatch(/sir/i);
    // Told to prefer something else, "sir" stops — a stored preference wins.
    expect(professional.lines.join("\n")).toMatch(/their stated preference always wins/);
    // Only Professional says "sir", and Friendly forbids it out loud so the two
    // can't blur into each other. The other four don't mention it at all.
    expect(modeById("friendly").lines.join("\n")).toMatch(/Never call them “sir”/);
    for (const m of AGENT_MODES.filter((x) => x.id !== "professional" && x.id !== "friendly")) {
      expect(m.lines.join("\n").toLowerCase(), m.id).not.toContain("sir");
    }
  });

  it("gives every mode its own voice rather than six wordings of one", () => {
    const signatures = AGENT_MODES.map((m) => m.lines.join("\n"));
    expect(new Set(signatures).size).toBe(AGENT_MODES.length);
    expect(modeById("concise").lines.join("\n")).toMatch(/Answer only/);
    expect(modeById("coach").lines.join("\n")).toMatch(/next action/);
    expect(modeById("witty").lines.join("\n")).toMatch(/Answer first/);
    expect(modeById("narrator").lines.join("\n")).toMatch(/narrator/i);
    expect(personaLines("professional")).toEqual(modeById("professional").lines);
  });

  it("falls back to the default for an id it doesn't know, rather than talking in no voice at all", () => {
    expect(modeById("pirate").id).toBe(DEFAULT_MODE);
    expect(modeById(null).id).toBe(DEFAULT_MODE);
    expect(modeById(undefined).id).toBe(DEFAULT_MODE);
    expect(modeById("").id).toBe(DEFAULT_MODE);
    expect(personaLines("nonsense")).toEqual(modeById(DEFAULT_MODE).lines);
    expect(isAgentMode("coach")).toBe(true);
    expect(isAgentMode("COACH")).toBe(false); // ids are lowercase; callers normalise
    expect(isAgentMode(42)).toBe(false);
    expect(isAgentMode(null)).toBe(false);
  });

  it("understands the words people actually use, and says so when they name no mode", () => {
    expect(detectMode("be formal")).toBe("professional");
    expect(detectMode("act like my executive assistant")).toBe("professional");
    expect(detectMode("call me sir")).toBe("professional");
    expect(detectMode("Professional")).toBe("professional");
    expect(detectMode("keep it short")).toBe("concise");
    expect(detectMode("no fluff please")).toBe("concise");
    expect(detectMode("give me shorter answers")).toBe("concise");
    expect(detectMode("answer in one line")).toBe("concise");
    expect(detectMode("be brief")).toBe("concise");
    expect(detectMode("talk to me like a coach")).toBe("coach");
    expect(detectMode("hold me accountable")).toBe("coach");
    expect(detectMode("be funny")).toBe("witty");
    expect(detectMode("stop with the jokes")).toBe("witty");
    expect(detectMode("be cinematic")).toBe("narrator");
    expect(detectMode("talk like a narrator")).toBe("narrator");
    expect(detectMode("be normal again")).toBe("friendly");
    expect(detectMode("friendly")).toBe("friendly");
    // Guessing a personality is worse than asking, so anything that doesn't
    // name a tone resolves to nothing and the caller asks which was meant.
    expect(detectMode("talk like a pirate")).toBeNull();
    expect(detectMode("")).toBeNull();
    expect(detectMode("   ")).toBeNull();
    expect(detectMode("what can you do?")).toBeNull();
    expect(modeCatalog().map((m) => m.id)).toEqual(AGENT_MODES.map((m) => m.id));
  });

  it("doesn't hear a mode in the app's own vocabulary — a Short is a video, a briefing is a morning", () => {
    // "short" is the product. Asking for one must not make the agent terse.
    for (const asked of [
      "make a short about black holes",
      "cut 1 clip out of this video",
      "make me a youtube short about honey",
      "why did my short flop",
      "run my morning briefing",
      "what's in my morning briefing today",
      "make a motivation short about discipline",
      "tell me a joke",
      "what's trending",
    ]) {
      expect(detectMode(asked), asked).toBeNull();
    }
  });
});

describe("the instruction a mode produces", () => {
  const build = (mode?: string) => agentInstruction({ tools: [], webSearch: false, mode });

  it("names the mode and carries its own lines", () => {
    for (const m of AGENT_MODES) {
      const text = build(m.id);
      expect(text, m.id).toContain(`How to reply — you are in ${m.name} mode:`);
      for (const line of m.lines) expect(text, `${m.id}: ${line.slice(0, 40)}`).toContain(line);
    }
  });

  it("keeps every correctness rule in every mode — tone cannot buy a worse answer", () => {
    const invariants = [
      "Plain text only: no Markdown",
      "no emoji",
      "Reply in the language the user writes in",
      "Never say you did something unless a tool result confirms it",
      "Don't make up facts, numbers, links, quotes or events",
    ];
    for (const m of AGENT_MODES) {
      const text = build(m.id);
      for (const rule of invariants) expect(text, `${m.id} lost: ${rule}`).toContain(rule);
      // And the rule that says so explicitly, in case a mode's own wording drifts.
      expect(text, m.id).toContain("The mode is how you sound, not what you know or what you may do");
    }
  });

  it("is the default mode when nobody chose one — the phone app offline passes no mode at all", () => {
    expect(build()).toBe(build(DEFAULT_MODE));
    expect(build("nonsense")).toBe(build(DEFAULT_MODE));
    expect(build()).toContain(`you are in ${modeById(DEFAULT_MODE).name} mode`);
  });

  it("mentions switching only when the tool is actually offered", () => {
    const withTool = agentInstruction({ tools: ["set_agent_mode"], webSearch: false });
    expect(withTool).toContain("Change how you talk with set_agent_mode");
    expect(withTool).toContain("executive assistant");
    expect(withTool).toContain("shorts, narrations and briefings are for an audience and stay as they are");
    expect(agentInstruction({ tools: [], webSearch: false })).not.toContain("set_agent_mode");
  });
});

describe("the saved choice", () => {
  it("round-trips through the data folder and re-reads what it wrote", () => {
    expect(modes.loadAgentMode()).toBe(DEFAULT_MODE);
    expect(modes.saveAgentMode("professional")).toBe("professional");
    expect(modes.loadAgentMode()).toBe("professional");
    modes._resetAgentModeForTests();
    expect(modes.loadAgentMode(), "a fresh process must read the file, not a cache").toBe("professional");
    expect(JSON.parse(fs.readFileSync(modeFile(), "utf8")).mode).toBe("professional");
  });

  it("falls back to the default when the file names a mode that no longer exists", () => {
    fs.mkdirSync(path.dirname(modeFile()), { recursive: true });
    fs.writeFileSync(modeFile(), JSON.stringify({ mode: "victorian-butler" }));
    modes._resetAgentModeForTests();
    expect(modes.loadAgentMode()).toBe(DEFAULT_MODE);
    // …and a file that isn't JSON at all.
    fs.writeFileSync(modeFile(), "not json{");
    modes._resetAgentModeForTests();
    expect(modes.loadAgentMode()).toBe(DEFAULT_MODE);
  });

  it("takes the environment's mode when nothing is saved, and the saved one once there is", () => {
    process.env.AGENT_MODE = "concise";
    modes._resetAgentModeForTests();
    expect(modes.loadAgentMode()).toBe("concise");
    expect(modes.agentModeStatus().source).toBe("environment");
    modes.saveAgentMode("witty");
    expect(modes.loadAgentMode()).toBe("witty");
    expect(modes.agentModeStatus().source).toBe("saved");
    // An environment value naming no mode is ignored rather than crashing.
    forgetMode();
    process.env.AGENT_MODE = "shouty";
    modes._resetAgentModeForTests();
    expect(modes.loadAgentMode()).toBe(DEFAULT_MODE);
    expect(modes.agentModeStatus().source).toBe("default");
  });

  it("reports the choice and every option, so the pill and Settings render from one answer", () => {
    const status = modes.agentModeStatus();
    expect(status.mode).toBe(DEFAULT_MODE);
    expect(status.name).toBe(modeById(DEFAULT_MODE).name);
    expect(status.editable).toBe(true);
    expect(status.modes).toHaveLength(AGENT_MODES.length);
    expect(status.modes[0]).toMatchObject({ id: "professional", name: "Professional" });
    for (const m of status.modes) expect(m.tagline.length).toBeGreaterThan(0);
  });
});

describe("GET and PUT /api/v1/brain/mode", () => {
  it("says how the agent talks now and offers all six", async () => {
    const res = await request(app).get("/api/v1/brain/mode").expect(200);
    expect(res.body).toMatchObject({ mode: DEFAULT_MODE, name: "Friendly", source: "default", editable: true });
    expect(res.body.modes.map((m: { id: string }) => m.id)).toEqual(AGENT_MODES.map((m) => m.id));
    // The key is never part of this answer.
    expect(JSON.stringify(res.body)).not.toMatch(/AIza/);
  });

  it("changes the mode by id and reports the new one", async () => {
    const res = await request(app).put("/api/v1/brain/mode").send({ mode: "professional" }).expect(200);
    expect(res.body).toMatchObject({ mode: "professional", name: "Professional", source: "saved" });
    expect(modes.loadAgentMode()).toBe("professional");
    await request(app).get("/api/v1/brain/mode").expect(200).expect((r) => {
      expect(r.body.mode).toBe("professional");
    });
  });

  it("changes the mode from the words used, which is how anyone actually asks", async () => {
    for (const [asked, wanted] of [
      ["be more formal", "professional"],
      ["act like my executive assistant", "professional"],
      ["keep it short", "concise"],
      ["talk to me like a coach", "coach"],
      ["be a bit funnier", "witty"],
      ["go back to normal", "friendly"],
    ] as Array<[string, string]>) {
      const res = await request(app).put("/api/v1/brain/mode").send({ asked }).expect(200);
      expect(res.body.mode, asked).toBe(wanted);
    }
  });

  it("refuses words that name no mode, and says which modes there are", async () => {
    const res = await request(app).put("/api/v1/brain/mode").send({ asked: "talk like a pirate" }).expect(400);
    expect(res.body).toMatchObject({ error: { code: "UNKNOWN_MODE" } });
    expect(res.body.error.message).toContain("Professional");
    expect(res.body.error.message).toContain("Narrator");
    // Nothing was changed by the refused request.
    expect(modes.loadAgentMode()).toBe(DEFAULT_MODE);
  });

  it("refuses an empty request rather than guessing", async () => {
    const res = await request(app).put("/api/v1/brain/mode").send({}).expect(400);
    expect(res.body.error.message).toMatch(/which mode|sound like/i);
  });

  it("reads anywhere but writes only where settings are available", async () => {
    (config as { brainSettingsAvailable: boolean }).brainSettingsAvailable = false;
    try {
      await request(app).get("/api/v1/brain/mode").expect(200);
      const res = await request(app).put("/api/v1/brain/mode").send({ mode: "concise" });
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(modes.loadAgentMode(), "a refused write must not have written").toBe(DEFAULT_MODE);
    } finally {
      (config as { brainSettingsAvailable: boolean }).brainSettingsAvailable = true;
    }
  });
});

describe("the set_agent_mode tool", () => {
  const tool = (desktop = true) => toolsFor(ctx(desktop)).find((t) => t.declaration.name === "set_agent_mode");

  it("is offered on this PC and not on a hosted server, where one user would change everyone's agent", () => {
    expect(tool(true)).toBeTruthy();
    expect(tool(false)).toBeUndefined();
  });

  it("is a side effect, so a retried turn never switches the mode twice", () => {
    expect(tool(true)!.sideEffect).toBe(true);
  });

  it("switches from the person's own words and confirms in the new register", async () => {
    const res = await tool()!.run({ asked: "could you be more formal" }, ctx());
    expect(res).toMatchObject({ changed: true, mode: "professional", name: "Professional" });
    expect(String(res.note)).toMatch(/from the next reply/i);
    expect(String(res.note)).toMatch(/shorts, narrations and briefings stay as they are/);
    expect(modes.loadAgentMode()).toBe("professional");
  });

  it("switches by id when one was named exactly", async () => {
    const res = await tool()!.run({ mode: "concise" }, ctx());
    expect(res).toMatchObject({ changed: true, mode: "concise" });
    // An id in the wrong case is still the id someone meant.
    const upper = await tool()!.run({ mode: "WITTY" }, ctx());
    expect(upper).toMatchObject({ changed: true, mode: "witty" });
  });

  it("says so when the mode is already the one asked for, instead of pretending to change it", async () => {
    modes.saveAgentMode("coach");
    const res = await tool()!.run({ mode: "coach" }, ctx());
    expect(res).toMatchObject({ changed: false, mode: "coach" });
    expect(String(res.note)).toMatch(/Already in Coach mode/);
  });

  it("asks rather than guesses when the words name no mode", async () => {
    const res = await tool()!.run({ asked: "talk like a pirate" }, ctx());
    expect(res.changed).toBe(false);
    expect(res.mode).toBe(DEFAULT_MODE);
    expect(String(res.reason)).toContain("professional");
    expect(String(res.reason)).toContain("narrator");
    expect(Array.isArray(res.modes)).toBe(true);
    expect(modes.loadAgentMode(), "a refused switch must not have switched").toBe(DEFAULT_MODE);
  });

  it("ignores junk arguments without throwing", async () => {
    const res = await tool()!.run({ mode: 42, asked: null }, ctx());
    expect(res.changed).toBe(false);
    expect(String(res.reason).length).toBeGreaterThan(10);
  });
});

// Choosing the agent's voice by name (lib/voices.ts + the list_voices/set_voice
// tools) and what the app does with a voice the agent picks: the shared
// conversation carries it (desktop + phone) and the revision moves, so the open
// window hears about the change without asking.
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.DESKTOP_APP = "1";
});

const { config } = await import("../src/config.js");
const { voices, conversation, tools, edgeTts, frontendVoices } = {
  voices: await import("../src/lib/voices.js"),
  conversation: await import("../src/lib/conversation.js"),
  tools: await import("../src/lib/brain/tools.js"),
  edgeTts: await import("../src/lib/edgeTts.js"),
  frontendVoices: await import("../../frontend/src/lib/voices.ts"),
};

beforeAll(() => {
  fs.rmSync(config.dataDir, { recursive: true, force: true });
});

beforeEach(() => {
  fs.rmSync(path.join(config.dataDir, "agent-conversation.json"), { force: true });
  conversation.resetConversationForTests();
});

afterAll(() => {
  // The data dir is shared with every other test file: leave nothing behind
  // that would change their behaviour (a chosen voice, a connected channel).
  fs.rmSync(path.join(config.dataDir, "agent-conversation.json"), { force: true });
  fs.rmSync(path.join(config.dataDir, "youtube"), { recursive: true, force: true });
});

const toolFor = (name: string) => tools.AGENT_TOOLS.find((t) => t.declaration.name === name)!;
const ctx = () => ({
  userId: "local-user",
  voice: "en-US-GuyNeural",
  resolution: "1080p" as const,
  seconds: 60,
  desktop: true,
  platform: "win32" as NodeJS.Platform,
  effects: { log: [] as string[] },
});

describe("every voice the app plays is one the agent knows", () => {
  it("lists all ten voices, the multilingual ones included", () => {
    expect(voices.VOICES.map((v) => v.id)).toEqual([
      "en-US-AvaMultilingualNeural",
      "en-US-AndrewMultilingualNeural",
      "en-US-EmmaMultilingualNeural",
      "en-US-BrianMultilingualNeural",
      "en-US-JennyNeural",
      "en-US-AnaNeural",
      "en-GB-SoniaNeural",
      "en-US-ChristopherNeural",
      "en-US-GuyNeural",
      "en-GB-RyanNeural",
    ]);
  });

  it("matches the app's own picker exactly (same ids, both ways)", () => {
    // The UI's list is the source of what a person can play; if it grows without
    // the server, the agent would offer a voice the app doesn't have — or refuse
    // one it does. Read the frontend file as text so this can't drift silently.
    const ui = fs.readFileSync(path.join(__dirname, "..", "..", "frontend", "src", "lib", "voices.ts"), "utf8");
    const ids = [...ui.matchAll(/\{\s*id:\s*"([^"]+)"/g)].map((m) => m[1]!);
    expect(ids.length).toBeGreaterThan(0);
    expect([...ids].sort()).toEqual(voices.VOICES.map((v) => v.id).sort());
  });

  it("defaults chat to the newer natural male voice without removing Guy", () => {
    const modernVoice = "en-US-AndrewMultilingualNeural";
    expect(edgeTts.DEFAULT_AGENT_VOICE).toBe(modernVoice);
    expect(voices.getVoice(modernVoice)).toMatchObject({ displayName: "Andrew (most natural)", gender: "Male" });
    expect(voices.getVoice("en-US-GuyNeural")?.id).toBe("en-US-GuyNeural");

    const ui = fs.readFileSync(path.join(__dirname, "..", "..", "frontend", "src", "lib", "voices.ts"), "utf8");
    expect(ui).toMatch(new RegExp(`DEFAULT_AGENT_VOICE_ID\\s*=\\s*"${modernVoice}"`));
  });

  it("keeps an explicitly saved voice when the default changes", () => {
    const values = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    });
    try {
      expect(frontendVoices.loadAgentVoice()).toBe("en-US-AndrewMultilingualNeural");
      frontendVoices.saveAgentVoice("en-US-GuyNeural");
      expect(frontendVoices.loadAgentVoice()).toBe("en-US-GuyNeural");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("understands how people actually say a name", () => {
    expect(voices.resolveVoice("Ava")?.id).toBe("en-US-AvaMultilingualNeural");
    expect(voices.resolveVoice("ava (most natural)")?.id).toBe("en-US-AvaMultilingualNeural");
    expect(voices.resolveVoice("AVAA")?.id).toBeUndefined();
    expect(voices.resolveVoice("ryan")?.id).toBe("en-GB-RyanNeural");
    expect(voices.resolveVoice("en-GB-SoniaNeural")?.id).toBe("en-GB-SoniaNeural");
    expect(voices.resolveVoice("en-us-guyneural")?.id).toBe("en-US-GuyNeural");
    expect(voices.resolveVoice("christopher")?.id).toBe("en-US-ChristopherNeural");
    expect(voices.resolveVoice("the British woman")).toBeNull();
    expect(voices.resolveVoice("A")?.id ?? "").not.toBe("en-US-AnaNeural"); // ambiguous prefix: no guessing
    expect(voices.resolveVoice("")).toBeNull();
    expect(voices.resolveVoice("Siri")).toBeNull();
    expect(voices.voiceNames()).toContain("Ava");
    expect(voices.voiceNames()).toContain("Ryan");
    expect(voices.voiceNames()).not.toContain("Ava (most natural)");
  });
});

describe("the agent changing the voice in chat", () => {
  it("lists the names and says which one is in use", async () => {
    conversation.setConversationVoice("en-GB-RyanNeural");
    const out = (await toolFor("list_voices").run({}, ctx())) as {
      current: string;
      currentName: string;
      voices: Array<{ name: string; id: string; inUse: boolean }>;
    };
    expect(out.current).toBe("en-GB-RyanNeural");
    expect(out.currentName).toBe("Ryan");
    expect(out.voices).toHaveLength(10);
    expect(out.voices.filter((v) => v.inUse).map((v) => v.name)).toEqual(["Ryan"]);
    expect(out.voices.map((v) => v.name)).toContain("Ava");
  });

  it("switches the voice the app and the phone will use, and wakes the open window", async () => {
    const before = conversation.getConversation().rev;
    const seen: number[] = [];
    const off = conversation.onConversationChange((rev) => seen.push(rev));
    const c = ctx();
    const out = (await toolFor("set_voice").run({ voice: "Ava" }, c)) as { changed: boolean; voice: string; name: string; note: string };
    off();
    expect(out.changed).toBe(true);
    expect(out.voice).toBe("en-US-AvaMultilingualNeural");
    expect(out.name).toBe("Ava");
    expect(out.note).toMatch(/from now on/i);
    expect(c.effects.log.join(" ")).toMatch(/Voice → Ava/);
    expect(conversation.getConversation().voice).toBe("en-US-AvaMultilingualNeural");
    expect(seen.at(-1)).toBe(conversation.getConversation().rev);
    expect(conversation.getConversation().rev).toBeGreaterThan(before);
  });

  it("refuses a voice it doesn't have, and names the real ones", async () => {
    conversation.setConversationVoice("en-US-GuyNeural");
    const out = (await toolFor("set_voice").run({ voice: "Siri" }, ctx())) as { changed: boolean; reason: string; voices: string[] };
    expect(out.changed).toBe(false);
    expect(out.reason).toMatch(/no Soundwave voice called/i);
    expect(out.voices).toContain("Ava");
    expect(conversation.getConversation().voice).toBe("en-US-GuyNeural"); // unchanged
  });

  it("is offered on the phone too (the phone speaks with the same voice)", () => {
    const phone = { ...ctx(), via: "phone" as const };
    const names = tools.toolsFor(phone).map((t) => t.declaration.name);
    expect(names).toContain("set_voice");
    expect(names).toContain("list_voices");
  });
});

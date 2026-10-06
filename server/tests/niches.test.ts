// Niches the agent adds when something new is climbing: the store, the shared
// registry every script writer reads, the suggestions built from the trend
// digest, and the tool the agent calls to add one.
import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

const DATA_DIR = process.env.DATA_DIR ?? "/tmp/soundwave-test-data";

const niches = await import("../src/lib/brain/niches.js");
const viral = await import("../src/lib/brain/core/viral.js");
const { toolsFor } = await import("../src/lib/brain/tools.js");

const ctx = (desktop = true) => ({ userId: "local-user", voice: "en-US-AndrewNeural", resolution: "1080p", seconds: 60, desktop, platform: "win32", effects: { log: [] } });
const tool = (name: string, desktop = true) => toolsFor(ctx(desktop) as never).find((t) => t.declaration.name === name)!;

function writeDigest(top: Array<{ title: string; views: number; channel: string }>, googleTrends: string[] = []) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(DATA_DIR, "trends.json"),
    JSON.stringify({
      researchedAt: Date.now(),
      via: "youtube",
      sources: ["YouTube search"],
      findings: ["Fastest climber: something — 2.1M views in 9 hours.", "Hook shape landing now: question titles.", "Typical length of this week's top Shorts: 42 seconds."],
      top: top.map((t, i) => ({ id: `vid${i}0000000`, title: t.title, url: `https://www.youtube.com/shorts/vid${i}0000000`, views: t.views, channel: t.channel, query: "shorts" })),
      googleTrends,
    }),
    "utf8",
  );
}

beforeEach(() => {
  niches.resetAddedNichesForTests();
  try {
    fs.rmSync(path.join(DATA_DIR, "trends.json"), { force: true });
  } catch {
    /* nothing saved */
  }
});

describe("adding a niche", () => {
  it("registers it with the script engine the moment it is added", () => {
    const result = niches.addAddedNiche({ name: "Street Food Stories", short: "The stalls behind the queues", audience: "People who eat with their eyes", why: "11 Shorts this week, 6 channels", hooks: ["cold-open"], source: "agent" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.niche.id).toBe("street-food-stories");
    // The brief the script writer gets names the new niche, and detectNiche
    // (the Generate button's picker) resolves its id.
    expect(viral.detectNiche(result.niche.id).name).toBe("Street Food Stories");
    expect(viral.detectNiche("the street food stalls nobody films").id).toBe("street-food-stories");
    const brief = viral.buildScriptInstruction({ seconds: 60, niche: viral.detectNiche(result.niche.id) });
    expect(brief).toMatch(/THIS NICHE — Street Food Stories/);
    // It is offered by /niches, badged, with where it came from.
    const entry = viral.nicheCatalog().find((n) => n.id === result.niche.id)!;
    expect(entry).toMatchObject({ added: true, source: "agent", name: "Street Food Stories" });
    expect(viral.nicheCatalog().filter((n) => !n.added)).toHaveLength(9);
  });

  it("fills in the recipe a script needs when the agent gives only a name", () => {
    const result = niches.addAddedNiche({ name: "Old Cameras", why: "seen twice", source: "agent" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.niche.angles.length).toBeGreaterThanOrEqual(3);
    expect(result.niche.hooks.length).toBeGreaterThanOrEqual(2);
    expect(result.niche.never.length).toBeGreaterThan(20);
    expect(result.niche.audience.length).toBeGreaterThan(20);
  });

  it("refuses a niche that is already there, and one with no real name", () => {
    expect(niches.addAddedNiche({ name: "Psychology & Mind Tricks" })).toMatchObject({ ok: false });
    expect(niches.addAddedNiche({ name: "ab" })).toMatchObject({ ok: false });
    expect(niches.addAddedNiche({ name: "!!!" })).toMatchObject({ ok: false });
    expect(niches.addedNiches()).toHaveLength(0);
  });

  it("takes an added niche back out but never a researched one", () => {
    const added = niches.addAddedNiche({ name: "Sleep Science" });
    expect(added.ok).toBe(true);
    expect(niches.removeAddedNiche("facts")).toBeNull();
    expect(viral.detectNiche("facts").id).toBe("facts");
    const removed = niches.removeAddedNiche("sleep-science");
    expect(removed?.name).toBe("Sleep Science");
    expect(niches.addedNiches()).toHaveLength(0);
    expect(viral.extraNiches()).toHaveLength(0);
    expect(viral.nicheCatalog()).toHaveLength(9);
  });

  it("keeps the added niches in a file on this PC", () => {
    niches.addAddedNiche({ name: "Rocket Launches", why: "climbing" });
    const raw = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "niches.json"), "utf8")) as { niches: Array<{ name: string }> };
    expect(raw.niches.map((n) => n.name)).toEqual(["Rocket Launches"]);
    // A fresh process (cache dropped) reads the same niche back.
    niches.resetAddedNichesForTests();
    fs.writeFileSync(path.join(DATA_DIR, "niches.json"), JSON.stringify(raw), "utf8");
    expect(niches.addedNiches().map((n) => n.name)).toEqual(["Rocket Launches"]);
    expect(viral.detectNiche("rocket-launches").name).toBe("Rocket Launches");
  });

  it("stops at the limit instead of growing forever", () => {
    for (let i = 0; i < niches.MAX_ADDED_NICHES; i++) {
      expect(niches.addAddedNiche({ name: `Subject Number ${i}` }).ok).toBe(true);
    }
    const over = niches.addAddedNiche({ name: "One Too Many" });
    expect(over).toMatchObject({ ok: false });
    if (!over.ok) expect(over.error).toMatch(/remove one first/);
    expect(niches.addedNiches()).toHaveLength(niches.MAX_ADDED_NICHES);
  });
});

describe("what the trend scan says is uncovered", () => {
  it("suggests a subject several channels are posting about that no niche covers", () => {
    writeDigest([
      { title: "street food in Bangkok #shorts", views: 4_000_000, channel: "A" },
      { title: "street food tour nobody films", views: 3_000_000, channel: "B" },
      { title: "best street food stalls", views: 2_500_000, channel: "C" },
      { title: "street food gone wrong", views: 1_200_000, channel: "D" },
      { title: "a psychology trick for meetings", views: 900_000, channel: "E" },
    ]);
    const suggestions = niches.suggestNiches();
    expect(suggestions.length).toBeGreaterThanOrEqual(1);
    const street = suggestions.find((s) => s.name.toLowerCase().includes("street food"))!;
    expect(street).toBeTruthy();
    expect(street.shorts).toBe(4);
    expect(street.channels).toBe(4);
    expect(street.why).toMatch(/most-viewed Shorts/);
    expect(street.evidence.length).toBeGreaterThanOrEqual(1);
  });

  it("never suggests something the researched niches already cover", () => {
    writeDigest([
      { title: "psychology facts about habits", views: 5_000_000, channel: "A" },
      { title: "why habits stick psychology", views: 4_000_000, channel: "B" },
      { title: "habit psychology explained", views: 3_000_000, channel: "C" },
    ]);
    expect(niches.suggestNiches()).toHaveLength(0);
    expect(niches.coveredByNiche("habit psychology")).toBe(true);
    expect(niches.coveredByNiche("bangkok street food")).toBe(false);
  });

  it("offers the day's Google searches only when nothing covers them", () => {
    writeDigest([{ title: "unrelated thing #shorts", views: 100_000, channel: "A" }], ["mushroom foraging", "psychology facts"]);
    const suggestions = niches.suggestNiches();
    expect(suggestions.map((s) => s.name)).toContain("Mushroom Foraging");
    expect(suggestions.map((s) => s.name)).not.toContain("Psychology Facts");
  });

  it("turns a suggestion into a niche with one press", () => {
    writeDigest([
      { title: "space elevator explained", views: 2_000_000, channel: "A" },
      { title: "space elevator problem", views: 1_800_000, channel: "B" },
      { title: "space elevator shorts", views: 1_500_000, channel: "C" },
    ]);
    const suggestion = niches.suggestNiches()[0]!;
    const added = niches.suggestionToNiche(suggestion, "user");
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    expect(added.niche.source).toBe("user");
    expect(added.niche.why).toBe(suggestion.why);
    // And it stops being suggested once it is in the picker.
    expect(niches.suggestNiches().map((s) => s.id)).not.toContain(suggestion.id);
  });
});

describe("the agent's niche tools", () => {
  it("adds a niche the agent found, and lists what is offered", async () => {
    const add = tool("add_viral_niche");
    const result = await add.run({ name: "Mushroom Foraging", why: "4 of this week's top Shorts, 3 channels", description: "Foraging finds and their warnings" }, ctx() as never);
    expect(result).toMatchObject({ added: true });
    expect((result.niche as { id: string }).id).toBe("mushroom-foraging");

    const listed = (await tool("list_niches").run({}, ctx() as never)) as {
      researched: unknown[];
      added: Array<{ name: string }>;
      availableHooks: Array<{ id: string }>;
    };
    expect(listed.researched).toHaveLength(9);
    expect(listed.added.map((n) => n.name)).toEqual(["Mushroom Foraging"]);
    expect(listed.availableHooks.length).toBeGreaterThan(4);
  });

  it("says so plainly when a niche is already there, instead of duplicating it", async () => {
    const add = tool("add_viral_niche");
    const first = await add.run({ name: "Deep Sea Oddities", why: "climbing" }, ctx() as never);
    expect(first).toMatchObject({ added: true });
    const again = await add.run({ name: "Deep Sea Oddities", why: "climbing" }, ctx() as never);
    expect(again).toMatchObject({ added: false });
    expect(String(again.error)).toMatch(/already a niche/);
    expect(niches.addedNiches()).toHaveLength(1);
  });

  it("removes an added niche, and refuses the researched ones", async () => {
    await tool("add_viral_niche").run({ name: "Urban Gardening", why: "climbing" }, ctx() as never);
    const removed = await tool("remove_niche").run({ niche: "urban-gardening" }, ctx() as never);
    expect(removed).toMatchObject({ removed: true });
    const researched = await tool("remove_niche").run({ niche: "psychology" }, ctx() as never);
    expect(researched).toMatchObject({ removed: false });
    expect(String(researched.error)).toMatch(/researched/);
  });

  it("is offered on the desktop app only (the picker it changes lives there)", () => {
    expect(tool("add_viral_niche", false)).toBeUndefined();
    expect(tool("list_niches", false)).toBeUndefined();
    expect(tool("remove_niche", false)).toBeUndefined();
    expect(tool("set_mode", false)).toBeUndefined();
    expect(tool("add_viral_niche", true)).toBeTruthy();
  });
});

// ── Niches the agent finds ──────────────────────────────────────────────────
// The whole point of this feature is that nobody's list gets quietly rewritten:
// a free scan spots what's climbing outside the nine, the agent proposes, and
// the person decides. Each of those three is pinned here, plus the two ways it
// could go wrong — a proposal too thin to write scripts from, and a "new" niche
// that was one of the old ones all along.
//
// Nothing in here reaches the network: the scan is fed TrendingShort fixtures.

import fs from "node:fs";
import path from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { NicheLead, TrendingShort } from "../src/lib/shortsTrends.js";
import type { ToolContext } from "../src/lib/brain/tools.js";

const mocks = vi.hoisted(() => ({ trendsStatus: vi.fn() }));

vi.mock("../src/lib/trends.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/trends.js")>();
  return { ...actual, trendsStatus: mocks.trendsStatus };
});

const { config } = await import("../src/config.js");
const { createApp } = await import("../src/app.js");
const { JsonStore, setStoreForTests } = await import("../src/lib/store.js");
const dn = await import("../src/lib/discoveredNiches.js");
const { nicheLeads } = await import("../src/lib/shortsTrends.js");
const viral = await import("../src/lib/brain/core/viral.js");
const { toolsFor } = await import("../src/lib/brain/tools.js");
const { agentInstruction } = await import("../src/lib/brain/core/prompt.js");

const ctx = (desktop = true): ToolContext => ({
  userId: "niches-test",
  voice: "en-US-AndrewNeural",
  resolution: "1080p",
  seconds: 60,
  desktop,
  platform: "win32",
  effects: { log: [] },
});

let app: ReturnType<typeof createApp>;

beforeEach(() => {
  const store = new JsonStore();
  void store.init();
  setStoreForTests(store);
  dn._resetDiscoveredNichesForTests();
  vi.clearAllMocks();
  mocks.trendsStatus.mockReturnValue({
    available: false,
    researchedAt: null,
    ageDays: null,
    due: true,
    refreshing: false,
    needsKey: false,
    findings: [],
    sources: [],
    via: null,
    top: [],
    ideas: [],
    googleTrends: [],
    nicheLeads: [],
  });
  (config as { desktopApp: boolean }).desktopApp = true;
  app = createApp();
});

afterEach(() => {
  // Every test file shares one DATA_DIR: a niche left accepted here would turn
  // up in someone else's catalog.
  dn._resetDiscoveredNichesForTests();
});

/** One Short as the scan would have recorded it. */
const short = (over: Partial<TrendingShort> & { id: string; title: string }): TrendingShort => ({
  url: `https://www.youtube.com/shorts/${over.id}`,
  views: 100_000,
  query: "#shorts",
  ...over,
});

/** Three different channels climbing on the same word — the bar a lead has to clear. */
const climbing = (word: string, rest = "") =>
  [1, 2, 3].map((n) =>
    short({ id: `${word}-${n}`, title: `${word} ${rest || "nobody explains this"}`.trim(), channel: `channel-${n}`, views: 500_000 / n, velocity: 9_000 / n }),
  );

describe("the free scan signal", () => {
  it("finds a topic climbing across channels that none of the nine covers", () => {
    const leads = nicheLeads(climbing("quantum"));
    expect(leads.map((l) => l.topic)).toContain("quantum");
    const found = leads.find((l) => l.topic === "quantum")!;
    expect(found.from).toBe("youtube");
    expect(found.channels).toBe(3);
    expect(found.views).toBeGreaterThan(0);
    expect(found.velocity).toBeGreaterThan(0);
    // The evidence travels with it, so the card shows real Shorts and not a word.
    expect(found.examples).toHaveLength(3);
    expect(found.examples[0]!.title).toContain("quantum");
    expect(found.examples[0]!.url).toMatch(/^https:\/\/www\.youtube\.com\/shorts\//);
    expect(found.examples.map((e) => e.views)).toEqual([...found.examples.map((e) => e.views)].sort((a, b) => b - a));
  });

  it("ignores a topic that is really one of the standing niches, however it was found", () => {
    // A general search can surface psychology; that isn't a new niche.
    const leads = nicheLeads(climbing("psychology", "of pricing"));
    expect(leads.map((l) => l.topic)).not.toContain("psychology");
    expect(nicheLeads(climbing("motivation"))).toEqual([]);
    expect(nicheLeads(climbing("true crime"))).toEqual([]);
  });

  it("ignores what the niche searches themselves turned up", () => {
    const fromNicheSearch = climbing("quantum").map((s) => ({ ...s, query: "Psychology & Mind Tricks" }));
    expect(nicheLeads(fromNicheSearch)).toEqual([]);
  });

  it("ignores one channel's gimmick — three channels is a niche, one is a person", () => {
    const oneChannel = [1, 2, 3, 4].map((n) => short({ id: `solo-${n}`, title: `quantum thing ${n}`, channel: "the-same-channel", views: 900_000 }));
    expect(nicheLeads(oneChannel)).toEqual([]);
  });

  it("ignores Shorts with no view count, which prove nothing about climbing", () => {
    expect(nicheLeads(climbing("quantum").map((s) => ({ ...s, views: 0 })))).toEqual([]);
  });

  it("puts the day's searches first: a topic about to break is earlier than one already on Shorts", () => {
    const leads = nicheLeads(climbing("quantum"), ["some brand new search", "quantum"]);
    expect(leads[0]).toMatchObject({ topic: "some brand new search", from: "google-trends", channels: 0, views: 0, examples: [] });
    // A search that is only the same word again isn't offered twice.
    expect(leads.filter((l) => l.topic === "quantum")).toHaveLength(1);
    // And a search that belongs to a niche we have isn't new either.
    expect(nicheLeads([], ["psychology tricks"]).map((l) => l.topic)).toEqual([]);
  });

  it("caps the list, so a noisy week doesn't bury the person in suggestions", () => {
    const noisy = ["quantum", "mycology", "brutalism", "hydroponics"].flatMap((w) => climbing(w));
    expect(nicheLeads(noisy, [], 3)).toHaveLength(3);
    expect(nicheLeads(noisy).length).toBeLessThanOrEqual(6);
  });
});

describe("proposing", () => {
  const good = {
    name: "Quantum Computing",
    description: "The strange machinery under everything computational",
    audience: "People who like feeling clever about something genuinely hard.",
    angles: ["a paradox that turns out to be the whole point", "why a quantum bit isn't a faster bit", "the error that makes the machine work"],
    never: "No claiming a quantum computer is just a faster laptop — say what it is actually for.",
    evidence: "Three channels climbing on quantum this week, 500K views on the newest.",
  };

  it("stores a full proposal as pending, with an id made from the name", () => {
    const res = dn.proposeNiche(good);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.proposal).toMatchObject({ id: "quantum-computing", name: "Quantum Computing", status: "pending", discovered: true });
    expect(res.proposal.decidedAt).toBeNull();
    expect(dn.listNicheProposals("pending")).toHaveLength(1);
    expect(dn.discoveredNicheCounts()).toEqual({ pending: 1, accepted: 0 });
    // Pending is not on the tab yet — that's the whole point of the approval step.
    expect(dn.allNiches().map((n) => n.id)).not.toContain("quantum-computing");
    expect(dn.discoveredNiches()).toEqual([]);
  });

  it("refuses a proposal too thin to write scripts from, and says what's missing", () => {
    const res = dn.proposeNiche({ name: "Quantum" });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toMatch(/audience|angles|kills it|evidence|description/);
    expect(dn.listNicheProposals()).toEqual([]);
  });

  it("refuses one field at a time rather than storing it half-formed", () => {
    for (const missing of ["name", "description", "audience", "never", "evidence"] as const) {
      const partial = { ...good, [missing]: "" };
      expect(dn.proposeNiche(partial).ok, missing).toBe(false);
    }
    expect(dn.proposeNiche({ ...good, angles: ["only one"] }).ok).toBe(false);
    expect(dn.listNicheProposals(), "nothing half-formed was stored").toEqual([]);
  });

  it("refuses a niche the app already has, and one that only sounds new", () => {
    expect(dn.proposeNiche({ ...good, name: "Money & Wealth" })).toMatchObject({ ok: false });
    const covered = dn.proposeNiche({
      ...good,
      name: "Pricing Psychology",
      description: "Why people pay what they pay",
      angles: ["a bias behind a price", "the number that anchors the rest"],
    });
    expect(covered.ok).toBe(false);
    if (!covered.ok) expect(covered.reason).toMatch(/Psychology/);
  });

  it("doesn't store the same proposal twice, and tells the agent it's still waiting", () => {
    expect(dn.proposeNiche(good).ok).toBe(true);
    const again = dn.proposeNiche(good);
    expect(again).toMatchObject({ ok: true, alreadyPending: true });
    expect(dn.listNicheProposals("pending")).toHaveLength(1);
  });

  it("won't re-propose something the person already dismissed", () => {
    dn.proposeNiche(good);
    dn.decideNicheProposal("quantum-computing", "dismissed");
    const again = dn.proposeNiche(good);
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.reason).toMatch(/dismissed/);
  });

  it("drops hook ids it doesn't know, and uses the topic-agnostic three when none are given", () => {
    const res = dn.proposeNiche({ ...good, hooks: ["question-gap", "not-a-shape", "myth"] });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.proposal.hooks).toEqual(["question-gap", "myth"]);
    const none = dn.proposeNiche({ ...good, name: "Mycology", hooks: ["nope"] });
    expect(none.ok).toBe(true);
    if (none.ok) expect(none.proposal.hooks).toEqual(dn.DEFAULT_DISCOVERED_HOOKS);
    for (const h of none.ok ? none.proposal.hooks : []) expect(viral.hookById(h), h).toBeTruthy();
  });

  it("keeps the file readable when it is junk, rather than crashing the Generate tab", () => {
    const file = path.join(config.dataDir, "niches.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{ not json");
    dn._forgetDiscoveredNicheCacheForTests();
    expect(dn.listNicheProposals()).toEqual([]);
    fs.writeFileSync(file, JSON.stringify({ proposals: [{ id: 1 }, null, { id: "x", name: "X", description: "d", angles: [], status: "accepted" }] }));
    dn._forgetDiscoveredNicheCacheForTests();
    // The malformed entries are dropped; the shaped one survives.
    expect(dn.listNicheProposals().map((p) => p.id)).toEqual(["x"]);
  });

  it("prunes decided ones past the cap but never drops something still waiting", () => {
    for (let i = 0; i < 50; i++) {
      dn.proposeNiche({ ...good, name: `Niche Number ${i}`, description: `description ${i}`, angles: ["angle one", "angle two"] });
      dn.decideNicheProposal(`niche-number-${i}`, i % 2 ? "accepted" : "dismissed");
    }
    dn.proposeNiche({ ...good, name: "Still Waiting", description: "one that hasn't been decided", angles: ["angle one", "angle two"] });
    expect(dn.listNicheProposals("pending").map((p) => p.name)).toContain("Still Waiting");
    expect(dn.listNicheProposals().length).toBeLessThanOrEqual(41);
  });

  it("makes an id that is safe as a filename and as a URL", () => {
    expect(dn.nicheIdFromName("Quantum Computing!")).toBe("quantum-computing");
    expect(dn.nicheIdFromName("  AI & Future  Tech  ")).toBe("ai-future-tech");
    expect(dn.nicheIdFromName("Café Culture")).toBe("cafe-culture");
    expect(dn.nicheIdFromName("!!!")).toBe("");
  });
});

describe("deciding", () => {
  const good = {
    name: "Quantum Computing",
    description: "The strange machinery under everything computational",
    audience: "People who like feeling clever about something hard.",
    angles: ["a paradox that is the whole point", "why a qubit isn't a faster bit"],
    never: "No claiming it's just a faster laptop.",
    evidence: "Three channels climbing on quantum this week.",
  };

  it("accepting is what puts it on the tab, in the list scripts are written from", () => {
    dn.proposeNiche(good);
    const decided = dn.decideNicheProposal("quantum-computing", "accepted");
    expect(decided).toMatchObject({ status: "accepted" });
    expect(decided!.decidedAt).toBeGreaterThan(0);
    expect(dn.listNicheProposals("pending")).toEqual([]);
    const ids = dn.allNiches().map((n) => n.id);
    expect(ids).toContain("quantum-computing");
    // The nine researched ones are all still there, in their order, and first.
    expect(ids.slice(0, viral.NICHES.length)).toEqual(viral.NICHE_IDS);
    const found = dn.discoveredNiches()[0]!;
    expect(found).toMatchObject({ id: "quantum-computing", name: "Quantum Computing", short: good.description, audience: good.audience, never: good.never });
    expect(found.angles).toEqual(good.angles);
    expect(found.hooks.length).toBeGreaterThan(0);
  });

  it("dismisses, and says so for a proposal that isn't there", () => {
    dn.proposeNiche(good);
    expect(dn.decideNicheProposal("quantum-computing", "dismissed")).toMatchObject({ status: "dismissed" });
    expect(dn.discoveredNiches()).toEqual([]);
    expect(dn.decideNicheProposal("no-such-niche", "accepted")).toBeNull();
    expect(dn.decideNicheProposal("", "accepted")).toBeNull();
  });

  it("takes an accepted one back off the tab, and never removes a researched one", () => {
    dn.proposeNiche(good);
    dn.decideNicheProposal("quantum-computing", "accepted");
    expect(dn.removeDiscoveredNiche("psychology")).toBe(false);
    expect(dn.removeDiscoveredNiche("no-such-niche")).toBe(false);
    expect(dn.allNiches()).toHaveLength(viral.NICHES.length + 1);
    expect(dn.removeDiscoveredNiche("quantum-computing")).toBe(true);
    expect(dn.allNiches()).toHaveLength(viral.NICHES.length);
  });

  it("persists across a restart: the file, not a cache, is the list", () => {
    dn.proposeNiche(good);
    dn.decideNicheProposal("quantum-computing", "accepted");
    const file = path.join(config.dataDir, "niches.json");
    expect(JSON.parse(fs.readFileSync(file, "utf8")).proposals[0]).toMatchObject({ id: "quantum-computing", status: "accepted" });
    // Drop the in-memory copy the way a new process would have none.
    dn._forgetDiscoveredNicheCacheForTests();
    expect(dn.discoveredNiches().map((n) => n.id)).toEqual(["quantum-computing"]);
    expect(dn.resolveNiche("quantum-computing").id).toBe("quantum-computing");
  });
});

describe("resolveNiche — an accepted niche really reaches the script engine", () => {
  const accept = () => {
    dn.proposeNiche({
      name: "Quantum Computing",
      description: "The strange machinery under everything computational",
      audience: "People who like feeling clever about something hard.",
      angles: ["a paradox that is the whole point", "why a qubit isn't a faster bit"],
      never: "No claiming it's just a faster laptop.",
      evidence: "Three channels climbing on quantum this week.",
    });
    dn.decideNicheProposal("quantum-computing", "accepted");
  };

  it("finds it by id, by name, and by the words in a loose topic", () => {
    accept();
    expect(dn.resolveNiche("quantum-computing").id).toBe("quantum-computing");
    expect(dn.resolveNiche("Quantum Computing").id).toBe("quantum-computing");
    expect(dn.resolveNiche("quantum computing").id).toBe("quantum-computing");
    expect(dn.resolveNiche("make me one about quantum computing").id).toBe("quantum-computing");
  });

  it("still routes the standing niches' own topics to them, not to the new one", () => {
    accept();
    expect(dn.resolveNiche("psychology").id).toBe("psychology");
    expect(dn.resolveNiche("a bias that runs a decision").id).toBe("psychology");
    expect(dn.resolveNiche("money and investing").id).toBe("finance");
  });

  it("falls back to facts for a topic nothing covers — not to whatever was discovered last", () => {
    accept();
    expect(dn.resolveNiche("something entirely unrelated").id).toBe("facts");
    expect(dn.resolveNiche("").id).toBe("facts");
    expect(dn.resolveNiche(undefined).id).toBe("facts");
    // Which is exactly what detectNiche has always done.
    expect(dn.resolveNiche("something entirely unrelated").id).toBe(viral.detectNiche("something entirely unrelated").id);
  });

  it("isn't reachable before it's accepted, so nothing writes for an unapproved niche", () => {
    dn.proposeNiche({
      name: "Quantum Computing",
      description: "The strange machinery under everything computational",
      audience: "People who like feeling clever about something hard.",
      angles: ["a paradox that is the whole point", "why a qubit isn't a faster bit"],
      never: "No claiming it's just a faster laptop.",
      evidence: "Three channels climbing on quantum this week.",
    });
    expect(dn.resolveNiche("quantum-computing").id).not.toBe("quantum-computing");
  });
});

describe("the catalog the Generate tab renders", () => {
  it("carries everything the picker and the script engine need, and marks what was found", () => {
    const before = dn.fullNicheCatalog();
    expect(before).toHaveLength(viral.NICHES.length);
    expect(before[0]).toMatchObject({ id: "psychology", discovered: false, addedAt: null });
    expect(before[0]!.sampleScripts.length).toBeGreaterThan(0);
    expect(before[0]!.angles.length).toBeGreaterThan(0);
    expect(typeof before[0]!.never).toBe("string");

    dn.proposeNiche({
      name: "Quantum Computing",
      description: "The strange machinery under everything computational",
      audience: "People who like feeling clever about something hard.",
      angles: ["a paradox that is the whole point", "why a qubit isn't a faster bit"],
      never: "No claiming it's just a faster laptop.",
      evidence: "Three channels climbing on quantum this week.",
    });
    // Proposed but not accepted: still not on the tab.
    expect(dn.fullNicheCatalog()).toHaveLength(viral.NICHES.length);
    dn.decideNicheProposal("quantum-computing", "accepted");

    const after = dn.fullNicheCatalog();
    expect(after).toHaveLength(viral.NICHES.length + 1);
    const found = after[after.length - 1]!;
    expect(found).toMatchObject({ id: "quantum-computing", discovered: true });
    expect(found.addedAt).toBeGreaterThan(0);
    // No samples of its own — pickTemplate falls back to facts' rather than
    // inventing a script for a niche nobody has written for yet.
    expect(found.sampleScripts).toEqual([]);
    expect(viral.pickTemplate(found.id, "quantum")).toBeTruthy();
    expect(after.map((n) => n.id).slice(0, viral.NICHES.length)).toEqual(viral.NICHE_IDS);
  });
});

describe("the routes the Generate tab uses", () => {
  const propose = () =>
    dn.proposeNiche({
      name: "Quantum Computing",
      description: "The strange machinery under everything computational",
      audience: "People who like feeling clever about something hard.",
      angles: ["a paradox that is the whole point", "why a qubit isn't a faster bit"],
      never: "No claiming it's just a faster laptop.",
      evidence: "Three channels climbing on quantum this week.",
    });

  it("answers with the niches, what's waiting, and the leads behind it", async () => {
    const res = await request(app).get("/api/v1/agent/niches").expect(200);
    expect(res.body.niches).toHaveLength(viral.NICHES.length);
    expect(res.body.proposals).toEqual([]);
    expect(res.body.counts).toEqual({ pending: 0, accepted: 0 });
    expect(Array.isArray(res.body.leads)).toBe(true);

    propose();
    const after = await request(app).get("/api/v1/agent/niches").expect(200);
    expect(after.body.counts).toEqual({ pending: 1, accepted: 0 });
    expect(after.body.proposals[0]).toMatchObject({ id: "quantum-computing", name: "Quantum Computing", status: "pending" });
    // The person reads the evidence, so it has to be in the answer.
    expect(after.body.proposals[0].evidence).toMatch(/quantum/i);
    expect(after.body.proposals[0].angles).toHaveLength(2);
    // Still not a niche until they say so.
    expect(after.body.niches.map((n: { id: string }) => n.id)).not.toContain("quantum-computing");
  });

  it("accepts, and the tab's own answer now includes it", async () => {
    propose();
    const res = await request(app).post("/api/v1/agent/niches/proposals/quantum-computing/accept").expect(200);
    expect(res.body).toMatchObject({ ok: true });
    expect(res.body.proposal).toMatchObject({ status: "accepted" });
    expect(res.body.proposals).toEqual([]);
    expect(res.body.counts).toEqual({ pending: 0, accepted: 1 });
    expect(res.body.niches.map((n: { id: string }) => n.id)).toContain("quantum-computing");
  });

  it("dismisses, and says so when there's nothing by that name", async () => {
    propose();
    const res = await request(app).post("/api/v1/agent/niches/proposals/quantum-computing/dismiss").expect(200);
    expect(res.body.proposal).toMatchObject({ status: "dismissed" });
    const missing = await request(app).post("/api/v1/agent/niches/proposals/nope/accept").expect(404);
    expect(missing.body.error).toMatch(/no proposal/i);
    // Deciding twice doesn't invent a second decision.
    await request(app).post("/api/v1/agent/niches/proposals/quantum-computing/accept").expect(404);
  });

  it("accepts by name as well as id, because the agent has the name", async () => {
    propose();
    const res = await request(app).post(`/api/v1/agent/niches/proposals/${encodeURIComponent("Quantum Computing")}/accept`).expect(200);
    expect(res.body.proposal).toMatchObject({ id: "quantum-computing", status: "accepted" });
  });

  it("removes an accepted one and refuses a researched one", async () => {
    propose();
    await request(app).post("/api/v1/agent/niches/proposals/quantum-computing/accept").expect(200);
    await request(app).delete("/api/v1/agent/niches/psychology").expect(400);
    expect(dn.allNiches()).toHaveLength(viral.NICHES.length + 1);
    const res = await request(app).delete("/api/v1/agent/niches/quantum-computing").expect(200);
    expect(res.body.niches).toHaveLength(viral.NICHES.length);
  });
});

describe("the propose_niche tool", () => {
  const tool = (desktop = true) => toolsFor(ctx(desktop)).find((t) => t.declaration.name === "propose_niche");
  const args = {
    name: "Quantum Computing",
    description: "The strange machinery under everything computational",
    audience: "People who like feeling clever about something hard.",
    angles: ["a paradox that is the whole point", "why a qubit isn't a faster bit"],
    never: "No claiming it's just a faster laptop.",
    evidence: "Three channels climbing on quantum this week.",
  };

  it("is offered where the scan runs, and not on a hosted server", () => {
    expect(tool(true)).toBeTruthy();
    expect(tool(false)).toBeUndefined();
  });

  it("is a side effect, so a retried turn can't propose it twice", () => {
    expect(tool()!.sideEffect).toBe(true);
  });

  it("proposes, and says plainly that it is waiting rather than added", async () => {
    const res = await tool()!.run(args, ctx());
    expect(res).toMatchObject({ proposed: true, id: "quantum-computing", name: "Quantum Computing" });
    expect(String(res.note)).toMatch(/waiting in the Generate tab/);
    expect(String(res.note)).toMatch(/not on the list yet/);
    expect(dn.listNicheProposals("pending")).toHaveLength(1);
    // The agent must not be able to accept its own proposal.
    expect(dn.discoveredNiches()).toEqual([]);
  });

  it("passes the refusal back as words the agent can tell the person", async () => {
    const res = await tool()!.run({ name: "Quantum" }, ctx());
    expect(res.proposed).toBe(false);
    expect(String(res.reason).length).toBeGreaterThan(20);
    expect(dn.listNicheProposals()).toEqual([]);
  });

  it("says so when it was already waiting, instead of stacking duplicates", async () => {
    await tool()!.run(args, ctx());
    const again = await tool()!.run(args, ctx());
    expect(again).toMatchObject({ proposed: true, alreadyWaiting: true });
    expect(String(again.note)).toMatch(/already waiting/);
    expect(dn.listNicheProposals("pending")).toHaveLength(1);
  });

  it("backs the claim with the scan's own leads when the topic matches one", async () => {
    // No digest on disk here, so nothing matches — the point is that it is
    // attached from the scan rather than trusted from the model.
    const res = await tool()!.run(args, ctx());
    expect(res).toMatchObject({ leadsAttached: 0 });
    expect(res.proposed).toBe(true);
  });

  it("ignores junk arguments without throwing", async () => {
    const res = await tool()!.run({ name: null, angles: "not an array" }, ctx());
    expect(res.proposed).toBe(false);
  });
});

describe("what the agent is told", () => {
  it("mentions proposing only when the tool is offered, and only as a suggestion", () => {
    const withTool = agentInstruction({ tools: ["whats_trending", "propose_niche"], webSearch: false });
    expect(withTool).toContain("Propose a new niche with propose_niche");
    expect(withTool).toContain("the person accepts or dismisses it");
    expect(withTool).toContain("never say it was added");
    expect(agentInstruction({ tools: ["whats_trending"], webSearch: false })).not.toContain("propose_niche");
  });

  it("describes the tool's own contract in its declaration", () => {
    const decl = tool_decl();
    expect(decl.parameters.required).toEqual(expect.arrayContaining(["name", "description", "audience", "angles", "never", "evidence"]));
    expect(decl.parameters.properties.hooks.items.enum).toEqual(viral.HOOK_PATTERNS.map((h) => h.id));
    expect(decl.description).toMatch(/nothing changes until the person accepts/i);
  });
});

function tool_decl() {
  const t = toolsFor(ctx(true)).find((x) => x.declaration.name === "propose_niche")!;
  return t.declaration as unknown as {
    description: string;
    parameters: { required: string[]; properties: { hooks: { items: { enum: string[] } } } };
  };
}

describe("the leads reach the agent through whats_trending", () => {
  const digestWith = (nicheLeads: NicheLead[]) => ({
    available: true,
    researchedAt: "2026-10-06T09:00:00.000Z",
    ageDays: 0,
    due: false,
    refreshing: false,
    needsKey: false,
    findings: ["Fastest climber: some short — 1.2M views in 3 days."],
    sources: ["YouTube search"],
    via: "youtube" as const,
    top: [],
    ideas: [],
    googleTrends: [],
    nicheLeads,
  });

  it("hands the agent the topics climbing outside the list, and tells it what to do with them", async () => {
    mocks.trendsStatus.mockReturnValue(
      digestWith([
        { topic: "quantum", from: "youtube", channels: 4, views: 1_800_000, velocity: 9_000, examples: [{ title: "quantum nobody explains this", url: "https://www.youtube.com/shorts/q1", views: 900_000 }] },
        { topic: "brutalism", from: "google-trends", channels: 0, views: 0, examples: [] },
      ]),
    );
    const tool = toolsFor(ctx(true)).find((t) => t.declaration.name === "whats_trending")!;
    const res = await tool.run({}, ctx());
    expect(res.ok).toBe(true);
    expect(res.nicheLeads).toHaveLength(2);
    expect(res.nicheLeads).toEqual(expect.arrayContaining([expect.objectContaining({ topic: "quantum", channels: 4 })]));
    // The nudge names propose_niche and the topics, so the agent connects them.
    expect(String(res.nicheLeadNote)).toContain("propose_niche");
    expect(String(res.nicheLeadNote)).toContain("quantum");
    expect(String(res.nicheLeadNote)).toContain("brutalism");
  });

  it("says nothing about niches when the scan found none outside the list", async () => {
    mocks.trendsStatus.mockReturnValue(digestWith([]));
    const tool = toolsFor(ctx(true)).find((t) => t.declaration.name === "whats_trending")!;
    const res = await tool.run({}, ctx());
    expect(res.ok).toBe(true);
    expect(res.nicheLeads).toEqual([]);
    // No lead, no nudge: inventing one would have the agent proposing noise.
    expect(res.nicheLeadNote).toBeUndefined();
  });

  it("and propose_niche attaches the matching lead as its evidence", async () => {
    mocks.trendsStatus.mockReturnValue(
      digestWith([{ topic: "quantum", from: "youtube", channels: 4, views: 1_800_000, examples: [{ title: "quantum nobody explains this", url: "https://www.youtube.com/shorts/q1", views: 900_000 }] }]),
    );
    const tool = toolsFor(ctx(true)).find((t) => t.declaration.name === "propose_niche")!;
    const res = await tool.run(
      {
        name: "Quantum Computing",
        description: "The strange machinery under everything computational",
        audience: "People who like feeling clever about something hard.",
        angles: ["a paradox that is the whole point", "why a qubit isn't a faster bit"],
        never: "No claiming it's just a faster laptop.",
        evidence: "Four channels climbing on quantum this week.",
      },
      ctx(),
    );
    expect(res).toMatchObject({ proposed: true, leadsAttached: 1 });
    const stored = dn.listNicheProposals("pending")[0]!;
    expect(stored.leads[0]).toMatchObject({ topic: "quantum", channels: 4 });
    expect(stored.leads[0]!.examples[0]!.url).toMatch(/youtube\.com\/shorts\/q1/);
  });
});

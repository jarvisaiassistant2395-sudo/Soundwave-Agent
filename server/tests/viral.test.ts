// The scripting engine: the niches, the length math, the script doctor every
// narration has to pass, and the brief Gemini writes from. These tests are
// deliberately strict — the samples that ship to /niches and to the no-key
// fallback must be scripts the app itself would accept.
import fs from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SECONDS,
  HOOK_PATTERNS,
  NICHES,
  NICHE_IDS,
  SAMPLE_SCRIPTS,
  SHORT_LENGTHS,
  WORDS_PER_SECOND,
  buildScriptInstruction,
  detectNiche,
  estimateSeconds,
  hookById,
  lintScript,
  nicheById,
  nicheCatalog,
  pickTemplate,
  scriptWordTarget,
} from "../src/lib/brain/core/viral.js";

describe("the niches", () => {
  it("covers the researched categories with one entry each", () => {
    expect(NICHE_IDS).toHaveLength(9);
    expect(new Set(NICHE_IDS).size).toBe(9);
    expect(NICHE_IDS).toEqual(["psychology", "facts", "history", "finance", "ai", "motivation", "horror", "crime", "health"]);
  });

  it("gives every niche a recipe, real hook shapes and its own trap", () => {
    for (const n of NICHES) {
      expect(n.name.length, n.id).toBeGreaterThan(3);
      expect(n.angles.length, n.id).toBeGreaterThanOrEqual(3);
      expect(n.never.length, n.id).toBeGreaterThan(20);
      expect(n.hooks.length, n.id).toBeGreaterThanOrEqual(2);
      for (const h of n.hooks) expect(hookById(h), `${n.id} → ${h}`).toBeTruthy();
    }
    expect(new Set(HOOK_PATTERNS.map((h) => h.id)).size).toBe(HOOK_PATTERNS.length);
    for (const h of HOOK_PATTERNS) {
      expect(h.example.length, h.id).toBeGreaterThan(30);
      expect(h.shape.length, h.id).toBeGreaterThan(15);
    }
  });

  it("keeps an exact id or name as the answer (the Generate button sends one)", () => {
    for (const n of NICHES) {
      expect(detectNiche(n.id).id, n.id).toBe(n.id);
      expect(detectNiche(n.name).id, n.name).toBe(n.id);
    }
  });

  it("reads a loose topic the way a person would", () => {
    expect(detectNiche("why your brain remembers insults").id).toBe("psychology");
    expect(detectNiche("the truth about index funds and debt").id).toBe("finance");
    expect(detectNiche("how ChatGPT changed my workflow").id).toBe("ai");
    expect(detectNiche("the shortest war in history").id).toBe("history");
    expect(detectNiche("a haunted lighthouse in 1900").id).toBe("horror");
    expect(detectNiche("the cold case solved by a photocopier").id).toBe("crime");
    expect(detectNiche("why you wake up tired").id).toBe("health");
    expect(detectNiche("discipline beats motivation").id).toBe("motivation");
    expect(detectNiche("sharks are older than trees").id).toBe("facts");
    // Nothing recognisable: a safe default, never a crash.
    expect(detectNiche("").id).toBe("facts");
    expect(nicheById("nope").id).toBe("facts");
  });

  it("exposes the catalog the API and the picker use", () => {
    const catalog = nicheCatalog();
    expect(catalog.map((c) => c.id)).toEqual(NICHE_IDS);
    for (const c of catalog) {
      expect(c.description.length).toBeGreaterThan(10);
      expect(c.hooks.length).toBeGreaterThanOrEqual(2);
      expect(c.sampleScripts.length).toBeGreaterThanOrEqual(2);
    }
  });
});

describe("length and pacing", () => {
  it("turns seconds into words with the measured speaking pace", () => {
    expect(WORDS_PER_SECOND).toBeGreaterThan(2);
    expect(scriptWordTarget(60)).toEqual({ target: 144, min: 127, max: 156 });
    expect(scriptWordTarget(30).target).toBe(72);
    expect(estimateSeconds(144)).toBe(60);
    expect(SHORT_LENGTHS).toContain(DEFAULT_SECONDS);
  });
});

describe("the script doctor", () => {
  const GOOD = [
    "Stop keeping savings in a checking account — inflation eats it every year.",
    "If the bank pays a fraction of a percent while prices rise a few percent, the number on your screen grows and what it buys shrinks.",
    "A hundred dollars left in a drawer for twenty years still says one hundred.",
    "It buys noticeably less.",
    "Here is the trap nobody mentions: the number never goes down, so the loss feels like safety.",
    "Check the rate your savings actually earns, move what you will not touch for years, and leave the rest alone.",
    "But here is the trap: the feeling of safety is doing the damage.",
    "A rate that beats inflation by one percent turns a hundred dollars into more than a hundred dollars of groceries, which is the only test that matters over twenty years.",
    "Because a checking account is a place to park money, not a place to keep it.",
  ].join(" ");

  it("passes a script that follows the research shape", () => {
    const lint = lintScript(GOOD, { seconds: 60 });
    expect(lint.issues).toEqual([]);
    expect(lint.ok).toBe(true);
    expect(lint.score).toBe(100);
    expect(lint.metrics.hasNumber).toBe(true);
    expect(lint.metrics.shortestSentence).toBeLessThanOrEqual(8);
    expect(lint.metrics.seconds).toBeGreaterThan(30);
  });

  it("catches every way a script fails, with a fix for each", () => {
    const short = lintScript("Did you know that honey never spoils?", { seconds: 60 });
    expect(short.ok).toBe(false);
    expect(short.issues.join(" ")).toMatch(/Too short/);
    expect(short.issues.join(" ")).toMatch(/did you know/);

    const greeting = lintScript(
      "Hey guys, welcome back to the channel. Today we are talking about sleep, and there are many interesting things to say about sleep and how it works in the body. Sleep is important for the brain and for the body, and everyone should try to get more of it every night. Thanks for watching, and I will see you in the next one, so stay tuned for that.",
      { seconds: 60 },
    );
    const greetingIssues = greeting.issues.join(" ");
    expect(greetingIssues).toMatch(/greeting/i);
    expect(greetingIssues).toMatch(/thanks for watching|stay tuned/);

    const labels = lintScript("#1 Hook: this is fine. Narrator: it is not fine at all, and here is why that matters so much for everyone involved today, honestly speaking.", { seconds: 60 });
    expect(labels.issues.join(" ")).toMatch(/labels|markdown|hashtags/i);

    const flat = lintScript(
      "The city council decided to change the traffic rules on the main road last year, and the change affected thousands of drivers who use that road every single day to get to work. The new rules were designed to reduce accidents at the intersection where several collisions had happened in the previous two years. Drivers complained about the new timing of the lights and the longer waits during the morning rush hour period. The council said the data showed fewer crashes after the change, and they plan to keep the system running.",
      { seconds: 60 },
    );
    const flatIssues = flat.issues.join(" ");
    expect(flatIssues).toMatch(/short punch|turn in the middle|ending/i);

    const vague = lintScript(
      "Something strange happens to everyone at some point in their life, and most of us never stop to ask why it happens. It could be anything at all.",
      { seconds: 60 },
    );
    expect(vague.issues.join(" ")).toMatch(/Too short|concrete/i);
  });

  it("keeps the loop requirement: the ending must hand the opening back", () => {
    const noLoop = lintScript(
      "Water covers most of the planet and hides things we have never seen. The deep ocean is cold, dark and under enormous pressure, which is why exploring it is so difficult and expensive for researchers. Only a small fraction of the sea floor has been mapped in any real detail at all. They will keep looking.",
      { seconds: 60 },
    );
    expect(noLoop.issues.join(" ")).toMatch(/ending just stops|echo/i);
    expect(noLoop.metrics.loopWords.length).toBe(0);

    const loops = lintScript(
      "Water covers most of the planet and hides things we have never seen. The deep ocean is cold, dark and under enormous pressure, which is why exploring it is hard. But here is the part that changes how you think about the map: the team found a species living at a depth where nothing should survive. They will keep looking at the water, and the water will keep what it has not shown yet.",
      { seconds: 30 },
    );
    expect(loops.metrics.loopWords).toContain("water");
    expect(loops.issues.join(" ")).not.toMatch(/ending just stops/);
  });

  it("reads the length against the short being made, not one fixed target", () => {
    const sixty = lintScript(GOOD, { seconds: 60 });
    const thirty = lintScript(GOOD, { seconds: 30 });
    expect(sixty.issues.join(" ")).not.toMatch(/Too long/);
    expect(thirty.issues.join(" ")).toMatch(/Too long/);
  });
});

describe("the shipped sample scripts", () => {
  it("gives every niche at least two, and every one passes the doctor", () => {
    for (const n of NICHES) {
      const samples = SAMPLE_SCRIPTS[n.id] ?? [];
      expect(samples.length, n.id).toBeGreaterThanOrEqual(2);
      samples.forEach((sample, i) => {
        const lint = lintScript(sample, { seconds: DEFAULT_SECONDS, nicheId: n.id });
        expect(lint.issues, `${n.id} sample ${i + 1}: ${lint.issues.join(" | ")}`).toEqual([]);
      });
    }
  });

  it("picks an untouched sample for whatever the topic is — nothing is spliced", () => {
    const all = Object.values(SAMPLE_SCRIPTS).flat();
    const topics = [
      ...NICHES.map((n) => n.name),
      ...NICHES.map((n) => n.id),
      "make a short about why the sky is blue",
      "how do banks make money from my savings account",
      "the creepiest thing that ever happened in a lighthouse",
      "why am i tired at two in the afternoon",
      "a topic line far too long to be a hook because someone pasted a whole sentence into the box and pressed generate",
    ];
    for (const topic of topics) {
      const picked = pickTemplate(detectNiche(topic).id, topic);
      expect(all, topic).toContain(picked);
      expect(lintScript(picked, { seconds: DEFAULT_SECONDS }).issues, topic).toEqual([]);
    }
  });

  it("routes a topic into the sample that talks about it", () => {
    expect(pickTemplate("psychology", "why do people mirror each other without noticing")).toContain("mirror");
    expect(pickTemplate("health", "why am i tired at two in the afternoon")).toContain("two o'clock slump");
  });

  it("keeps the Generate button's list in step with the engine", () => {
    const hub = fs.readFileSync(new URL("../../frontend/src/pages/AgentHub.tsx", import.meta.url), "utf8");
    const block = hub.split("const NICHES: NicheInfo[] = [")[1]?.split("];")[0] ?? "";
    const ids = [...block.matchAll(/id: "([^"]+)"/g)].map((m) => m[1]);
    expect(ids).toEqual(NICHE_IDS);
  });
});

describe("the writing brief", () => {
  it("carries the shape, the niche recipe, the hook shapes and the rules", () => {
    const brief = buildScriptInstruction({ seconds: 60, niche: nicheById("crime") });
    expect(brief).toContain("60-second narration");
    expect(brief).toContain("127–156 words");
    expect(brief).toContain("True Crime & Cold Cases");
    expect(brief).toContain("BREADCRUMB");
    expect(brief).toContain("LOOP");
    expect(brief).toContain("Never invent a number");
    expect(brief).toContain("did you know");
    expect(brief).toContain("EXAMPLES OF THE BAR");
    expect(brief).toContain(SAMPLE_SCRIPTS.crime![0]!);
    // The niche's own trap travels with the brief.
    expect(brief).toContain("never invent a detail for a case");
  });

  it("follows the chosen length", () => {
    const brief = buildScriptInstruction({ seconds: 30, niche: nicheById("facts") });
    expect(brief).toContain("30-second narration");
    expect(brief).toContain("63–78 words");
  });

  it("turns into a repair brief that lists the doctor's findings", () => {
    const brief = buildScriptInstruction({
      seconds: 60,
      niche: nicheById("finance"),
      previous: "Hey guys, did you know money is complicated?",
      issues: ["The first line opens with a greeting.", "Too short: 8 words."],
    });
    expect(brief).toContain("script doctor rejected");
    expect(brief).toContain("Hey guys, did you know money is complicated?");
    expect(brief).toContain("- The first line opens with a greeting.");
    expect(brief).toContain("- Too short: 8 words.");
    expect(brief).toContain("Rewrite the whole narration from scratch");
    expect(brief).not.toContain("EXAMPLES OF THE BAR");
  });
});

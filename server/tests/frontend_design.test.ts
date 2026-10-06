// ── The Command Center's design tokens ──────────────────────────────────────
// tailwind.config.js defines a palette and a type scale, and Settings, Dashboard
// and the navbar have always been built from them. The Command Center wasn't: it
// carried 238 hand-typed hex colours and 173 hand-typed text sizes, five
// slightly different borders, and type down to 8px — three below the scale's own
// floor. It has been retyped onto the tokens, and this is what stops it drifting
// back, because nothing else would notice: the app builds and looks the same
// either way, it just slowly stops matching itself.
//
// Reading the frontend's source from a backend test is the established way this
// repo pins a contract that has no runtime to assert on — tests/viral.test.ts
// does the same for the niche list.

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const frontend = new URL("../../frontend/", import.meta.url);
const read = (rel: string) => fs.readFileSync(new URL(rel, frontend), "utf8");

/** The screens and cards that make up the Command Center. */
const COMMAND_CENTER = [
  "src/pages/AgentHub.tsx",
  "src/components/agent/AgentCard.tsx",
  "src/components/agent/BrainPill.tsx",
  "src/components/agent/ChannelRow.tsx",
  "src/components/agent/ClipsCard.tsx",
  "src/components/agent/EmailDraftCard.tsx",
  "src/components/agent/ModePill.tsx",
  "src/components/agent/NichePicker.tsx",
  "src/components/agent/NicheProposalCard.tsx",
  "src/components/agent/ShortCard.tsx",
  "src/components/agent/WatchCard.tsx",
  "src/components/agent/niches.tsx",
];

/**
 * Blue-tinted panels behind a chat message, a code block and a briefing. They
 * are colour used deliberately, not chrome reaching for a grey the palette
 * doesn't have, so they stay arbitrary.
 */
// Lowercase, because hexes are compared lowercased: a set that disagreed on
// case would look like a rule and behave like none.
const ALLOWED_HEX = new Set(["#040814", "#050b14", "#070f1e"]);

const hexes = (source: string) => [...source.matchAll(/\b(?:bg|border|text|from|to|via|ring|fill|stroke)-\[(#[0-9A-Fa-f]{3,8})\]/g)].map((m) => m[1]!.toLowerCase());
const sizes = (source: string) => [...source.matchAll(/\btext-\[(\d+(?:\.\d+)?)(px|rem)\]/g)].map((m) => `${m[1]}${m[2]}`);

describe("the Command Center is built from the design tokens", () => {
  it("every file it is made of exists", () => {
    for (const rel of COMMAND_CENTER) expect(fs.existsSync(new URL(rel, frontend)), rel).toBe(true);
  });

  it("has no hand-typed text sizes — the scale names them all", () => {
    for (const rel of COMMAND_CENTER) {
      const found = sizes(read(rel));
      expect(found, `${rel}: ${found.join(", ")}`).toEqual([]);
    }
  });

  it("has no hand-typed colours except the three deliberately tinted panels", () => {
    for (const rel of COMMAND_CENTER) {
      const stray = hexes(read(rel)).filter((h) => !ALLOWED_HEX.has(h));
      expect(stray, `${rel}: ${stray.join(", ")}`).toEqual([]);
    }
  });

  it("never sets type below 10px, anywhere in the app", () => {
    // 8px and 9px badges were the single worst thing about how the screen read:
    // they are under the legibility floor on anything that isn't a retina
    // laptop, and the app is meant to be glanced at from across a desk.
    const walk = (dir: string): string[] =>
      fs.readdirSync(new URL(dir, frontend), { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(`${dir}${e.name}/`) : e.name.endsWith(".tsx") ? [`${dir}${e.name}`] : [],
      );
    for (const rel of walk("src/")) {
      const tiny = [...read(rel).matchAll(/\btext-\[(\d+(?:\.\d+)?)px\]/g)].filter((m) => Number(m[1]) < 10);
      expect(tiny.map((m) => m[0]), rel).toEqual([]);
    }
  });
});

describe("the scale itself", () => {
  const config = read("tailwind.config.js");

  it("defines the two dense-chrome steps, with 10px as the floor", () => {
    expect(config).toMatch(/"3xs":\s*\["10px"/);
    expect(config).toMatch(/"2xs":\s*\["11px"/);
    expect(config).toMatch(/xs:\s*\["12px"/);
  });

  it("defines both border weights, so a card and its rows can each have an edge", () => {
    expect(config).toMatch(/border:\s*"rgba\(255, 255, 255, 0\.09\)"/);
    // The same value index.css's .surface-card has always used.
    expect(config).toMatch(/hairline:\s*"rgba\(255, 255, 255, 0\.07\)"/);
    expect(read("src/index.css")).toMatch(/border:\s*1px solid rgba\(255, 255, 255, 0\.07\)/);
  });

  it("keeps the surfaces the tokens say they are", () => {
    for (const [token, value] of [
      ["panel", "#0A0A0C"],
      ["DEFAULT", "#0A0A0C"],
      ["subtle", "#050506"],
      ["elevated", "#111114"],
      ["hover", "#191A20"],
    ] as Array<[string, string]>) {
      expect(config, token).toContain(value);
    }
  });

  it("is a config Tailwind can actually read", () => {
    // A typo here silently drops every token and the app renders unstyled.
    expect(config).toContain("export default");
    expect(path.basename(new URL("tailwind.config.js", frontend).pathname)).toBe("tailwind.config.js");
    expect(() => new Function(config.replace(/^export default/m, "return"))()).not.toThrow();
  });
});

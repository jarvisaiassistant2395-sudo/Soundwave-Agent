import { describe, expect, it } from "vitest";
import { briefingFailureNote, canWriteBriefingOnPhone, type CompanionPhase } from "./briefingSource";

// The rule this pins down, in the words of the bug it fixes: a run went red
// because the phone was restarted to check the morning briefing and, at that
// instant, its connection was still "connecting" — so the app decided there
// was nothing to do, showed the person "this phone doesn't have a Gemini key
// of its own yet", and never started the briefing. It was holding the key the
// whole time (the phone-mode banner on that same screen only shows when it is).

describe("who writes today's briefing", () => {
  it("lets the phone write it whenever it holds the key — even before it knows the PC is away", () => {
    for (const phase of ["connecting", "searching", "offline"] as CompanionPhase[]) {
      expect(canWriteBriefingOnPhone(phase, true), phase).toBe(true);
    }
  });

  it("keeps quiet when there is no key to write with", () => {
    for (const phase of ["connecting", "searching", "offline"] as CompanionPhase[]) {
      expect(canWriteBriefingOnPhone(phase, false), phase).toBe(false);
    }
  });

  it("never writes for a PC that removed this phone", () => {
    expect(canWriteBriefingOnPhone("forgotten", true)).toBe(false);
  });

  it("blames the PC only when the PC was actually asked — and only with what it said this time", () => {
    const asked = briefingFailureNote("online", { pcRefusedNote: "no Gemini key on the PC", hasKit: false });
    expect(asked).toMatch(/Your PC couldn't write today's briefing/);
    expect(asked).toMatch(/no Gemini key on the PC/);
    // No note from this attempt → the sentence must not invent one: a stale
    // note (a ref that was never cleared) once blamed a key the PC had had for
    // an hour, which is worse than saying less.
    const bare = briefingFailureNote("online", { hasKit: false });
    expect(bare).not.toMatch(/no Gemini key on the PC|no topics|memory isn't available/);
    expect(bare).toMatch(/hasn't got the key it needs/);
  });

  it("says a different thing when the phone did have the key", () => {
    const withKit = briefingFailureNote("online", { pcRefusedNote: "nothing in the PC's Morning Setup to research", hasKit: true });
    expect(withKit).toMatch(/nothing in the PC's Morning Setup to research/);
    expect(withKit).toMatch(/writing one here didn't work either/);
    expect(withKit).not.toMatch(/hasn't got the key/);
  });

  it("describes an unreachable PC as unreachable — never as a phone without a key", () => {
    for (const phase of ["connecting", "searching", "offline"] as CompanionPhase[]) {
      const note = briefingFailureNote(phase);
      expect(note, phase).toMatch(/hasn't reached your PC yet/);
      expect(note, phase).not.toMatch(/has no key of its own yet/);
    }
  });

  it("says plainly when the phone is no longer paired", () => {
    expect(briefingFailureNote("forgotten")).toMatch(/isn't paired/);
  });
});

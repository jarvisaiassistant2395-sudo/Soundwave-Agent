// ── Timers and reminders: the words, the moment, and the ring ───────────────
// Two layers are tested against a fixed clock: the pure parser (whatever the
// person said → an epoch moment, or an honest error), and the store (set, list,
// cancel, ring exactly once, and put the ring in the conversation).

import { beforeEach, describe, expect, it } from "vitest";
import {
  describeGapDuration,
  describeWhen,
  dueReminders,
  parseWhen,
  reminderMessage,
} from "../src/lib/brain/core/reminders.js";
import {
  cancelReminder,
  createReminder,
  listReminders,
  resetRemindersForTests,
  ringDueReminders,
} from "../src/lib/reminders.js";
import { getConversation } from "../src/lib/conversation.js";

const NOW = new Date("2026-05-14T10:00:00"); // a Thursday morning, local time

function at(input: string): number {
  const parsed = parseWhen(input, NOW);
  if ("error" in parsed) throw new Error(input);
  return Math.round((parsed.at - NOW.getTime()) / 60_000);
}

describe("parseWhen — durations", () => {
  it("reads the ways people say a duration", () => {
    expect(at("in 10 minutes")).toBe(10);
    expect(at("in 20")).toBe(20);
    expect(at("10 min")).toBe(10);
    expect(at("1h30")).toBe(90);
    expect(at("1 hour 30 minutes")).toBe(90);
    expect(at("2 hours")).toBe(120);
    expect(at("90s")).toBe(2); // 90 seconds rounds to ~2 minutes
    expect(at("half an hour")).toBe(30);
    expect(at("an hour")).toBe(60);
  });

  it("calls a duration a timer, and says it the way the person did", () => {
    const parsed = parseWhen("in 1 hour 30 minutes", NOW);
    if ("error" in parsed) throw new Error("should parse");
    expect(parsed.kind).toBe("timer");
    expect(parsed.said).toBe("in 1 hour 30 minutes");
  });

  it("refuses rubbish instead of guessing", () => {
    for (const input of ["", "soon", "whenever", "after the video is done"]) {
      const parsed = parseWhen(input, NOW);
      expect("error" in parsed, input).toBe(true);
    }
  });
});

describe("parseWhen — times of day", () => {
  it("reads a clock time, and tomorrow when today's has gone", () => {
    const bst = parseWhen("at 17:30", NOW);
    if ("error" in bst) throw new Error("should parse");
    expect(new Date(bst.at).getHours()).toBe(17);
    expect(new Date(bst.at).getMinutes()).toBe(30);
    expect(new Date(bst.at).getDate()).toBe(NOW.getDate()); // still to come today
    expect(bst.said).toBe("at 17:30");

    const gone = parseWhen("at 8", NOW); // 08:00 already passed at 10:00
    if ("error" in gone) throw new Error("should parse");
    expect(new Date(gone.at).getHours()).toBe(8);
    expect(new Date(gone.at).getDate()).toBe(NOW.getDate() + 1);
    expect(gone.said).toBe("tomorrow at 08:00");
  });

  it("understands am/pm, tomorrow and tonight", () => {
    const eight = parseWhen("tomorrow at 8", NOW);
    if ("error" in eight) throw new Error("should parse");
    expect(new Date(eight.at).getHours()).toBe(8);
    expect(new Date(eight.at).getDate()).toBe(NOW.getDate() + 1);

    const pm = parseWhen("at 8pm", NOW);
    if ("error" in pm) throw new Error("should parse");
    expect(new Date(pm.at).getHours()).toBe(20);

    const tonight = parseWhen("tonight", NOW);
    if ("error" in tonight) throw new Error("should parse");
    expect(new Date(tonight.at).getHours()).toBe(21);
  });

  it("takes a weekday as the coming one, never today", () => {
    const friday = parseWhen("friday at 9", NOW); // NOW is a Thursday
    if ("error" in friday) throw new Error("should parse");
    expect(new Date(friday.at).getDay()).toBe(5);
    expect(new Date(friday.at).getDate()).toBe(NOW.getDate() + 1);
    expect(new Date(friday.at).getHours()).toBe(9);

    // The same weekday as today still means next week's.
    const thursday = parseWhen("thursday", NOW);
    if ("error" in thursday) throw new Error("should parse");
    expect(new Date(thursday.at).getDate()).toBe(NOW.getDate() + 7);
    expect(new Date(thursday.at).getHours()).toBe(9); // no time given: 9am
  });

  it("refuses a clock that isn't one", () => {
    for (const input of ["at 25:00", "at 17:75", "tomorrow at later"]) {
      expect("error" in parseWhen(input, NOW), input).toBe(true);
    }
  });

  it("refuses anything more than a year out", () => {
    const parsed = parseWhen("in 20000 hours", NOW); // 833 days
    expect("error" in parsed).toBe(true);
  });
});

describe("the lines the person reads", () => {
  it("describes gaps and moments", () => {
    expect(describeGapDuration(10 * 60_000)).toBe("10 minutes");
    expect(describeGapDuration(90 * 60_000)).toBe("1 hour 30 minutes");
    expect(describeGapDuration(45_000)).toBe("45 seconds");
    expect(describeWhen(NOW.getTime() + 3 * 60_000, NOW)).toBe("in 3 minutes");
    expect(describeWhen(NOW.getTime() - 1_000, NOW)).toBe("now");
  });

  it("words the ring by what it is", () => {
    const timer = { id: "1", at: 0, label: "check the render", kind: "timer" as const, createdAt: 0 };
    const reminder = { id: "2", at: 0, label: "", kind: "reminder" as const, createdAt: 0 };
    expect(reminderMessage(timer)).toBe("⏰ Timer done — check the render");
    expect(reminderMessage(reminder)).toBe("⏰ Reminder");
  });

  it("never returns a due reminder that already rang", () => {
    const done = { id: "1", at: 0, label: "x", kind: "timer" as const, createdAt: 0, firedAt: 5 };
    expect(dueReminders([done], NOW)).toEqual([]);
  });
});

describe("the store", () => {
  beforeEach(() => {
    resetRemindersForTests();
  });

  it("sets, lists and cancels by label", () => {
    const made = createReminder("in 10 minutes", "check the render", NOW);
    expect(made.ok).toBe(true);
    expect(made.reminder?.when).toContain("timer in 10 minutes");
    expect(made.reminder?.text).toBe("⏰ Timer done — check the render");

    const waiting = listReminders(NOW);
    expect(waiting).toHaveLength(1);
    expect(waiting[0]?.label).toBe("check the render");

    const cancelled = cancelReminder("render", NOW);
    expect(cancelled.ok).toBe(true);
    expect(cancelled.cancelled?.label).toBe("check the render");
    expect(listReminders(NOW)).toHaveLength(0);
  });

  it("says why when there is nothing to cancel, or the time is nonsense", () => {
    const nothing = cancelReminder("render", NOW);
    expect(nothing.ok).toBe(false);
    expect(nothing.error).toMatch(/nothing is waiting/i);

    const bad = createReminder("after lunch", "", NOW);
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/can't read a time/i);
  });

  it("rings once, exactly when due, and says it in the conversation", () => {
    createReminder("in 10 minutes", "check the render", NOW);
    expect(ringDueReminders(NOW)).toHaveLength(0); // not due yet
    expect(ringDueReminders(new Date(NOW.getTime() + 11 * 60_000))).toHaveLength(1);
    expect(ringDueReminders(new Date(NOW.getTime() + 12 * 60_000))).toHaveLength(0); // never twice
    expect(listReminders(NOW)).toHaveLength(0); // it has rung, so it isn't waiting

    const said = getConversation().messages.filter((m) => m.text.includes("⏰ Timer done"));
    expect(said.length).toBeGreaterThan(0);
    expect(said[said.length - 1]?.tag).toBe("SYS");
  });
});

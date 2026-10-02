// Alarms on the phone, set by the agent (lib/brain/core/alarm.ts + the PC's
// set_phone_alarm tool). The tool leaves a control message in the shared
// conversation: the phone app runs it natively (mobile/src/lib/alarm.ts) and
// answers in the chat — so both sides show what happened. Nothing is simulated:
// with no phone paired the tool isn't even offered.
import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

// The desktop app: the agent's PC tools exist here.
process.env.DESKTOP_APP = "1";

const { config } = await import("../src/config.js");
const { JsonStore, setStoreForTests } = await import("../src/lib/store.js");
const service = await import("../src/lib/companion/service.js");
const conversation = await import("../src/lib/conversation.js");
const { toolsFor } = await import("../src/lib/brain/tools.js");
const alarm = await import("../src/lib/brain/core/alarm.js");
const guide = await import("../src/lib/brain/core/guide.js");
const { agentInstruction } = await import("../src/lib/brain/core/prompt.js");

const DATA = config.dataDir;

const ctx = () => ({
  userId: "local-user",
  voice: "en-US-AvaMultilingualNeural",
  resolution: "720p" as const,
  desktop: true,
  platform: "win32" as const,
  effects: { log: [] as string[] },
});

function pairPhone(name = "Pixel 9") {
  return service.completePairing({ name, platform: "android", model: "Pixel 9", appVersion: "1.3.0", address: "192.168.1.20" }).device;
}

beforeEach(() => {
  for (const f of ["companion.json", "agent-conversation.json"]) fs.rmSync(path.join(DATA, f), { force: true });
  service.resetCompanionStateForTests();
  conversation.resetConversationForTests();
});
describe("setting an alarm on the phone from the PC", () => {
  it("isn't offered when no phone is paired", () => {
    expect(toolsFor(ctx() as never).map((t) => t.declaration.name)).not.toContain("set_phone_alarm");
    expect(agentInstruction({ tools: ["set_phone_alarm"], webSearch: false })).toContain("alarms on the user's phone");
  });

  it("arms a real alarm-clock time and leaves a control message the phone runs", async () => {
    pairPhone("Pixel 9");
    const tools = toolsFor(ctx() as never);
    const tool = tools.find((t) => t.declaration.name === "set_phone_alarm");
    expect(tool, "the tool is offered once a phone is paired").toBeTruthy();

    const c = ctx();
    const result = await tool!.run({ time: "06:30", label: "  Gym  ", briefing_after_seconds: 45 }, c as never);
    expect(result.set).toBe(true);
    expect(result.onPhone).toBe("Pixel 9");
    expect(result.ringsAt).toBe("6:30 AM");
    expect(result.briefingAfterSeconds).toBe(45);

    const messages = conversation.getConversation().messages;
    const control = messages.find((m) => m.control?.kind === "alarm.set");
    expect(control, "the phone gets a control message").toBeTruthy();
    const rings = new Date(control!.control!.at);
    expect([rings.getHours(), rings.getMinutes(), rings.getSeconds()]).toEqual([6, 30, 0]);
    expect(Math.abs(control!.control!.at - (alarm.nextAlarmAt("06:30", new Date()) ?? 0))).toBeLessThan(2000);
    expect(control!.control!.label).toBe("Gym");
    expect(control!.control!.briefingAfterSeconds).toBe(45);
    expect(control!.text).toContain("6:30 AM");
    expect(control!.text).toContain("45 seconds later");
    expect(c.effects.log.join(" ")).toContain("6:30 AM");

    // The message survives the untrusted path the phone's copy travels (zod keeps it).
    const { sanitizeMessages } = await import("../src/lib/chatMessages.js");
    const round = sanitizeMessages(messages);
    expect(round.find((m) => m.id === control!.id)?.control?.at).toBe(control!.control!.at);
  });

  it("uses in_seconds for short alarms and the phone's default delay when none is given", async () => {
    pairPhone();
    const tool = toolsFor(ctx() as never).find((t) => t.declaration.name === "set_phone_alarm")!;
    const before = Date.now();
    const result = await tool.run({ in_seconds: 120 }, ctx() as never);
    expect(result.briefingAfterSeconds).toBe(alarm.DEFAULT_BRIEFING_AFTER_ALARM_SECONDS);
    const control = conversation.getConversation().messages.find((m) => m.control)!.control!;
    expect(control.at).toBeGreaterThanOrEqual(before + 119_000);
    expect(control.at).toBeLessThanOrEqual(Date.now() + 121_000);
  });

  it("asks for a real time instead of guessing when there's none", async () => {
    pairPhone();
    const tool = toolsFor(ctx() as never).find((t) => t.declaration.name === "set_phone_alarm")!;
    const result = await tool.run({ label: "whenever" }, ctx() as never);
    expect(result.set).toBe(false);
    expect(String(result.reason)).toContain("HH:MM");
    expect(conversation.getConversation().messages.some((m) => m.control)).toBe(false);
  });
});

describe("the shared alarm rules (both the PC and the phone use these)", () => {
  const at = (iso: string) => new Date(iso);

  it("takes the next occurrence of a clock time — tomorrow if it has passed today", () => {
    expect(alarm.nextAlarmAt("06:30", at("2026-10-03T05:00:00"))).toBe(at("2026-10-03T06:30:00").getTime());
    expect(alarm.nextAlarmAt("6:30", at("2026-10-03T07:00:00"))).toBe(at("2026-10-04T06:30:00").getTime());
    expect(alarm.nextAlarmAt("23:45", at("2026-10-03T23:00:00"))).toBe(at("2026-10-03T23:45:00").getTime());
    expect(alarm.nextAlarmAt("24:00", at("2026-10-03T23:00:00"))).toBeNull();
    expect(alarm.nextAlarmAt("quarter past six", at("2026-10-03T23:00:00"))).toBeNull();
  });

  it("writes the time the way it's spoken", () => {
    expect(alarm.clockLabel(at("2026-10-03T06:30:00").getTime())).toBe("6:30 AM");
    expect(alarm.clockLabel(at("2026-10-03T00:05:00").getTime())).toBe("12:05 AM");
    expect(alarm.clockLabel(at("2026-10-03T12:00:00").getTime())).toBe("12:00 PM");
    expect(alarm.clockLabel(at("2026-10-03T19:45:00").getTime())).toBe("7:45 PM");
  });

  it("keeps the briefing delay sane (0–600 s) and the label short", () => {
    expect(alarm.briefingAfterSeconds(undefined)).toBe(30);
    expect(alarm.briefingAfterSeconds(0)).toBe(0);
    expect(alarm.briefingAfterSeconds(-5)).toBe(0);
    expect(alarm.briefingAfterSeconds(9999)).toBe(600);
    expect(alarm.briefingAfterSeconds(12.6)).toBe(13);
    expect(alarm.briefingAfterSeconds(undefined, 90)).toBe(90);
    expect(alarm.alarmLabel("  Gym   bag ")).toBe("Gym bag");
    expect(alarm.alarmLabel(12)).toBe("");
    expect(alarm.alarmLabel("x".repeat(200)).length).toBe(60);
  });
});

describe("the guide explains the alarms", () => {
  it("has an alarms section with the real names", () => {
    const section = guide.GUIDE_SECTIONS.find((s) => s.id === "alarms");
    expect(section).toBeTruthy();
    expect(section!.text).toContain("Alarm & the briefing");
    expect(section!.text).toContain("Snooze");
    expect(section!.text).toContain("Turn off");
  });
});

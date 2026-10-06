// Alarms on the phone (lib/alarm.ts + the rules both brains share,
// server/src/lib/brain/core/alarm.ts). The plugin itself is Android-only: in
// this test environment there is no phone, so what's checked here is the
// reasoning — the times, the delay, and the honest answers.
import { describe, expect, it } from "vitest";
import { alarmLabel, alarmTarget, briefingAfterSeconds, clockLabel, nextAlarmAt } from "../../../server/src/lib/brain/core/alarm";
import { ALARM_TOO_OLD_MS, alarmAudioOutput, raiseMediaVolumeForBriefing, restoreMediaVolume, setAlarmEarbuds, setAlarmNow } from "./alarm";

const at = (iso: string) => new Date(iso);

describe("when an alarm rings", () => {
  it("uses the next occurrence of the clock time", () => {
    expect(nextAlarmAt("06:30", at("2026-10-03T05:00:00"))).toBe(at("2026-10-03T06:30:00").getTime());
    expect(nextAlarmAt("6:30", at("2026-10-03T06:31:00"))).toBe(at("2026-10-04T06:30:00").getTime());
    expect(nextAlarmAt("later", at("2026-10-03T06:31:00"))).toBeNull();
  });

  it("takes in_seconds for a short alarm, and writes the time out in words", () => {
    const now = at("2026-10-03T21:00:00");
    const target = alarmTarget({ in_seconds: 90 }, now)!;
    expect(target.at).toBe(now.getTime() + 90_000);
    expect(target.label12).toBe("9:01 PM");
    expect(clockLabel(at("2026-10-03T06:30:00").getTime())).toBe("6:30 AM");
    expect(alarmTarget({}, now)).toBeNull();
  });

  it("keeps the briefing delay inside 0–600 seconds", () => {
    expect(briefingAfterSeconds(undefined)).toBe(30);
    expect(briefingAfterSeconds(20)).toBe(20);
    expect(briefingAfterSeconds(-1)).toBe(0);
    expect(briefingAfterSeconds(5000)).toBe(600);
    expect(briefingAfterSeconds(undefined, 15)).toBe(15);
    expect(alarmLabel(" Gym  bag ")).toBe("Gym bag");
  });
});

describe("an alarm the PC asked for", () => {
  it("says so honestly when the time has already passed (the PC was away)", async () => {
    const run = await setAlarmNow({ at: Date.now() - ALARM_TOO_OLD_MS - 1000 }, new Date());
    expect(run.alarm).toBeUndefined();
    expect(run.result.set).toBe(false);
    expect(String(run.problem)).toContain("already passed");
  });

  it("needs a real time", async () => {
    const run = await setAlarmNow({ at: Number.NaN }, new Date());
    expect(run.result.set).toBe(false);
    expect(String(run.problem)).toContain("time");
  });

  it("says nothing about earbuds off the phone, and keeps the preference", async () => {
    expect(await alarmAudioOutput()).toBeNull();
    expect(await setAlarmEarbuds(true)).toBe(true);
    expect(await setAlarmEarbuds(false)).toBe(false);
  });

  it("says the phone app is needed when there is no phone (this environment)", async () => {
    const run = await setAlarmNow({ at: Date.now() + 60_000 }, new Date());
    expect(run.result.set).toBe(false);
    expect(String(run.problem)).toContain("phone app");
  });

  it("leaves the media volume alone off the phone (the briefing raises it on one)", async () => {
    expect(await raiseMediaVolumeForBriefing()).toBe(-1);
    await expect(restoreMediaVolume(0)).resolves.toBeUndefined();
  });
});

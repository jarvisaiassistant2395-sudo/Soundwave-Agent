// ── What the plan buys, and what happens when it runs out ────────────────────
// The numbers on the pricing page are minutes of video and clips, so these are
// the tests that say what a person actually gets: Free is an hour a month with
// a watermark and a week's shelf life, Pro is 300 minutes with no ceiling on
// clips, the guard is a guard and not a trap, and an account that subscribed
// before the repricing keeps its old deal.
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { config } from "../src/config.js";
import { PLANS } from "../src/lib/plans.js";
import { JsonStore, setStoreForTests } from "../src/lib/store.js";
import { meterFor, minutesOf, pruneExpiredClips, recordUsage, requireRoom, retentionCutoff } from "../src/lib/metering.js";
import { grandfatheredPlan } from "../src/routes/billing.js";

const jobsDir = path.join(config.uploadsDir, "jobs");

function clip(store: JsonStore, userId: string, at: string, topic = "an old clip") {
  return store.createJob({
    projectId: null,
    userId,
    status: "COMPLETED",
    progress: 100,
    settings: { topic, format: "mp4" } as never,
    outputUrl: `/api/v1/export/jobs/x/download`,
    errorMessage: null,
    startedAt: at,
    completedAt: at,
  } as never);
}

let store: JsonStore;

beforeEach(async () => {
  store = new JsonStore();
  await store.init();
  setStoreForTests(store);
  fs.mkdirSync(jobsDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(jobsDir, { recursive: true, force: true });
});

async function account(plan: "FREE" | "PRO" | "ENTERPRISE" = "FREE") {
  return store.createUser({ email: `${plan.toLowerCase()}@example.com`, name: "Someone", plan });
}

describe("what each plan buys", () => {
  it("sells minutes and clips, not characters", () => {
    expect(PLANS.FREE.videoMinutesPerMonth).toBe(60);
    expect(PLANS.PRO.videoMinutesPerMonth).toBe(300);
    expect(PLANS.FREE.clipsPerMonth).toBe(30);
    expect(PLANS.PRO.clipsPerMonth).toBeNull();
    // The character limit is the fair-use guard: generous enough that nobody
    // following the plan's own promises can reach it.
    expect(PLANS.PRO.characterLimit).toBeGreaterThanOrEqual(1_000_000);
  });

  it("starts an account at zero used, with the whole month ahead", async () => {
    const user = await account("PRO");
    const meter = await meterFor(user.id);
    expect(meter.plan).toBe("PRO");
    expect(meter.videoMinutes).toEqual({ used: 0, limit: 300, allowed: true });
    expect(meter.clips).toEqual({ used: 0, limit: null, allowed: true });
    expect(meter.watermark).toBe(false);
    expect(meter.retentionDays).toBeNull();
  });

  it("marks Free exports and expires Free clips", async () => {
    const user = await account("FREE");
    const meter = await meterFor(user.id);
    expect(meter.watermark).toBe(true);
    expect(meter.retentionDays).toBe(7);
    expect(retentionCutoff("FREE", Date.parse("2026-01-08T00:00:00Z"))).toBe(Date.parse("2026-01-01T00:00:00Z"));
    expect(retentionCutoff("PRO")).toBeNull();
  });

  it("rounds seconds to minutes the way a person would", () => {
    expect(minutesOf(0)).toBe(0);
    expect(minutesOf(59)).toBe(1);
    expect(minutesOf(90)).toBe(1.5);
    expect(minutesOf(3_600)).toBe(60);
  });
});

describe("running out", () => {
  it("refuses work the month can't cover, before it starts", async () => {
    const user = await account("FREE");
    await recordUsage(user.id, { videoSeconds: 3_000, clips: 5 });
    // 50 of 60 minutes used: a 20-minute video does not fit.
    await expect(requireRoom(user.id, { videoSeconds: 1_200, clips: 1 })).rejects.toMatchObject({ code: "PLAN_LIMIT", status: 402 });
    // …but a 5-minute one does — and the refusal above cost nothing.
    const ok = await requireRoom(user.id, { videoSeconds: 300, clips: 1 });
    expect(ok.videoMinutes.used).toBe(50);
  });

  it("counts a clip against the clip ceiling as well", async () => {
    const user = await account("FREE");
    await recordUsage(user.id, { clips: 30 });
    await expect(requireRoom(user.id, { clips: 1 })).rejects.toMatchObject({ code: "PLAN_LIMIT" });
    // Pro has no clip ceiling at all.
    const pro = await account("PRO");
    await recordUsage(pro.id, { clips: 5_000 });
    await expect(requireRoom(pro.id, { clips: 1 })).resolves.toMatchObject({ plan: "PRO" });
  });

  it("meters only what was really processed", async () => {
    const user = await account("FREE");
    await recordUsage(user.id, { videoSeconds: 60, clips: 1 });
    await recordUsage(user.id, { videoSeconds: 30 });
    const meter = await meterFor(user.id);
    expect(meter.videoMinutes.used).toBe(1.5);
    expect(meter.clips.used).toBe(1);
  });

  it("hands the month back when the boundary passes", async () => {
    const user = await account("FREE");
    await recordUsage(user.id, { videoSeconds: 3_000, clips: 20 });
    // Pretend the reset date has been and gone.
    await store.updateUser(user.id, { characterResetDate: new Date(Date.now() - 86_400_000).toISOString() });
    const meter = await meterFor(user.id);
    expect(meter.videoMinutes.used).toBe(0);
    expect(meter.clips.used).toBe(0);
    const fresh = await store.findUserById(user.id);
    expect(fresh!.charactersUsedThisMonth).toBe(0);
    expect(new Date(fresh!.characterResetDate).getTime()).toBeGreaterThan(Date.now());
  });

  it("doesn't meter the app's own work on this PC", async () => {
    // "local-user"/"agent-local" have no account: nothing to bill, nothing to block.
    await expect(requireRoom("agent-local", { videoSeconds: 10 * 60 * 60, clips: 500 })).resolves.toMatchObject({ watermark: false });
    await recordUsage("agent-local", { videoSeconds: 60, clips: 1 });
    expect(await store.findUserById("agent-local")).toBeNull();
  });
});

describe("clips that expire", () => {
  it("removes a free account's old clips and keeps the record", async () => {
    const user = await account("FREE");
    const old = await clip(store, user.id, new Date(Date.now() - 8 * 86_400_000).toISOString(), "last week's take");
    const fresh = await clip(store, user.id, new Date().toISOString(), "today's take");
    for (const id of [old.id, fresh.id]) fs.writeFileSync(path.join(jobsDir, `${id}.mp4`), "video");

    const pruned = await pruneExpiredClips(user.id);
    expect(pruned.deleted).toBe(1);
    expect(pruned.names).toEqual(["last week's take"]);
    expect(fs.existsSync(path.join(jobsDir, `${old.id}.mp4`))).toBe(false);
    expect(fs.existsSync(path.join(jobsDir, `${fresh.id}.mp4`))).toBe(true);
    // The row stays — the library is also the record of what was made.
    const kept = await store.getJob(old.id, user.id);
    expect(kept?.outputUrl).toBeNull();
    expect((kept?.settings as { expired?: boolean })?.expired).toBe(true);
  });

  it("keeps a Pro account's clips however old they are", async () => {
    const user = await account("PRO");
    const old = await clip(store, user.id, new Date(Date.now() - 400 * 86_400_000).toISOString());
    fs.writeFileSync(path.join(jobsDir, `${old.id}.mp4`), "video");
    const pruned = await pruneExpiredClips(user.id);
    expect(pruned.deleted).toBe(0);
    expect(fs.existsSync(path.join(jobsDir, `${old.id}.mp4`))).toBe(true);
  });

  it("never touches clips that belong to no account", async () => {
    // Clips the app made for itself (before sign-in, or the local agent) are
    // the owner's work: expiry deletes files, so it only runs for real accounts.
    const mine = await clip(store, "agent-local", new Date(Date.now() - 30 * 86_400_000).toISOString());
    fs.writeFileSync(path.join(jobsDir, `${mine.id}.mp4`), "video");
    const pruned = await pruneExpiredClips("agent-local");
    expect(pruned.deleted).toBe(0);
    expect(fs.existsSync(path.join(jobsDir, `${mine.id}.mp4`))).toBe(true);
  });

  it("leaves the whole library alone while the app is starting", async () => {
    const user = await account("FREE");
    await clip(store, user.id, new Date(Date.now() - 10 * 86_400_000).toISOString());
    // Being signed out for a while must not silently delete somebody's work:
    // the sweep only ever runs for an account it can read.
    setStoreForTests(new JsonStore());
    const pruned = await pruneExpiredClips(user.id);
    expect(pruned.deleted).toBe(0);
  });
});

describe("grandfathering", () => {
  const subscriber = (patch: Record<string, unknown>) =>
    ({ id: "u1", email: "a@b.c", name: "A", plan: "PRO", stripeCustomerId: "cus_1", stripeSubscriptionId: "sub_1", charactersUsedThisMonth: 0, characterResetDate: new Date().toISOString(), totalAudioDurationSeconds: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), deletedAt: null, ...patch }) as never;

  it("keeps the old price for a subscription from before the repricing", () => {
    expect(grandfatheredPlan(subscriber({}))).toBe(true); // no start date = certainly old
    expect(grandfatheredPlan(subscriber({ subscriptionStartedAt: "2026-01-05T00:00:00.000Z" }))).toBe(true);
  });

  it("does not grandfather a subscription bought after it", () => {
    expect(grandfatheredPlan(subscriber({ subscriptionStartedAt: new Date(Date.parse(config.pricingChangedAt) + 86_400_000).toISOString() }))).toBe(false);
  });

  it("only applies to people who are actually paying", () => {
    expect(grandfatheredPlan(subscriber({ stripeSubscriptionId: null }))).toBe(false);
    expect(grandfatheredPlan(subscriber({ plan: "FREE" }))).toBe(false);
    // A lifetime was bought outright — there is no price to keep.
    expect(grandfatheredPlan(subscriber({ lifetimeSince: "2026-02-02T00:00:00.000Z" }))).toBe(false);
  });
});

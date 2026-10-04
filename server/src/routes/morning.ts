// ── Morning Setup ───────────────────────────────────────────────────────────
//   GET  /api/v1/morning           settings (+ the weather city in use)        ┐ the desktop
//   PUT  /api/v1/morning           { city?, items?, openFromPhone?, ideas? }   │ app's own
//   POST /api/v1/morning/weather   { city? } → today's weather (the "Check")   │ window only
//   POST /api/v1/morning/run       run it: open items, briefing (the chip)     │
//   GET  /api/v1/morning/briefing  today's briefing: due? ready? heard?        │
//   POST /api/v1/morning/briefing/prepare   write it now (if it isn't there)   │
//   POST /api/v1/morning/briefing/heard     { day } — spoken here, not again   ┘
// The phone runs it through its encrypted channel (lib/companion, op "morning").

import { Router } from "express";
import { z } from "zod";
import { config } from "../config.js";
import { ApiError } from "../middleware/error.js";
import { localAppGuard } from "../middleware/localApp.js";
import { validate } from "../middleware/validate.js";
import { normalizeUrl } from "../lib/brain/pc.js";
import { MAX_BRIEFING_TOPICS, MAX_TOPIC_CHARS } from "../lib/brain/core/memory.js";
import { briefingPlan, setBriefingPlan } from "../lib/memory.js";
import { briefingStatus, markBriefingHeard, prepareTodaysBriefing } from "../lib/briefing.js";
import {
  MAX_MORNING_ITEMS,
  itemLabel,
  loadMorningSettings,
  morningCity,
  morningWeather,
  runMorningSetup,
  saveMorningSettings,
  type MorningItem,
} from "../lib/morning.js";

const router = Router();
router.use(localAppGuard(() => config.desktopApp || config.memoryAvailable, "Morning Setup is only available in the desktop app."));

function view() {
  const settings = loadMorningSettings();
  const { city, auto } = morningCity(settings);
  return {
    ...settings,
    items: settings.items.map((i) => ({ ...i, label: itemLabel(i) })),
    weatherCity: city,
    weatherCityAuto: auto,
    canOpen: config.desktopApp,
    canOpenApps: config.desktopApp && process.platform === "win32",
    maxItems: MAX_MORNING_ITEMS,
    // The daily briefing lives in the agent's memory (the phone gets it too).
    briefing: briefingPlan(),
    maxTopics: MAX_BRIEFING_TOPICS,
    maxTopicChars: MAX_TOPIC_CHARS,
  };
}

router.get("/", (_req, res) => {
  res.json(view());
});

const itemSchema = z.object({ kind: z.enum(["website", "app"]), value: z.string().trim().min(1).max(300) });
const putSchema = z.object({
  city: z.string().trim().max(80).nullable().optional(),
  items: z.array(itemSchema).max(MAX_MORNING_ITEMS).optional(),
  openFromPhone: z.boolean().optional(),
  ideas: z.boolean().optional(),
  briefing: z
    .object({
      topics: z.array(z.string().trim().min(1).max(MAX_TOPIC_CHARS)).max(MAX_BRIEFING_TOPICS).optional(),
      time: z
        .string()
        .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use a 24-hour time like 07:30.")
        .optional(),
      auto: z.boolean().optional(),
    })
    .optional(),
});

router.put("/", validate({ body: putSchema }), (req, res) => {
  const body = req.body as z.infer<typeof putSchema>;
  let items: MorningItem[] | undefined;
  if (body.items) {
    items = [];
    for (const item of body.items) {
      if (item.kind === "website") {
        const url = normalizeUrl(item.value);
        if (!url) throw new ApiError(400, "BAD_ITEM", `“${item.value.slice(0, 80)}” isn't a web address (use something like https://studio.youtube.com).`);
        items.push({ kind: "website", value: url });
      } else {
        items.push({ kind: "app", value: item.value.slice(0, 80) });
      }
    }
  }
  saveMorningSettings({
    ...(body.city !== undefined ? { city: body.city } : {}),
    ...(items ? { items } : {}),
    ...(body.openFromPhone !== undefined ? { openFromPhone: body.openFromPhone } : {}),
    ...(body.ideas !== undefined ? { ideas: body.ideas } : {}),
  });
  if (body.briefing) setBriefingPlan(body.briefing);
  res.json(view());
});

const weatherSchema = z.object({ city: z.string().trim().max(80).optional() });

router.post("/weather", validate({ body: weatherSchema }), async (req, res, next) => {
  try {
    const city = (req.body as z.infer<typeof weatherSchema>).city || morningCity().city;
    const { weather, note } = await morningWeather(city ?? null);
    res.json({ ok: Boolean(weather), city, weather, ...(note ? { error: note } : {}) });
  } catch (err) {
    next(err);
  }
});

router.post("/run", async (req, res, next) => {
  const controller = new AbortController();
  res.on("close", () => {
    if (!res.writableFinished) controller.abort();
  });
  try {
    const reply = await runMorningSetup({ via: "pc", signal: controller.signal });
    // Shown (and spoken) right here: it's today's briefing, heard.
    if (typeof reply.briefingDate === "string") markBriefingHeard(reply.briefingDate, "pc");
    res.json(reply);
  } catch (err) {
    next(err);
  }
});

router.get("/briefing", (_req, res) => {
  res.json(briefingStatus());
});

router.post("/briefing/prepare", async (_req, res, next) => {
  try {
    await prepareTodaysBriefing("app");
    res.json(briefingStatus());
  } catch (err) {
    next(err);
  }
});

router.post("/briefing/heard", validate({ body: z.object({ day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }) }), (req, res) => {
  markBriefingHeard((req.body as { day: string }).day, "pc");
  res.json(briefingStatus());
});

export default router;

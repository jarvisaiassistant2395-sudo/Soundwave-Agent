// ── The brand kit: how this person's clips look ──────────────────────────────
// Read by the clip renderer (lib/videoClips.ts → lib/brand.ts) and edited in
// Settings → Brand. The presets come from the server so the picker, the preview
// and the renderer can never disagree about what "Karaoke" means.

import { Router } from "express";
import { z } from "zod";
import { validate } from "../middleware/validate.js";
import { optionalAuth } from "../middleware/auth.js";
import { CAPTION_STYLES, DEFAULT_BRAND, captionStyleFor, loadBrand, saveBrand } from "../lib/brand.js";

const router = Router();

// GET /api/v1/brand — the current look, the presets, and what the renderer
// would actually be handed for it.
router.get("/", optionalAuth, (_req, res) => {
  const brand = loadBrand();
  res.json({
    brand,
    defaults: DEFAULT_BRAND,
    styles: CAPTION_STYLES,
    // The merged style is what the captions are drawn with — showing it means
    // the Settings preview and the rendered clip cannot drift apart.
    applied: captionStyleFor(brand),
  });
});

const putSchema = z.object({
  name: z.string().max(80).optional(),
  captionStyle: z.enum(["house", "bold", "boxed", "karaoke", "minimal"]).optional(),
  captionColor: z.string().max(9).optional(),
  accentColor: z.string().max(9).optional(),
});

// PUT /api/v1/brand — save the look for every clip from here on.
router.put("/", optionalAuth, validate({ body: putSchema }), (req, res) => {
  const brand = saveBrand(req.body);
  res.json({ ok: true, brand, applied: captionStyleFor(brand) });
});

// DELETE /api/v1/brand — back to the house look.
router.delete("/", optionalAuth, (_req, res) => {
  const brand = saveBrand(DEFAULT_BRAND);
  res.json({ ok: true, brand, applied: captionStyleFor(brand) });
});

export default router;

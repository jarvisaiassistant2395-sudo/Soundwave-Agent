// ── The agent's memory: Command Center → gear → Memory ──────────────────────
//   GET    /api/v1/memory                 notes, summary, last Morning Setup
//   POST   /api/v1/memory/notes           { text } → add a note
//   PATCH  /api/v1/memory/notes/:id       { text } → change a note
//   DELETE /api/v1/memory/notes/:id       forget a note
//   DELETE /api/v1/memory/summary         forget the conversation summary
//   DELETE /api/v1/memory                 forget everything (notes + summary)
// Only the desktop app's own window (the memory is personal).

import { Router } from "express";
import { z } from "zod";
import { config } from "../config.js";
import { ApiError } from "../middleware/error.js";
import { localAppGuard } from "../middleware/localApp.js";
import { validate } from "../middleware/validate.js";
import { MAX_NOTES, MAX_NOTE_CHARS } from "../lib/brain/core/memory.js";
import { MemoryError, addNote, clearMemory, editNote, forgetNote, forgetSummary, memoryState } from "../lib/memory.js";

const router = Router();
router.use(localAppGuard(() => config.memoryAvailable, "The agent's memory is only available in the desktop app."));

function state() {
  return { ...memoryState(), maxNotes: MAX_NOTES, maxNoteChars: MAX_NOTE_CHARS };
}

router.get("/", (_req, res) => {
  res.json(state());
});

const noteBody = z.object({ text: z.string().trim().min(1, "Write the note first.").max(MAX_NOTE_CHARS * 2) });

function memoryCall<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof MemoryError) throw new ApiError(400, "BAD_NOTE", err.message);
    throw err;
  }
}

router.post("/notes", validate({ body: noteBody }), (req, res) => {
  const note = memoryCall(() => addNote((req.body as z.infer<typeof noteBody>).text, "app"));
  res.status(201).json({ note, ...state() });
});

router.patch("/notes/:id", validate({ body: noteBody }), (req, res) => {
  const note = memoryCall(() => editNote(String(req.params.id), (req.body as z.infer<typeof noteBody>).text));
  if (!note) throw new ApiError(404, "NOT_FOUND", "That note isn't in memory anymore.");
  res.json({ note, ...state() });
});

router.delete("/notes/:id", (req, res) => {
  if (!forgetNote(String(req.params.id))) throw new ApiError(404, "NOT_FOUND", "That note isn't in memory anymore.");
  res.json(state());
});

router.delete("/summary", (_req, res) => {
  forgetSummary();
  res.json(state());
});

router.delete("/", (_req, res) => {
  clearMemory();
  res.json(state());
});

export default router;

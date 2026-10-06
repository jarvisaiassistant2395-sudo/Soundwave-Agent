import { Router } from "express";
import { config } from "../config.js";
import { RestoreError, exportData, exportFileName, restoreData } from "../lib/backup.js";
import { localAppGuard } from "../middleware/localApp.js";

// ── Export and restore, over HTTP ───────────────────────────────────────────
// Desktop-only, like every other route that touches this PC's files: the guard
// answers 404 from a hosted deployment, where the data belongs to the database
// and `pg_dump` is the right tool (see docs/BACKUP.md).

const router = Router();

const local = localAppGuard(() => config.brainSettingsAvailable, "Export and restore work in the desktop app — this server's data. On a hosted deployment, use pg_dump.");

router.get("/export", local, (_req, res) => {
  const result = exportData();
  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename="${exportFileName()}"`);
  res.setHeader("Content-Length", String(result.data.length));
  // What was taken out, for the UI to show — a header, because the body is the
  // archive itself and nothing may be appended to it.
  res.setHeader("X-Soundwave-Redacted", String(result.redacted.length));
  res.end(result.data);
});

/**
 * The body is the raw zip, not a multipart upload: it is one file, it can be
 * large, and express.raw() streams it into memory without a parser in between.
 */
router.post("/restore", local, (req, res, next) => {
  const body = req.body as Buffer | undefined;
  if (!body || !Buffer.isBuffer(body) || body.length === 0) {
    res.status(400).json({ error: { code: "NO_ARCHIVE", message: "Send the .zip file as the request body." } });
    return;
  }
  try {
    const result = restoreData(body);
    res.json({
      ok: true,
      restored: result.restored.length,
      files: result.restored,
      movedAside: result.movedAside,
      from: result.manifest,
      // Said plainly, because the app has to be restarted for the in-memory
      // store to be reloaded from what is now on disk.
      note: "Restored. Restart Soundwave to load it.",
    });
  } catch (err) {
    if (err instanceof RestoreError) {
      res.status(400).json({ error: { code: err.code, message: err.message } });
      return;
    }
    next(err);
  }
});

export default router;

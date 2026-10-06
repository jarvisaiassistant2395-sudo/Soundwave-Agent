// Runs before every test file (vitest.config.ts `setupFiles`).
//
// Caches and settings live on disk under DATA_DIR, and every test file shares
// one DATA_DIR — so an answer one file cached would make the next file's
// identical request return without touching its fake server, and a count-based
// test would fail with "no calls" (this really happened: lib/brain/gemini.ts
// caches script answers on purpose). The mode the agent speaks in
// (brain/persona.ts) and the niches it added (brain/niches.ts) are kept there
// too, and both are read back by whichever file runs next — a file that saved
// "Executive Assistant" would otherwise decide how the next file's agent talks.
// Deleting all of them before each test makes every file start from the same
// empty state, and costs nothing but a few unlinks. (Both stores notice the
// file going away, so a test that saved settings doesn't keep them in memory.)
//
// Deliberately plain Node here: importing the app's modules in a setup file
// would build config.js before a test file's `vi.hoisted` env (DESKTOP_APP,
// DATA_DIR…) runs, and the tests would see the wrong configuration.
import fs from "node:fs";
import path from "node:path";
import { beforeEach } from "vitest";

const dataDir = process.env.DATA_DIR ?? "/tmp/soundwave-test-data";

beforeEach(() => {
  for (const name of ["gemini-cache.json", "gemini-usage.json", "persona.json", "niches.json"]) {
    try {
      fs.rmSync(path.join(dataDir, name), { force: true });
    } catch {
      /* nothing cached */
    }
  }
});

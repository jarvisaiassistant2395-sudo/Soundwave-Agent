// Runs before every test file (vitest.config.ts `setupFiles`).
//
// Two caches live on disk under DATA_DIR, and every test file shares one
// DATA_DIR — so an answer one file cached would make the next file's identical
// request return without touching its fake server, and a count-based test would
// fail with "no calls" (this really happened: lib/brain/gemini.ts caches script
// answers on purpose). Deleting both before each test makes every file start
// from the same empty state, and costs nothing but two unlinks.
//
// Deliberately plain Node here: importing the app's modules in a setup file
// would build config.js before a test file's `vi.hoisted` env (DESKTOP_APP,
// DATA_DIR…) runs, and the tests would see the wrong configuration.
import fs from "node:fs";
import path from "node:path";
import { beforeEach } from "vitest";

const dataDir = process.env.DATA_DIR ?? "/tmp/soundwave-test-data";

beforeEach(() => {
  for (const name of ["gemini-cache.json", "gemini-usage.json"]) {
    try {
      fs.rmSync(path.join(dataDir, name), { force: true });
    } catch {
      /* nothing cached */
    }
  }
});

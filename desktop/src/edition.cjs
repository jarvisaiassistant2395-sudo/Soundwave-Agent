// The two builds Soundwave ships from this one tree.
//
//   retail    "Soundwave AI"        the build people buy — plans, Stripe, the
//                                   browser sign-in, everything as sold.
//   personal  "Soundwave AI — Dev"  the owner's own PC: no billing in it at
//                                   all, nothing gated. Its own appId and its
//                                   own data folder, so the two can be
//                                   installed side by side and neither can
//                                   reach the other's data.
//
// Which one a running app IS comes from, first hit wins:
//   1. SOUNDWAVE_EDITION in the environment — the build script, a smoke test,
//      or a developer running the shell directly;
//   2. the `soundwaveEdition` field electron-builder writes into the packaged
//      package.json (see electron-builder.dev.yml `extraMetadata`);
//   3. retail.
//
// server-env.cjs passes the same value to the bundled API as
// SOUNDWAVE_EDITION, where server/src/lib/edition.ts turns it into behaviour:
// no billing routes, and the plan in force is Enterprise.
"use strict";

const EDITIONS = {
  retail: {
    id: "retail",
    /** What people read: window, tray, menus, dialogs, shortcut. */
    displayName: "Soundwave AI",
    /** What Windows and the filesystem see; must match electron-builder. */
    productName: "Soundwave AI",
    appId: "ai.soundwave.desktop",
    userDataFolder: "Soundwave AI",
    billing: true,
  },
  personal: {
    id: "personal",
    displayName: "Soundwave AI — Dev",
    // ASCII, so no dash squabbles in paths, install folders or shortcuts.
    productName: "Soundwave AI - Dev",
    appId: "ai.soundwave.desktop.dev",
    userDataFolder: "Soundwave AI Dev",
    billing: false,
  },
};

function normalise(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase();
}

function bakedEdition() {
  try {
    // The packaged package.json (electron-builder extraMetadata), or the
    // development one, which has no such field — hence the fall-through.
    return require("../package.json").soundwaveEdition;
  } catch {
    return null; // no package.json beside us
  }
}

/**
 * The edition this process is. Never throws: an unknown value is retail.
 * `env` / `packageJson` exist so tests can drive the two sources directly.
 */
function currentEdition({ env = process.env, packageJson = undefined } = {}) {
  const fromEnv = normalise(env.SOUNDWAVE_EDITION);
  if (EDITIONS[fromEnv]) return EDITIONS[fromEnv];
  const baked = normalise(packageJson === undefined ? bakedEdition() : packageJson && packageJson.soundwaveEdition);
  if (EDITIONS[baked]) return EDITIONS[baked];
  return EDITIONS.retail;
}

module.exports = { EDITIONS, currentEdition };

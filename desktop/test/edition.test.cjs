// The two builds: which one a running app is, what it calls itself, where it
// keeps its data — and that the electron-builder configs agree with the table
// in src/edition.cjs. Drift here would mislabel a build, install two builds
// over each other, or (worst) aim both at one data folder.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const desktopDir = path.join(__dirname, "..");
// Checked out on Windows, these files have CRLF line endings (Git's autocrlf),
// so normalise before matching — a regex with a literal "\n" would otherwise
// pass on Linux and fail on the build machine that makes the installers.
const read = (name) => fs.readFileSync(path.join(desktopDir, name), "utf8").replace(/\r\n/g, "\n");

const { EDITIONS, currentEdition } = require(path.join(desktopDir, "src", "edition.cjs"));
const { applyServerEnv } = require(path.join(desktopDir, "src", "server-env.cjs"));

test("the two editions are separate applications", () => {
  const retail = EDITIONS.retail;
  const personal = EDITIONS.personal;
  assert.equal(retail.billing, true);
  assert.equal(personal.billing, false);
  assert.notEqual(retail.appId, personal.appId);
  assert.notEqual(retail.productName, personal.productName);
  // Windows attributes notifications to the appId, and Electron puts the data
  // in a folder of its own: neither may be shared, or the two builds collide.
  assert.notEqual(retail.userDataFolder, personal.userDataFolder);
  assert.match(personal.displayName, /Dev/);
});

test("the sold build's config is exactly what the table says", () => {
  const yml = read("electron-builder.yml");
  assert.match(yml, new RegExp(`^appId: ${EDITIONS.retail.appId}$`, "m"));
  assert.match(yml, new RegExp(`^productName: ${EDITIONS.retail.productName}$`, "m"));
  assert.match(yml, /artifactName: SoundwaveAI-Setup-\$\{version\}\.exe/);
});

test("the owner's build extends it and stamps its own identity", () => {
  const dev = read("electron-builder.dev.yml");
  assert.match(dev, /^extends: \.\/electron-builder\.yml$/m);
  assert.match(dev, new RegExp(`^appId: ${EDITIONS.personal.appId}$`, "m"));
  assert.match(dev, new RegExp(`^productName: ${EDITIONS.personal.productName}$`, "m"));
  // The packaged app reads this field to know which build it is.
  assert.match(dev, /^extraMetadata:\n {2}soundwaveEdition: personal$/m);
  // Its own output folder and installers: never overwrite the sold ones.
  assert.match(dev, /output: release-dev/);
  assert.match(dev, /artifactName: SoundwaveAIDev-Setup-\$\{version\}\.exe/);
});

test("an environment value wins, an unknown one is retail", () => {
  assert.equal(currentEdition({ env: { SOUNDWAVE_EDITION: "personal" }, packageJson: null }).id, "personal");
  assert.equal(currentEdition({ env: { SOUNDWAVE_EDITION: " PERSONAL " }, packageJson: null }).id, "personal");
  assert.equal(currentEdition({ env: { SOUNDWAVE_EDITION: "retail" }, packageJson: { soundwaveEdition: "personal" } }).id, "retail");
  assert.equal(currentEdition({ env: {}, packageJson: null }).id, "retail");
  assert.equal(currentEdition({ env: { SOUNDWAVE_EDITION: "banana" }, packageJson: null }).id, "retail");
});

test("a packaged build knows what it is without any environment", () => {
  assert.equal(currentEdition({ env: {}, packageJson: { soundwaveEdition: "personal" } }).id, "personal");
  assert.equal(currentEdition({ env: {}, packageJson: { soundwaveEdition: "retail" } }).id, "retail");
  assert.equal(currentEdition({ env: {}, packageJson: {} }).id, "retail");
});

test("the shipped package.json stamps retail, so both builds are explicit", () => {
  // desktop/package.json is the sold app's identity; the dev config overrides
  // the field through extraMetadata. If someone removes either, this fails.
  const pkg = JSON.parse(read("package.json"));
  assert.equal(pkg.productName, EDITIONS.retail.productName);
  assert.ok(pkg.scripts["dist:dev"].includes("electron-builder.dev.yml"));
  assert.ok(pkg.scripts["dist:dir:dev"].includes("electron-builder.dev.yml"));
});

/** A minimal app tree that applyServerEnv() accepts (it only checks the two files). */
function fakeAppRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "soundwave-edition-"));
  const appRoot = path.join(root, "app");
  fs.mkdirSync(path.join(appRoot, "server", "dist"), { recursive: true });
  fs.mkdirSync(path.join(appRoot, "frontend", "dist"), { recursive: true });
  fs.writeFileSync(path.join(appRoot, "server", "dist", "index.js"), "// stub\n");
  fs.writeFileSync(path.join(appRoot, "frontend", "dist", "index.html"), "<!doctype html>\n");
  return { root, appRoot, binDir: path.join(root, "bin"), userDataDir: path.join(root, "user-data") };
}

test("the bundled API is told which build it is", async () => {
  const personalTree = fakeAppRoot();
  process.env.SOUNDWAVE_EDITION = "personal";
  delete process.env.DEFAULT_SIGNUP_PLAN;
  const personal = await applyServerEnv(personalTree);
  assert.equal(process.env.SOUNDWAVE_EDITION, "personal");
  assert.equal(process.env.DEFAULT_SIGNUP_PLAN, "ENTERPRISE");
  // Data (settings, secrets, store) is under the edition's own folder.
  assert.equal(personal.dataDir, path.join(personalTree.userDataDir, "data"));
  assert.ok(fs.existsSync(path.join(personalTree.userDataDir, "secrets.json")));

  // …and an explicitly chosen plan in the environment is not overridden.
  process.env.DEFAULT_SIGNUP_PLAN = "PRO";
  await applyServerEnv(fakeAppRoot());
  assert.equal(process.env.DEFAULT_SIGNUP_PLAN, "PRO");

  const retailTree = fakeAppRoot();
  delete process.env.SOUNDWAVE_EDITION;
  delete process.env.DEFAULT_SIGNUP_PLAN;
  const retail = await applyServerEnv(retailTree);
  assert.equal(process.env.SOUNDWAVE_EDITION, "retail");
  assert.equal(process.env.DEFAULT_SIGNUP_PLAN, undefined);
  assert.equal(retail.dataDir, path.join(retailTree.userDataDir, "data"));
});

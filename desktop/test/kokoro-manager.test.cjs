// Desktop-managed Kokoro bootstrap decisions and persisted status helpers.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  PYTHON_INSTALLER_SHA256,
  PYTHON_INSTALLER_URL,
  PYTHON_VERSION,
  SETUP_REVISION,
  atomicWriteJson,
  createManagedKokoro,
  downloadHttps,
  readJson,
  shouldManageLocalVoice,
} = require("../src/kokoro-manager.cjs");
const { getFreePort } = require("../src/server-env.cjs");

const packagedWindows = { enabled: true, platform: "win32", arch: "x64", env: {} };

test("managed Kokoro runs only in a packaged x64 Windows app without an explicit override", () => {
  assert.equal(shouldManageLocalVoice(packagedWindows), true);
  assert.equal(shouldManageLocalVoice({ ...packagedWindows, enabled: false }), false);
  assert.equal(shouldManageLocalVoice({ ...packagedWindows, platform: "linux" }), false);
  assert.equal(shouldManageLocalVoice({ ...packagedWindows, arch: "arm64" }), false);
  assert.equal(shouldManageLocalVoice({ ...packagedWindows, env: { LOCAL_VOICE_URL: "http://localhost:8100" } }), false);
  assert.equal(shouldManageLocalVoice({ ...packagedWindows, env: { VOICECLONE_URL: "https://voice.example" } }), false);
  assert.equal(shouldManageLocalVoice({ ...packagedWindows, env: { SOUNDWAVE_DISABLE_KOKORO_AUTO_SETUP: "1" } }), false);
  assert.equal(shouldManageLocalVoice({ ...packagedWindows, env: { KOKORO_OFF: "true" } }), false);
});

test("the Python runtime is pinned to the official x64 installer and SHA-256", () => {
  assert.equal(PYTHON_VERSION, "3.13.16");
  assert.equal(PYTHON_INSTALLER_URL, "https://www.python.org/ftp/python/3.13.16/python-3.13.16-amd64.exe");
  assert.match(PYTHON_INSTALLER_SHA256, /^[a-f0-9]{64}$/);
});

test("the Python download honors a cancellation signal without leaving a partial installer", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "soundwave-kokoro-download-cancel-"));
  const destination = path.join(dir, "python-installer.exe");
  const controller = new AbortController();
  controller.abort();
  try {
    await assert.rejects(downloadHttps(PYTHON_INSTALLER_URL, destination, { maxBytes: 64 * 1024 * 1024, signal: controller.signal }), /cancelled/i);
    assert.equal(fs.existsSync(destination), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("managed setup writes status atomically under the per-user data directory", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "soundwave-kokoro-"));
  try {
    const statusPath = path.join(dir, "kokoro", "status.json");
    const status = { managed: true, phase: "installing-packages", message: "Installing Kokoro." };
    atomicWriteJson(statusPath, status);
    assert.deepEqual(readJson(statusPath), status);
    assert.deepEqual(fs.readdirSync(path.dirname(statusPath)), ["status.json"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("cancelling model setup terminates the sidecar and preserves a cancelled status", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "soundwave-kokoro-cancel-running-"));
  const resourcesDir = path.join(dir, "resources");
  const runtimeDir = path.join(dir, "user-data", "kokoro");
  const venvPython = path.join(runtimeDir, "venv", "Scripts", "python.exe");
  let manager;
  let serviceKilled = false;

  try {
    fs.mkdirSync(resourcesDir, { recursive: true });
    fs.mkdirSync(path.dirname(venvPython), { recursive: true });
    fs.mkdirSync(path.join(runtimeDir, "python"), { recursive: true });
    for (const file of ["server.py", "kokoro_engine.py", "requirements-kokoro.txt"]) fs.writeFileSync(path.join(resourcesDir, file), "# test");
    fs.writeFileSync(path.join(runtimeDir, "python", "python.exe"), "test runtime");
    fs.writeFileSync(venvPython, "test venv");
    fs.writeFileSync(path.join(runtimeDir, "install.json"), JSON.stringify({ revision: SETUP_REVISION, python: PYTHON_VERSION }));

    manager = await createManagedKokoro({
      ...packagedWindows,
      resourcesDir,
      userDataDir: path.join(dir, "user-data"),
      getFreePort,
      spawnProcess: (_executable, args) => {
        const child = new EventEmitter();
        child.pid = 54321;
        child.exitCode = null;
        child.signalCode = null;
        child.kill = () => {
          if (args.includes("uvicorn")) serviceKilled = true;
          child.signalCode = "SIGTERM";
          setImmediate(() => child.emit("exit", null, "SIGTERM"));
          return true;
        };
        child.unref = () => {};
        if (args.includes("uvicorn")) {
          setImmediate(() => manager.cancelSetup());
        } else {
          setImmediate(() => {
            child.exitCode = 0;
            child.emit("exit", 0, null);
          });
        }
        return child;
      },
    });

    await manager.start();
    assert.equal(serviceKilled, true);
    assert.equal(manager.state().phase, "cancelled");
    assert.equal(readJson(path.join(runtimeDir, "status.json")).phase, "cancelled");
    assert.equal(fs.existsSync(path.join(runtimeDir, "managed-runtime.json")), false);
  } finally {
    manager?.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("managed Kokoro setup can be cancelled before its first subprocess starts", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "soundwave-kokoro-cancel-"));
  try {
    let spawned = false;
    const manager = await createManagedKokoro({
      ...packagedWindows,
      resourcesDir: path.join(dir, "resources"),
      userDataDir: path.join(dir, "user-data"),
      getFreePort: async () => 48124,
      spawnProcess: () => {
        spawned = true;
        throw new Error("a cancelled setup must not spawn work");
      },
    });
    assert.ok(manager);
    assert.equal(manager.cancelSetup(), true);
    assert.equal(manager.state().phase, "cancelled");
    await manager.start();
    assert.equal(spawned, false);
    assert.equal(manager.state().phase, "cancelled");
    manager.stop();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the first managed run gets a loopback URL and a private token without starting downloads", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "soundwave-kokoro-"));
  try {
    const manager = await createManagedKokoro({
      ...packagedWindows,
      resourcesDir: path.join(dir, "resources"),
      userDataDir: path.join(dir, "user-data"),
      getFreePort: async () => 48123,
      spawnProcess: () => {
        throw new Error("setup must not start before manager.start()");
      },
    });
    assert.ok(manager);
    assert.equal(manager.url, "http://127.0.0.1:48123");
    assert.match(manager.token, /^[a-f0-9]{64}$/);
    assert.ok(fs.existsSync(manager.statusFile));
    assert.equal(readJson(path.join(dir, "user-data", "kokoro", "managed-runtime.json")).port, 48123);
    manager.stop();
    assert.equal(fs.existsSync(path.join(dir, "user-data", "kokoro", "managed-runtime.json")), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

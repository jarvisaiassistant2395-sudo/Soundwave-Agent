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
  RUNTIME_REVISION,
  SETUP_REVISION,
  assertFreeSpace,
  atomicWriteJson,
  cleanIncompleteDownloads,
  createManagedKokoro,
  describeSetupFailure,
  downloadHttps,
  readJson,
  shouldManageLocalVoice,
} = require("../src/kokoro-manager.cjs");
const { getFreePort } = require("../src/server-env.cjs");

const packagedWindows = { enabled: true, platform: "win32", arch: "x64", env: {} };

async function waitForSetupState(manager, predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = manager.state();
    if (predicate(state)) return state;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`Timed out waiting for Kokoro setup state; last state: ${JSON.stringify(manager.state())}`);
}

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

test("setup blockers distinguish network and disk-space failures", () => {
  assert.match(describeSetupFailure(new Error("getaddrinfo ENOTFOUND huggingface.co")), /couldn't download from huggingface\.co/);
  assert.match(describeSetupFailure(new Error("write failed: ENOSPC")), /free disk space/);
  assert.match(describeSetupFailure(new Error("pip exited with code 1"), "OSError: [Errno 28] No space left on device"), /free disk space/);

  const originalStatfs = fs.statfsSync;
  try {
    fs.statfsSync = () => ({ bavail: 1, bsize: 1 });
    assert.throws(() => assertFreeSpace(os.tmpdir(), 1024, "test assets"), /local voice setup needs about/);
    const diskError = Object.assign(new Error("not enough free disk space"), { code: "LOCAL_VOICE_INSUFFICIENT_DISK_SPACE" });
    assert.match(describeSetupFailure(diskError), /local voice setup needs about|free disk space/);
  } finally {
    fs.statfsSync = originalStatfs;
  }
});

test("a recovered pip retry in the log is not reported as no internet", () => {
  const log = [
    "WARNING: Retrying (Retry(total=4, connect=None, read=None, redirect=None, status=None)) after connection broken by 'ReadTimeoutError(\"HTTPSConnectionPool(host='pypi.org', port=443): Read timed out. (read timeout=15)\")': /simple/torch/",
    "Successfully installed torch-2.7.0",
    "Traceback (most recent call last):",
    "ModuleNotFoundError: No module named 'kokoro'",
  ].join("\n");
  const message = describeSetupFailure(new Error("python.exe exited with code 1."), log, "C:\\Users\\me\\AppData\\Roaming\\Soundwave AI\\kokoro\\kokoro.log");
  assert.doesNotMatch(message, /internet|couldn't download/i);
  assert.match(message, /No module named 'kokoro'/);
  assert.match(message, /kokoro\.log/);
});

test("antivirus or proxy certificate interception is named, not blamed on the connection", () => {
  const log = "requests.exceptions.SSLError: HTTPSConnectionPool(host='huggingface.co', port=443): Max retries exceeded with url: /hexgrad/Kokoro-82M (Caused by SSLError(SSLCertVerificationError(1, '[SSL: CERTIFICATE_VERIFY_FAILED] certificate verify failed: unable to get local issuer certificate')))";
  const message = describeSetupFailure(new Error("Kokoro service exited (1)."), log);
  assert.match(message, /huggingface\.co/);
  assert.match(message, /antivirus|proxy/i);
  assert.match(describeSetupFailure(new Error("self-signed certificate in certificate chain (https://huggingface.co)")), /secure connection was blocked/);
});

test("a step that ran too long says so", () => {
  assert.match(describeSetupFailure(new Error("python.exe timed out during local voice setup.")), /took too long/);
});

test("repair cleanup removes only incomplete cache downloads", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "soundwave-kokoro-cleanup-"));
  try {
    const cache = path.join(dir, "huggingface", "hub");
    fs.mkdirSync(cache, { recursive: true });
    const verified = path.join(cache, "model.bin");
    const incomplete = path.join(cache, "model.bin.incomplete");
    const temporary = path.join(cache, "download.tmp");
    fs.writeFileSync(verified, "verified");
    fs.writeFileSync(incomplete, "partial");
    fs.writeFileSync(temporary, "partial");
    cleanIncompleteDownloads(path.join(dir, "huggingface"));
    assert.equal(fs.readFileSync(verified, "utf8"), "verified");
    assert.equal(fs.existsSync(incomplete), false);
    assert.equal(fs.existsSync(temporary), false);
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

test("a full disk still publishes an actionable setup status when the atomic temp write fails", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "soundwave-kokoro-status-enospc-"));
  let manager;
  const originalWriteFile = fs.writeFileSync;
  try {
    manager = await createManagedKokoro({
      ...packagedWindows,
      resourcesDir: path.join(dir, "resources"),
      userDataDir: path.join(dir, "user-data"),
      getFreePort: async () => 48125,
      spawnProcess: () => { throw new Error("setup must not start before manager.start()"); },
    });
    let simulatedFullDisk = false;
    fs.writeFileSync = function (filePath, ...args) {
      if (!simulatedFullDisk && String(filePath).endsWith(".tmp")) {
        simulatedFullDisk = true;
        const error = new Error("No space left on device");
        error.code = "ENOSPC";
        throw error;
      }
      return originalWriteFile.call(fs, filePath, ...args);
    };

    manager.writeState("failed", "There isn't enough free disk space.");
    assert.equal(simulatedFullDisk, true);
    assert.equal(readJson(manager.statusFile).message, "There isn't enough free disk space.");
  } finally {
    fs.writeFileSync = originalWriteFile;
    manager?.stop();
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
    for (const file of ["server.py", "kokoro_engine.py", "moss_engine.py", "requirements-kokoro.txt"]) fs.writeFileSync(path.join(resourcesDir, file), "# test");
    fs.writeFileSync(path.join(runtimeDir, "python", "python.exe"), "test runtime");
    fs.writeFileSync(venvPython, "test venv");
    fs.writeFileSync(path.join(runtimeDir, "install.json"), JSON.stringify({ revision: SETUP_REVISION, python: PYTHON_VERSION }));

    manager = await createManagedKokoro({
      ...packagedWindows,
      resourcesDir,
      userDataDir: path.join(dir, "user-data"),
      getFreePort,
      prepareVoiceAssets: async () => {},
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

test("cancelled and failed Kokoro setup can be repaired in-session with cached files and progress", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "soundwave-kokoro-retry-"));
  const resourcesDir = path.join(dir, "resources");
  const runtimeDir = path.join(dir, "user-data", "kokoro");
  const pythonExe = path.join(runtimeDir, "python", "python.exe");
  const venvPython = path.join(runtimeDir, "venv", "Scripts", "python.exe");
  const cacheDir = path.join(runtimeDir, "cache", "huggingface");
  const originalFetch = global.fetch;
  let manager;
  let serviceAttempts = 0;
  let thirdHealthRequests = 0;
  const offlineFlags = [];

  try {
    fs.mkdirSync(resourcesDir, { recursive: true });
    fs.mkdirSync(path.dirname(pythonExe), { recursive: true });
    fs.mkdirSync(path.dirname(venvPython), { recursive: true });
    for (const file of ["server.py", "kokoro_engine.py", "moss_engine.py", "requirements-kokoro.txt"]) fs.writeFileSync(path.join(resourcesDir, file), "# test");
    fs.writeFileSync(pythonExe, "test runtime");
    fs.writeFileSync(venvPython, "test venv");
    fs.writeFileSync(path.join(runtimeDir, "install.json"), JSON.stringify({ revision: SETUP_REVISION, python: PYTHON_VERSION }));
    fs.mkdirSync(cacheDir, { recursive: true });
    const verifiedCache = path.join(cacheDir, "verified-model.bin");
    const partialCache = path.join(cacheDir, "voice.pt.incomplete");
    fs.writeFileSync(verifiedCache, "keep me");
    fs.writeFileSync(partialCache, "partial");

    global.fetch = async (url) => {
      if (!String(url).endsWith("/health")) return { ok: false, status: 404 };
      if (serviceAttempts >= 3) {
        if (serviceAttempts === 3 && thirdHealthRequests++ === 0) return { ok: false, status: 503 };
        return {
          ok: true,
          json: async () => ({ ok: true, engines: { kokoro: { enabled: true, loaded: true }, moss: { enabled: true, loaded: true } } }),
        };
      }
      return { ok: false, status: 503 };
    };

    manager = await createManagedKokoro({
      ...packagedWindows,
      resourcesDir,
      userDataDir: path.join(dir, "user-data"),
      getFreePort: async () => 48129,
      prepareVoiceAssets: async () => {},
      spawnProcess: (_executable, args, options) => {
        const child = new EventEmitter();
        child.pid = 54330 + serviceAttempts;
        child.exitCode = null;
        child.signalCode = null;
        child.kill = () => {
          child.signalCode = "SIGTERM";
          setImmediate(() => child.emit("exit", null, "SIGTERM"));
          return true;
        };
        child.unref = () => {};
        if (args.includes("uvicorn")) {
          serviceAttempts++;
          offlineFlags.push(options.env.HF_HUB_OFFLINE);
          if (serviceAttempts === 1) {
            setImmediate(() => manager.cancelSetup());
          } else if (serviceAttempts === 2) {
            setImmediate(() => {
              child.exitCode = 1;
              child.emit("exit", 1, null);
            });
          } else {
            fs.writeFileSync(
              options.env.KOKORO_SETUP_PROGRESS_FILE,
              JSON.stringify({ phase: "loading-model", message: "Caching voice pack 14 of 28.", progress: 50, progressLabel: "Voice packs (14/28)" }),
            );
          }
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
    assert.equal(manager.state().phase, "cancelled");
    assert.equal(await manager.retrySetup(), true);
    await waitForSetupState(manager, (state) => state.phase === "failed");
    assert.equal(fs.existsSync(partialCache), false);
    assert.equal(fs.readFileSync(verifiedCache, "utf8"), "keep me");
    assert.equal(fs.existsSync(path.join(runtimeDir, "install.json")), true);

    assert.equal(await manager.retrySetup(), true);
    const progress = await waitForSetupState(manager, (state) => state.phase === "loading-model" && state.progress === 50);
    assert.equal(progress.progressLabel, "Voice packs (14/28)");
    await waitForSetupState(manager, (state) => state.phase === "ready");
    assert.equal(serviceAttempts, 3);
    assert.deepEqual(offlineFlags, ["0", "0", "0"]);
    assert.equal(readJson(path.join(runtimeDir, "assets-ready.json")).revision, RUNTIME_REVISION);

    manager.stop();
    manager = await createManagedKokoro({
      ...packagedWindows,
      resourcesDir,
      userDataDir: path.join(dir, "user-data"),
      getFreePort: async () => 48130,
      prepareVoiceAssets: async () => {},
      spawnProcess: (_executable, args, options) => {
        const child = new EventEmitter();
        child.pid = 54340 + serviceAttempts;
        child.exitCode = null;
        child.signalCode = null;
        child.kill = () => {
          child.signalCode = "SIGTERM";
          setImmediate(() => child.emit("exit", null, "SIGTERM"));
          return true;
        };
        child.unref = () => {};
        if (args.includes("uvicorn")) {
          serviceAttempts++;
          offlineFlags.push(options.env.HF_HUB_OFFLINE);
          fs.writeFileSync(
            options.env.KOKORO_SETUP_PROGRESS_FILE,
            JSON.stringify({ phase: "loading-model", message: "Using the verified offline cache.", progress: 100, progressLabel: "Offline cache" }),
          );
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
    assert.equal(manager.state().phase, "ready");
    assert.deepEqual(offlineFlags, ["0", "0", "0", "1"]);
  } finally {
    manager?.stop();
    global.fetch = originalFetch;
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
    assert.deepEqual(readJson(path.join(dir, "user-data", "kokoro", "managed-runtime.json")), {
      revision: RUNTIME_REVISION,
      port: 48123,
      token: manager.token,
      pid: null,
      url: "http://127.0.0.1:48123",
    });
    manager.stop();
    assert.equal(fs.existsSync(path.join(dir, "user-data", "kokoro", "managed-runtime.json")), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Kokoro voices become ready even when the cloning model can't be prepared, and cloning can be retried", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "soundwave-kokoro-clone-optional-"));
  const resourcesDir = path.join(dir, "resources");
  const runtimeDir = path.join(dir, "user-data", "kokoro");
  const venvPython = path.join(runtimeDir, "venv", "Scripts", "python.exe");
  const originalFetch = global.fetch;
  let manager;
  let cloneAssetsFail = true;
  let mossOffForRunningService = "1";
  const mossOffFlags = [];

  try {
    fs.mkdirSync(resourcesDir, { recursive: true });
    fs.mkdirSync(path.dirname(venvPython), { recursive: true });
    fs.mkdirSync(path.join(runtimeDir, "python"), { recursive: true });
    for (const file of ["server.py", "kokoro_engine.py", "moss_engine.py", "requirements-kokoro.txt"]) fs.writeFileSync(path.join(resourcesDir, file), "# test");
    fs.writeFileSync(path.join(runtimeDir, "python", "python.exe"), "test runtime");
    fs.writeFileSync(venvPython, "test venv");
    fs.writeFileSync(path.join(runtimeDir, "install.json"), JSON.stringify({ revision: SETUP_REVISION, python: PYTHON_VERSION }));

    global.fetch = async (url) => {
      if (!String(url).endsWith("/health")) return { ok: false, status: 404 };
      const mossEnabled = mossOffForRunningService === "0";
      return {
        ok: true,
        json: async () => ({ ok: true, engines: { kokoro: { enabled: true, loaded: true }, moss: { enabled: mossEnabled, loaded: mossEnabled } } }),
      };
    };

    manager = await createManagedKokoro({
      ...packagedWindows,
      resourcesDir,
      userDataDir: path.join(dir, "user-data"),
      getFreePort: async () => 48131,
      prepareVoiceAssets: async () => {
        if (cloneAssetsFail) throw new Error("The MOSS model asset download timed out (huggingface.co).");
      },
      spawnProcess: (_executable, args, options) => {
        const child = new EventEmitter();
        child.pid = 54400 + mossOffFlags.length;
        child.exitCode = null;
        child.signalCode = null;
        child.kill = () => {
          child.signalCode = "SIGTERM";
          setImmediate(() => child.emit("exit", null, "SIGTERM"));
          return true;
        };
        child.unref = () => {};
        if (args.includes("uvicorn")) {
          mossOffForRunningService = options.env.MOSS_OFF;
          mossOffFlags.push(options.env.MOSS_OFF);
          assert.equal(options.env.MOSS_OPTIONAL, "1");
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
    assert.equal(manager.state().phase, "ready", manager.state().message);
    assert.match(manager.state().message, /Kokoro narration voices are ready/);
    assert.match(manager.state().cloneError, /huggingface\.co/);
    assert.equal(readJson(path.join(runtimeDir, "status.json")).phase, "ready");
    assert.deepEqual(mossOffFlags, ["1"]);

    cloneAssetsFail = false;
    assert.equal(await manager.retrySetup(), true);
    for (let i = 0; i < 100 && (manager.state().phase !== "ready" || manager.state().cloneError); i++) await new Promise((r) => setTimeout(r, 50));
    assert.equal(manager.state().phase, "ready");
    assert.equal(manager.state().cloneError, undefined);
    assert.equal(manager.state().message, "On-device narration and voice cloning are ready.");
    assert.deepEqual(mossOffFlags, ["1", "0"]);
  } finally {
    global.fetch = originalFetch;
    manager?.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a cloning model that fails to load is reported without blocking Kokoro", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "soundwave-kokoro-moss-load-"));
  const resourcesDir = path.join(dir, "resources");
  const runtimeDir = path.join(dir, "user-data", "kokoro");
  const venvPython = path.join(runtimeDir, "venv", "Scripts", "python.exe");
  const originalFetch = global.fetch;
  let manager;
  try {
    fs.mkdirSync(resourcesDir, { recursive: true });
    fs.mkdirSync(path.dirname(venvPython), { recursive: true });
    fs.mkdirSync(path.join(runtimeDir, "python"), { recursive: true });
    for (const file of ["server.py", "kokoro_engine.py", "moss_engine.py", "requirements-kokoro.txt"]) fs.writeFileSync(path.join(resourcesDir, file), "# test");
    fs.writeFileSync(path.join(runtimeDir, "python", "python.exe"), "test runtime");
    fs.writeFileSync(venvPython, "test venv");
    fs.writeFileSync(path.join(runtimeDir, "install.json"), JSON.stringify({ revision: SETUP_REVISION, python: PYTHON_VERSION }));
    global.fetch = async () => ({
      ok: true,
      json: async () => ({ ok: true, engines: { kokoro: { enabled: true, loaded: true }, moss: { enabled: true, loaded: false, error: "The voice-cloning model couldn't load: onnxruntime DLL load failed" } } }),
    });
    manager = await createManagedKokoro({
      ...packagedWindows,
      resourcesDir,
      userDataDir: path.join(dir, "user-data"),
      getFreePort: async () => 48132,
      prepareVoiceAssets: async () => {},
      spawnProcess: (_executable, args) => {
        const child = new EventEmitter();
        child.pid = 54500;
        child.exitCode = null;
        child.signalCode = null;
        child.kill = () => true;
        child.unref = () => {};
        if (!args.includes("uvicorn")) setImmediate(() => { child.exitCode = 0; child.emit("exit", 0, null); });
        return child;
      },
    });
    await manager.start();
    assert.equal(manager.state().phase, "ready");
    assert.match(manager.state().cloneError, /onnxruntime DLL load failed/);
  } finally {
    global.fetch = originalFetch;
    manager?.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("package installs pass pip's retry settings through the environment, never as stray arguments", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "soundwave-kokoro-pip-args-"));
  const resourcesDir = path.join(dir, "resources");
  const runtimeDir = path.join(dir, "user-data", "kokoro");
  const venvPython = path.join(runtimeDir, "venv", "Scripts", "python.exe");
  const originalFetch = global.fetch;
  const commands = [];
  let manager;
  try {
    fs.mkdirSync(resourcesDir, { recursive: true });
    fs.mkdirSync(path.dirname(venvPython), { recursive: true });
    fs.mkdirSync(path.join(runtimeDir, "python"), { recursive: true });
    for (const file of ["server.py", "kokoro_engine.py", "moss_engine.py", "requirements-kokoro.txt"]) fs.writeFileSync(path.join(resourcesDir, file), "# test");
    fs.writeFileSync(path.join(runtimeDir, "python", "python.exe"), "test runtime");
    fs.writeFileSync(venvPython, "test venv");
    global.fetch = async () => ({ ok: true, json: async () => ({ ok: true, engines: { kokoro: { enabled: true, loaded: true }, moss: { enabled: true, loaded: true } } }) });
    manager = await createManagedKokoro({
      ...packagedWindows,
      resourcesDir,
      userDataDir: path.join(dir, "user-data"),
      getFreePort: async () => 48133,
      prepareVoiceAssets: async () => {},
      spawnProcess: (_executable, args, options) => {
        commands.push({ args, env: options.env });
        const child = new EventEmitter();
        child.pid = 54600 + commands.length;
        child.exitCode = null;
        child.signalCode = null;
        child.kill = () => true;
        child.unref = () => {};
        if (!args.includes("uvicorn")) setImmediate(() => { child.exitCode = 0; child.emit("exit", 0, null); });
        return child;
      },
    });
    await manager.start();
    assert.equal(manager.state().phase, "ready", manager.state().message);
    const installs = commands.filter((c) => c.args.includes("install") || c.args.some((a) => String(a).includes("spacy.cli")));
    assert.ok(installs.length >= 4, "the package steps ran");
    for (const { args, env } of installs) {
      assert.ok(!args.includes("10") && !args.includes("--retries"), `no stray retry arguments: ${args.join(" ")}`);
      assert.equal(env.PIP_RETRIES, "10");
      assert.equal(env.PIP_TIMEOUT, "60");
    }
    const spacy = installs.find((c) => c.args.some((a) => String(a).includes("spacy.cli")));
    assert.match(spacy.args.join(" "), /download\('en_core_web_sm'\)/);
  } finally {
    global.fetch = originalFetch;
    manager?.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a failed setup retries by itself", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "soundwave-kokoro-auto-retry-"));
  const resourcesDir = path.join(dir, "resources");
  const runtimeDir = path.join(dir, "user-data", "kokoro");
  const venvPython = path.join(runtimeDir, "venv", "Scripts", "python.exe");
  const originalFetch = global.fetch;
  const originalSetTimeout = global.setTimeout;
  let manager;
  let services = 0;
  try {
    // Fire long timers (the automatic retry) almost immediately.
    global.setTimeout = (fn, ms, ...rest) => originalSetTimeout(fn, ms >= 20_000 ? 10 : ms, ...rest);
    fs.mkdirSync(resourcesDir, { recursive: true });
    fs.mkdirSync(path.dirname(venvPython), { recursive: true });
    fs.mkdirSync(path.join(runtimeDir, "python"), { recursive: true });
    for (const file of ["server.py", "kokoro_engine.py", "moss_engine.py", "requirements-kokoro.txt"]) fs.writeFileSync(path.join(resourcesDir, file), "# test");
    fs.writeFileSync(path.join(runtimeDir, "python", "python.exe"), "test runtime");
    fs.writeFileSync(venvPython, "test venv");
    fs.writeFileSync(path.join(runtimeDir, "install.json"), JSON.stringify({ revision: SETUP_REVISION, python: PYTHON_VERSION }));
    global.fetch = async () => (services >= 2
      ? { ok: true, json: async () => ({ ok: true, engines: { kokoro: { enabled: true, loaded: true }, moss: { enabled: true, loaded: true } } }) }
      : { ok: false, status: 503 });
    manager = await createManagedKokoro({
      ...packagedWindows,
      resourcesDir,
      userDataDir: path.join(dir, "user-data"),
      getFreePort: async () => 48134,
      prepareVoiceAssets: async () => {},
      spawnProcess: (_executable, args) => {
        const child = new EventEmitter();
        child.pid = 54700;
        child.exitCode = null;
        child.signalCode = null;
        child.kill = () => true;
        child.unref = () => {};
        if (args.includes("uvicorn")) {
          services++;
          if (services === 1) setImmediate(() => { child.exitCode = 1; child.emit("exit", 1, null); });
        } else setImmediate(() => { child.exitCode = 0; child.emit("exit", 0, null); });
        return child;
      },
    });
    await manager.start();
    assert.equal(manager.state().phase, "failed");
    assert.match(manager.state().message, /try again by itself/);
    for (let i = 0; i < 100 && manager.state().phase !== "ready"; i++) await new Promise((r) => originalSetTimeout(r, 20));
    assert.equal(manager.state().phase, "ready");
    assert.equal(services, 2);
  } finally {
    global.setTimeout = originalSetTimeout;
    global.fetch = originalFetch;
    manager?.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

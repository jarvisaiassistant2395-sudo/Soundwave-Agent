// Manages the optional Kokoro narrator for the packaged Windows desktop app.
// The first run provisions a per-user Python environment without a console;
// later runs start the local service in the background. Models and packages
// live under Electron's user-data folder, never inside the installer tree.
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const https = require("node:https");
const path = require("node:path");
const { spawn } = require("node:child_process");

const SETUP_REVISION = 1;
// Invalidates an older resident service which preloaded only one voice pack,
// without forcing a reinstall of the already-verified Python package environment.
const RUNTIME_REVISION = 2;
const PYTHON_VERSION = "3.13.16";
const PYTHON_INSTALLER_URL = `https://www.python.org/ftp/python/${PYTHON_VERSION}/python-${PYTHON_VERSION}-amd64.exe`;
// Published by python.org for the x64 Windows installer.
const PYTHON_INSTALLER_SHA256 = "fb4f9f5d438b2396da0086dc70b935c530cb578e37adc6d354f7ad2037fee83b";
const MAX_PYTHON_INSTALLER_BYTES = 64 * 1024 * 1024;
const TORCH_CPU_INDEX = "https://download.pytorch.org/whl/cpu";
const REQUEST_TIMEOUT_MS = 3_000;
const SERVICE_START_TIMEOUT_MS = 15 * 60_000;
const COMMAND_TIMEOUT_MS = 30 * 60_000;
const MIN_PYTHON_SETUP_FREE_BYTES = 300 * 1024 * 1024;
const MIN_PACKAGE_SETUP_FREE_BYTES = 1536 * 1024 * 1024;

function shouldManageLocalVoice({ enabled, platform, arch, env = {} }) {
  if (!enabled || platform !== "win32" || arch !== "x64") return false;
  if (env.SOUNDWAVE_DISABLE_KOKORO_AUTO_SETUP === "1") return false;
  if (["1", "true", "yes"].includes(String(env.KOKORO_OFF ?? "").toLowerCase())) return false;
  // An explicitly configured sidecar always wins. Never replace someone's
  // remote/local service with the desktop-managed instance.
  return !String(env.LOCAL_VOICE_URL ?? "").trim() && !String(env.VOICECLONE_URL ?? "").trim();
}

function atomicWriteJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  try {
    fs.renameSync(temporary, filePath);
  } catch {
    // Windows doesn't replace an existing destination with renameSync.
    fs.rmSync(filePath, { force: true });
    fs.renameSync(temporary, filePath);
  }
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function assertFreeSpace(location, requiredBytes, purpose) {
  if (typeof fs.statfsSync !== "function") return;
  try {
    const stats = fs.statfsSync(location);
    const freeBytes = Number(stats.bavail) * Number(stats.bsize);
    if (!Number.isFinite(freeBytes) || freeBytes >= requiredBytes) return;
    const requiredGb = (requiredBytes / (1024 ** 3)).toFixed(1);
    const freeGb = (freeBytes / (1024 ** 3)).toFixed(1);
    const error = new Error(`Kokoro needs about ${requiredGb} GB of free disk space for ${purpose}; ${freeGb} GB is available. Free some space and choose Retry.`);
    error.code = "KOKORO_INSUFFICIENT_DISK_SPACE";
    throw error;
  } catch (error) {
    if (error?.code === "KOKORO_INSUFFICIENT_DISK_SPACE") throw error;
    // Some Windows volumes/filesystems do not implement statfs. Let the actual
    // write report ENOSPC rather than blocking setup on an unavailable probe.
  }
}

function cleanIncompleteDownloads(root) {
  if (!fs.existsSync(root)) return;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const filePath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      cleanIncompleteDownloads(filePath);
      continue;
    }
    if (entry.isFile() && /(?:\.incomplete|\.part|\.tmp)$/i.test(entry.name)) {
      fs.rmSync(filePath, { force: true });
    }
  }
}

function describeSetupFailure(error, logTail = "") {
  const summary = `${error?.code ?? ""} ${error?.message ?? error ?? ""}`;
  const evidence = `${summary}\n${logTail}`;
  if (/KOKORO_INSUFFICIENT_DISK_SPACE|ENOSPC|no space left on device|disk quota exceeded|not enough (?:free )?disk space|WinError 112|insufficient disk space/i.test(evidence)) {
    return /Kokoro needs about/i.test(summary)
      ? String(error.message)
      : "There isn't enough free disk space to finish Kokoro setup. Free up space and choose Retry; completed runtime, packages, and model files are kept.";
  }
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|network is unreachable|no internet|offline mode|outgoing traffic.{0,40}disabled|(?:temporary )?failure in name resolution|nameresolutionerror|failed to establish a new connection|max retries exceeded|connectionerror|connectionreseterror|newconnectionerror|connecttimeout|readtimeout|sslcertverificationerror|proxyerror|httpsconnectionpool|could not fetch url|couldn't connect|unable to connect|no route to host|timed out|socket timeout|winerror 100(?:51|54|60|61)/i.test(evidence)) {
    return "Kokoro needs an internet connection to download missing setup files. Connect to the internet, then choose Retry; completed runtime, packages, and model files are kept.";
  }
  const detail = String(error?.message ?? "").replace(/[\r\n]+/g, " ").slice(0, 180);
  return `Kokoro setup couldn't finish${detail ? ` (${detail})` : ""}. Completed runtime, packages, and downloads are kept. Choose Retry to continue; if it fails again, check the Kokoro setup log in Soundwave's local app data.`;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fetchJson(url, token, timeoutMs = REQUEST_TIMEOUT_MS, signal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const forwardAbort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener("abort", forwardAbort, { once: true });
  return fetch(url, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    signal: controller.signal,
  })
    .then(async (response) => {
      if (!response.ok) return null;
      return response.json().catch(() => null);
    })
    .catch(() => null)
    .finally(() => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", forwardAbort);
    });
}

function downloadHttps(url, destination, { sha256, maxBytes, onProgress, signal } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let activeRequest = null;
    let activeOutput = null;
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    const finish = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) {
        const removePartialFile = () => {
          try {
            fs.rmSync(destination, { force: true });
          } catch {
            /* cleanup is best-effort; the next run will overwrite this partial download */
          }
          reject(error);
        };
        if (activeOutput && !activeOutput.closed) {
          activeOutput.once("close", removePartialFile);
          activeOutput.destroy();
          activeRequest?.destroy();
        } else {
          activeOutput?.destroy();
          activeRequest?.destroy();
          removePartialFile();
        }
      } else resolve(destination);
    };
    const onAbort = () => finish(new Error("The Kokoro download was cancelled."));

    const request = (currentUrl, redirects = 0) => {
      if (settled) return;
      let parsed;
      try {
        parsed = new URL(currentUrl);
      } catch (error) {
        return finish(error);
      }
      if (parsed.protocol !== "https:") return finish(new Error("Downloads must use HTTPS."));
      if (redirects > 5) return finish(new Error("Too many redirects while downloading the Python runtime."));

      const req = https.get(parsed, { headers: { "User-Agent": "SoundwaveAI-Desktop" }, timeout: 30_000 }, (res) => {
        if (settled) {
          res.destroy();
          return;
        }
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          const next = new URL(res.headers.location, parsed).toString();
          if (!next.startsWith("https://")) return finish(new Error("Refused an insecure download redirect."));
          return request(next, redirects + 1);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return finish(new Error(`The Python download returned HTTP ${res.statusCode ?? "?"}.`));
        }
        const length = Number(res.headers["content-length"] ?? 0);
        if (length > maxBytes) {
          res.resume();
          return finish(new Error("The Python runtime download was larger than expected."));
        }

        const hash = crypto.createHash("sha256");
        let received = 0;
        const output = fs.createWriteStream(destination);
        activeOutput = output;
        res.on("data", (chunk) => {
          received += chunk.length;
          if (received > maxBytes) {
            req.destroy(new Error("The Python runtime download was larger than expected."));
            return;
          }
          hash.update(chunk);
          if (typeof onProgress === "function") onProgress(received, length);
        });
        res.on("error", (error) => output.destroy(error));
        output.on("error", finish);
        output.on("finish", () => {
          const actual = hash.digest("hex");
          if (sha256 && actual.toLowerCase() !== sha256.toLowerCase()) {
            return finish(new Error("The Python runtime checksum didn't match python.org."));
          }
          finish();
        });
        res.pipe(output);
      });
      activeRequest = req;
      req.on("timeout", () => req.destroy(new Error("The Python download timed out.")));
      req.on("error", finish);
    };

    if (signal?.aborted) return onAbort();
    signal?.addEventListener("abort", onAbort, { once: true });
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    request(url);
  });
}

function createKokoroManager({
  enabled,
  platform = process.platform,
  arch = process.arch,
  env = process.env,
  resourcesDir,
  userDataDir,
  getFreePort,
  spawnProcess = spawn,
}) {
  if (!shouldManageLocalVoice({ enabled, platform, arch, env })) return null;
  if (typeof getFreePort !== "function") throw new Error("The local voice manager needs a loopback port allocator.");

  const runtimeDir = path.join(userDataDir, "kokoro");
  const pythonHome = path.join(runtimeDir, "python");
  const venvDir = path.join(runtimeDir, "venv");
  const pythonInstaller = path.join(runtimeDir, `python-${PYTHON_VERSION}-amd64.exe`);
  const pythonExe = path.join(pythonHome, "python.exe");
  const venvPython = path.join(venvDir, "Scripts", "python.exe");
  const installMarker = path.join(runtimeDir, "install.json");
  const assetsMarker = path.join(runtimeDir, "assets-ready.json");
  const runtimeFile = path.join(runtimeDir, "managed-runtime.json");
  const statusFile = path.join(runtimeDir, "status.json");
  const setupProgressFile = path.join(runtimeDir, "setup-progress.json");
  const logFile = path.join(runtimeDir, "kokoro.log");
  const cacheDir = path.join(runtimeDir, "cache");
  const profilesDir = path.join(runtimeDir, "profiles");

  let activeProcess = null;
  let serviceProcess = null;
  let serviceExitError = null;
  let stopped = false;
  let cancelled = false;
  let setupStarted = false;
  let setupAbortController = new AbortController();
  let setupPromise = null;
  let setupLogOffset = 0;
  let runtime = null;
  let reusedProcessId = null;
  let state = { phase: "checking", message: "Soundwave is preparing the on-device Kokoro voice in the background." };

  function writeState(phase, message, progress, progressLabel) {
    if (cancelled && phase !== "cancelling" && phase !== "cancelled") return;
    state = {
      managed: true,
      phase,
      message,
      ...(Number.isFinite(progress) ? { progress: Math.max(0, Math.min(100, Math.round(progress))) } : {}),
      ...(typeof progressLabel === "string" && progressLabel ? { progressLabel: progressLabel.slice(0, 80) } : {}),
      updatedAt: new Date().toISOString(),
    };
    try {
      atomicWriteJson(statusFile, state);
    } catch (error) {
      // On ENOSPC the temp-file write above can fail before the server sees
      // the blocker. Truncating the previous tiny status file may still leave
      // enough room to publish the actionable failure state.
      if (error?.code === "ENOSPC") {
        try {
          fs.writeFileSync(statusFile, `${JSON.stringify(state)}\n`, { mode: 0o600 });
          return;
        } catch {
          /* preserve the in-memory state and report below */
        }
      }
      console.warn("[soundwave-desktop] could not save Kokoro setup status:", error.message);
    }
  }

  function managedPythonEnv(overrides = {}) {
    const result = { ...process.env, PYTHONUTF8: "1", PYTHONNOUSERSITE: "1", ...overrides };
    // An unrelated Python install in the user's shell must not leak modules or
    // package paths into Soundwave's isolated runtime.
    delete result.PYTHONHOME;
    delete result.PYTHONPATH;
    delete result.VIRTUAL_ENV;
    return result;
  }

  function openLogFd() {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    try {
      if (fs.statSync(logFile).size > 12 * 1024 * 1024) fs.renameSync(logFile, `${logFile}.1`);
    } catch {
      /* first run */
    }
    return fs.openSync(logFile, "a");
  }

  function runCommand(executable, args, { cwd, env: commandEnv, timeoutMs = COMMAND_TIMEOUT_MS, successCodes = [0] } = {}) {
    return new Promise((resolve, reject) => {
      if (stopped || cancelled) return reject(new Error(stopped ? "Kokoro setup was cancelled because Soundwave is closing." : "Kokoro setup was cancelled."));
      const fd = openLogFd();
      let child;
      try {
        child = spawnProcess(executable, args, {
          cwd,
          env: commandEnv,
          windowsHide: true,
          detached: false,
          stdio: ["ignore", fd, fd],
        });
      } catch (error) {
        fs.closeSync(fd);
        return reject(error);
      }
      fs.closeSync(fd);
      activeProcess = child;
      let finished = false;
      const finish = (error, code = null) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        if (activeProcess === child) activeProcess = null;
        if (error) reject(error);
        else if (!successCodes.includes(code)) reject(new Error(`${path.basename(executable)} exited with code ${code ?? "unknown"}. See the Kokoro log in Soundwave's user-data folder.`));
        else resolve(code);
      };
      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          /* already exited */
        }
        finish(new Error(`${path.basename(executable)} timed out during Kokoro setup.`));
      }, timeoutMs);
      timer.unref?.();
      child.once("error", (error) => finish(error));
      child.once("exit", (code) => finish(null, code));
    });
  }

  function pythonInstallerVerified() {
    try {
      if (fs.statSync(pythonInstaller).size > MAX_PYTHON_INSTALLER_BYTES) return false;
      const bytes = fs.readFileSync(pythonInstaller);
      return crypto.createHash("sha256").update(bytes).digest("hex") === PYTHON_INSTALLER_SHA256;
    } catch {
      return false;
    }
  }

  async function pythonInstallerValid() {
    if (!fs.existsSync(pythonExe)) return false;
    try {
      await runCommand(pythonExe, ["-m", "pip", "--version"], { env: managedPythonEnv(), timeoutMs: 20_000 });
      return true;
    } catch {
      return false;
    }
  }

  async function ensurePython() {
    if (await pythonInstallerValid()) return;
    if (stopped || cancelled) throw new Error("Kokoro setup was cancelled.");
    writeState("installing-python", "Installing the private Python runtime for Kokoro in the background.", undefined, "Python runtime");
    fs.rmSync(pythonHome, { recursive: true, force: true });
    fs.mkdirSync(runtimeDir, { recursive: true });
    if (!pythonInstallerVerified()) {
      assertFreeSpace(runtimeDir, MIN_PYTHON_SETUP_FREE_BYTES, "the Python runtime");
      fs.rmSync(pythonInstaller, { force: true });
      writeState("installing-python", "Downloading the signed Python runtime for Kokoro.", 0, "Python runtime download");
      let lastProgress = -1;
      await downloadHttps(PYTHON_INSTALLER_URL, pythonInstaller, {
        sha256: PYTHON_INSTALLER_SHA256,
        maxBytes: MAX_PYTHON_INSTALLER_BYTES,
        signal: setupAbortController.signal,
        onProgress: (received, total) => {
          const progress = total > 0 ? Math.round((received / total) * 100) : undefined;
          if (progress !== undefined && progress !== lastProgress) {
            lastProgress = progress;
            writeState("installing-python", "Downloading the signed Python runtime for Kokoro.", progress, "Python runtime download");
          }
        },
      });
    }
    writeState("installing-python", "Installing the private Python runtime for Kokoro.", undefined, "Installing Python runtime");
    await runCommand(
      pythonInstaller,
      [
        "/quiet",
        "InstallAllUsers=0",
        `TargetDir=${pythonHome}`,
        "PrependPath=0",
        "Include_launcher=0",
        "Include_pip=1",
        "Include_test=0",
        "Include_doc=0",
        "Include_tcltk=0",
        "Shortcuts=0",
        "AssociateFiles=0",
      ],
      { timeoutMs: 5 * 60_000, successCodes: [0, 3010] },
    );
    if (!(await pythonInstallerValid())) throw new Error("The private Python runtime did not install correctly.");
    fs.rmSync(pythonInstaller, { force: true });
    writeState("installing-python", "The private Python runtime is ready.", 100, "Python runtime");
  }

  async function ensureEnvironment() {
    await ensurePython();
    const marker = readJson(installMarker);
    const markerMatches = marker?.revision === SETUP_REVISION && marker?.python === PYTHON_VERSION;
    if (markerMatches && fs.existsSync(venvPython)) {
      try {
        await runCommand(venvPython, ["-m", "pip", "check"], { cwd: resourcesDir, env: managedPythonEnv(), timeoutMs: 60_000 });
        await runCommand(
          venvPython,
          ["-c", "import fastapi, huggingface_hub, misaki, numpy, spacy, torch, transformers, uvicorn; from kokoro.model import KModel; print('Kokoro runtime verified')"],
          { cwd: resourcesDir, env: managedPythonEnv(), timeoutMs: 60_000 },
        );
        return;
      } catch {
        // A broken or incomplete update is repaired below; no app crash.
      }
    }

    assertFreeSpace(runtimeDir, MIN_PACKAGE_SETUP_FREE_BYTES, "Kokoro's speech engine and Python packages");
    writeState("installing-packages", "Preparing Kokoro's private Python package environment.", undefined, "Isolated Python environment");
    fs.mkdirSync(runtimeDir, { recursive: true });
    const pipEnv = managedPythonEnv({ PIP_CACHE_DIR: path.join(cacheDir, "pip"), PIP_DISABLE_PIP_VERSION_CHECK: "1" });
    if (!fs.existsSync(venvPython)) {
      await runCommand(pythonExe, ["-m", "venv", venvDir], { cwd: runtimeDir, env: pipEnv, timeoutMs: 2 * 60_000 });
    }
    const common = ["-m", "pip", "install", "--disable-pip-version-check", "--progress-bar", "off"];
    const packageSteps = 6;
    let completedPackageSteps = 0;
    const runPackageStep = async (label, executable, args, options = {}) => {
      const progress = Math.round((completedPackageSteps / packageSteps) * 100);
      writeState("installing-packages", `Installing ${label} for Kokoro.`, progress, `${label} (${completedPackageSteps + 1}/${packageSteps})`);
      await runCommand(executable, args, options);
      completedPackageSteps++;
    };
    await runPackageStep("the package installer", venvPython, [...common, "--upgrade", "pip"], { cwd: resourcesDir, env: pipEnv });
    // CPU-only PyTorch: works on ordinary Windows PCs without CUDA or an
    // NVIDIA card and avoids pulling the multi-gigabyte CUDA runtime.
    await runPackageStep("CPU PyTorch", venvPython, [...common, "torch", "--index-url", TORCH_CPU_INDEX], { cwd: resourcesDir, env: pipEnv });
    await runPackageStep("Kokoro dependencies", venvPython, [...common, "-r", path.join(resourcesDir, "requirements-kokoro.txt")], { cwd: resourcesDir, env: pipEnv });
    // Installing the package without its optional [en] extra is deliberate:
    // that extra brings GPL phonemizer/espeak-ng, which Soundwave never uses.
    await runPackageStep("Kokoro's speech engine", venvPython, [...common, "--no-deps", "kokoro"], { cwd: resourcesDir, env: pipEnv });
    await runPackageStep("English pronunciation data", venvPython, ["-m", "spacy", "download", "en_core_web_sm"], { cwd: resourcesDir, env: pipEnv });
    await runPackageStep(
      "runtime verification",
      venvPython,
      [
        "-c",
        "import sys, fastapi, huggingface_hub, misaki, numpy, spacy, torch, transformers, uvicorn; from kokoro.model import KModel; forbidden={'phonemizer','espeakng_loader','misaki.espeak'} & set(sys.modules); assert not forbidden, forbidden; print('Kokoro runtime verified')",
      ],
      { cwd: resourcesDir, env: pipEnv, timeoutMs: 2 * 60_000 },
    );
    atomicWriteJson(installMarker, { revision: SETUP_REVISION, python: PYTHON_VERSION, installedAt: new Date().toISOString() });
    writeState("installing-packages", "Kokoro's offline speech engine and pronunciation data are ready.", 100, "Python packages");
  }

  function readLogSince(offset = 0) {
    try {
      const log = fs.readFileSync(logFile);
      return log.subarray(Math.min(offset, log.length)).toString("utf8").slice(-20_000);
    } catch {
      return "";
    }
  }

  function launchService() {
    if (stopped) throw new Error("Soundwave is closing.");
    fs.rmSync(setupProgressFile, { force: true });
    let serviceLogOffset = 0;
    try {
      serviceLogOffset = fs.statSync(logFile).size;
    } catch {
      /* first launch */
    }
    const fd = openLogFd();
    const assetsReady = readJson(assetsMarker)?.revision === RUNTIME_REVISION;
    const serviceEnv = managedPythonEnv({
      CHATTERBOX_OFF: "1",
      CHATTERBOX_MOCK: "0",
      KOKORO_OFF: "0",
      KOKORO_PRELOAD: "1",
      VOICECLONE_HOST: "127.0.0.1",
      VOICECLONE_PORT: String(runtime.port),
      VOICECLONE_TOKEN: runtime.token,
      VOICECLONE_PROFILES_DIR: profilesDir,
      HF_HOME: path.join(cacheDir, "huggingface"),
      HF_HUB_OFFLINE: assetsReady ? "1" : "0",
      TRANSFORMERS_OFFLINE: assetsReady ? "1" : "0",
      HF_HUB_DISABLE_TELEMETRY: "1",
      HF_HUB_DOWNLOAD_TIMEOUT: "180",
      KOKORO_SETUP_PROGRESS_FILE: setupProgressFile,
      PIP_CACHE_DIR: path.join(cacheDir, "pip"),
      PYTHONUTF8: "1",
      PYTHONNOUSERSITE: "1",
      PYTHONDONTWRITEBYTECODE: "1",
      TOKENIZERS_PARALLELISM: "false",
    });
    let child;
    try {
      child = spawnProcess(
        venvPython,
        ["-m", "uvicorn", "server:app", "--host", "127.0.0.1", "--port", String(runtime.port), "--no-access-log"],
        { cwd: resourcesDir, env: serviceEnv, windowsHide: true, detached: false, stdio: ["ignore", fd, fd] },
      );
    } finally {
      fs.closeSync(fd);
    }
    serviceProcess = child;
    serviceExitError = null;
    runtime.pid = child.pid ?? null;
    atomicWriteJson(runtimeFile, runtime);
    const recordServiceFailure = (error) => {
      serviceExitError = error;
      if (serviceProcess === child) serviceProcess = null;
      if (stopped || cancelled) return;
      if (state.phase === "ready") {
        fs.rmSync(assetsMarker, { force: true });
        writeState("failed", describeSetupFailure(error, readLogSince(serviceLogOffset)));
      }
      fs.rmSync(runtimeFile, { force: true });
    };
    child.once("error", (error) => recordServiceFailure(error));
    child.once("exit", (code, signal) => recordServiceFailure(new Error(`Kokoro service exited (${code ?? signal ?? "unknown"}).`)));
    return child;
  }

  async function waitForService(child) {
    const deadline = Date.now() + SERVICE_START_TIMEOUT_MS;
    while (!stopped && !cancelled && Date.now() < deadline) {
      if (serviceExitError || child.exitCode !== null || child.signalCode !== null) throw serviceExitError ?? new Error("Kokoro exited before it became ready.");
      const progress = readJson(setupProgressFile);
      if (progress?.phase === "loading-model" && typeof progress.message === "string") {
        writeState(
          "loading-model",
          progress.message.slice(0, 400),
          Number.isFinite(progress.progress) ? progress.progress : undefined,
          typeof progress.progressLabel === "string" ? progress.progressLabel : undefined,
        );
      }
      const health = await fetchJson(`${runtime.url}/health`, runtime.token, 2_000, setupAbortController.signal);
      if (cancelled) throw new Error("Kokoro setup was cancelled.");
      if (serviceExitError || child.exitCode !== null || child.signalCode !== null) throw serviceExitError ?? new Error("Kokoro exited before it became ready.");
      if (health?.ok === true && health?.engines?.kokoro?.enabled === true && health?.engines?.kokoro?.loaded === true) return;
      await delay(1_000);
    }
    if (stopped) throw new Error("Soundwave is closing.");
    if (cancelled) throw new Error("Kokoro setup was cancelled.");
    throw new Error("Kokoro did not finish loading before the startup timeout.");
  }

  async function runSetupAttempt() {
    if (runtime?.alreadyRunning) {
      writeState("ready", "On-device Kokoro is ready.");
      return;
    }
    if (stopped || cancelled) return;
    setupStarted = true;
    try {
      writeState("checking", "Soundwave is preparing the on-device Kokoro voice in the background.");
      for (const file of ["server.py", "kokoro_engine.py", "requirements-kokoro.txt"]) {
        if (!fs.existsSync(path.join(resourcesDir, file))) throw new Error(`The packaged Kokoro component is missing ${file}.`);
      }
      await ensureEnvironment();
      if (stopped || cancelled) return;
      writeState("loading-model", "Downloading and warming the Kokoro voice model in the background. This happens only once.");
      const child = launchService();
      await waitForService(child);
      if (!stopped && !cancelled) {
        atomicWriteJson(assetsMarker, { revision: RUNTIME_REVISION, readyAt: new Date().toISOString() });
        writeState("ready", "On-device Kokoro is ready.");
      }
    } catch (error) {
      if (stopped) return;
      if (cancelled) {
        writeState("cancelled", "Kokoro setup was cancelled. Soundwave voices are unaffected; choose Retry to continue later.");
        try {
          if (!pythonInstallerVerified()) fs.rmSync(pythonInstaller, { force: true });
        } catch {
          /* the Windows installer can remain locked until its process exits */
        }
        if (serviceProcess) {
          try {
            serviceProcess.kill();
          } catch {
            /* already exited */
          }
          serviceProcess = null;
        }
        fs.rmSync(runtimeFile, { force: true });
        return;
      }
      console.error("[soundwave-desktop] Kokoro setup failed:", error.message);
      fs.rmSync(assetsMarker, { force: true });
      writeState("failed", describeSetupFailure(error, readLogSince(setupLogOffset)));
      if (serviceProcess) {
        try {
          serviceProcess.kill();
        } catch {
          /* already exited */
        }
        serviceProcess = null;
      }
      fs.rmSync(runtimeFile, { force: true });
    }
  }

  function start() {
    if (setupPromise) return setupPromise;
    if (stopped || cancelled || state.phase === "ready") return Promise.resolve();
    if (setupStarted && !["failed", "cancelled"].includes(state.phase)) return Promise.resolve();
    try {
      setupLogOffset = fs.statSync(logFile).size;
    } catch {
      setupLogOffset = 0;
    }
    const attempt = runSetupAttempt();
    const tracked = attempt.finally(() => {
      if (setupPromise === tracked) setupPromise = null;
    });
    setupPromise = tracked;
    return tracked;
  }

  async function retrySetup() {
    if (stopped || !["failed", "cancelled"].includes(state.phase)) return false;
    if (setupPromise) await setupPromise.catch(() => {});
    if (stopped || !["failed", "cancelled"].includes(state.phase)) return false;

    try {
      fs.rmSync(runtimeFile, { force: true });
      fs.rmSync(setupProgressFile, { force: true });
      if (!pythonInstallerVerified()) fs.rmSync(pythonInstaller, { force: true });
      cleanIncompleteDownloads(cacheDir);
    } catch (error) {
      cancelled = false;
      writeState("failed", describeSetupFailure(error));
      return false;
    }

    cancelled = false;
    setupStarted = false;
    setupAbortController = new AbortController();
    writeState("checking", "Repairing Kokoro setup. Verified runtime, packages, and downloads will be reused.");
    void start();
    return true;
  }

  function configure(nextRuntime) {
    runtime = nextRuntime;
    manager.url = runtime.url;
    manager.token = runtime.token;
    if (runtime.alreadyRunning && Number.isInteger(runtime.pid) && runtime.pid > 0) reusedProcessId = runtime.pid;
  }

  function cancelSetup() {
    if (stopped || cancelled || ["ready", "failed", "cancelled"].includes(state.phase)) return false;
    cancelled = true;
    writeState(
      setupStarted ? "cancelling" : "cancelled",
      setupStarted ? "Cancelling Kokoro setup…" : "Kokoro setup was cancelled.",
    );
    setupAbortController.abort();
    for (const child of [activeProcess, serviceProcess]) {
      if (!child) continue;
      try {
        child.kill();
      } catch {
        /* already exited */
      }
    }
    activeProcess = null;
    serviceProcess = null;
    fs.rmSync(runtimeFile, { force: true });
    return true;
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    setupAbortController.abort();
    if (activeProcess) {
      try {
        activeProcess.kill();
      } catch {
        /* already exited */
      }
      activeProcess = null;
    }
    if (serviceProcess) {
      try {
        serviceProcess.kill();
      } catch {
        /* already exited */
      }
      serviceProcess = null;
    }
    if (reusedProcessId) {
      // Reuse is permitted only after /tts/kokoro/voices accepted this
      // install's private token, so this targets our own orphaned service.
      const killer = spawnProcess("taskkill.exe", ["/PID", String(reusedProcessId), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
      killer.unref?.();
      reusedProcessId = null;
    }
    fs.rmSync(runtimeFile, { force: true });
  }

  const manager = {
    url: "",
    token: "",
    statusFile,
    runtimeDir,
    configure,
    start,
    retrySetup,
    cancelSetup,
    stop,
    writeState,
    state: () => ({ ...state }),
  };
  return manager;
}

async function createManagedKokoro(options) {
  const manager = createKokoroManager(options);
  if (!manager) return null;

  const { userDataDir, getFreePort } = options;
  const runtimeDir = path.join(userDataDir, "kokoro");
  const runtimeFile = path.join(runtimeDir, "managed-runtime.json");
  fs.mkdirSync(runtimeDir, { recursive: true });
  const previous = readJson(runtimeFile);
  const revisionMatches = previous?.revision === RUNTIME_REVISION;
  if (revisionMatches && Number.isInteger(previous?.port) && previous.port > 0 && previous.port < 65536 && typeof previous.token === "string" && previous.token.length >= 32) {
    const url = `http://127.0.0.1:${previous.port}`;
    // /health is intentionally public on standalone installs. The voice list
    // is authenticated, so it proves that the saved token reaches our service.
    const voices = await fetchJson(`${url}/tts/kokoro/voices`, previous.token, 1_500);
    if (voices?.available === true && Array.isArray(voices?.voices) && Number.isInteger(previous.pid) && previous.pid > 0) {
      manager.configure({ ...previous, url, alreadyRunning: true });
      try {
        atomicWriteJson(path.join(runtimeDir, "assets-ready.json"), { revision: RUNTIME_REVISION, readyAt: new Date().toISOString() });
      } catch {
        /* the running service remains usable; the next launch can verify online */
      }
      manager.writeState("ready", "On-device Kokoro is ready.");
      return manager;
    }
  }

  const port = await getFreePort();
  const runtime = { revision: RUNTIME_REVISION, port, token: crypto.randomBytes(32).toString("hex"), pid: null };
  runtime.url = `http://127.0.0.1:${port}`;
  atomicWriteJson(runtimeFile, runtime);
  manager.configure(runtime);
  manager.writeState("checking", "Soundwave is preparing the on-device Kokoro voice in the background.");
  return manager;
}

module.exports = {
  PYTHON_INSTALLER_SHA256,
  PYTHON_INSTALLER_URL,
  PYTHON_VERSION,
  RUNTIME_REVISION,
  SETUP_REVISION,
  atomicWriteJson,
  assertFreeSpace,
  cleanIncompleteDownloads,
  createKokoroManager,
  createManagedKokoro,
  describeSetupFailure,
  downloadHttps,
  readJson,
  shouldManageLocalVoice,
};

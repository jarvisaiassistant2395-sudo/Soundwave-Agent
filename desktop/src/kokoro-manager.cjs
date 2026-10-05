// Manages the on-device narration and voice-cloning stack for the packaged Windows desktop app.
// First use provisions a per-user Python environment without a console;
// later runs start the local service in the background. Models and packages
// live under Electron's user-data folder, never inside the installer tree.
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const https = require("node:https");
const tls = require("node:tls");
const path = require("node:path");
const { spawn } = require("node:child_process");

const SETUP_REVISION = 3;
// The managed stack now includes CPU MOSS-TTS-Nano cloning as well as Kokoro.
// A runtime revision forces a restart so older Kokoro-only services are not
// mistaken for a complete offline-ready install.
const RUNTIME_REVISION = 3;
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
// Wheels, the Kokoro model cache, and the 727 MiB MOSS model need room to
// coexist during setup. This is a conservative free-space floor, not the exact
// download total (the Python and spaCy wheels vary by platform/version).
const MIN_PACKAGE_SETUP_FREE_BYTES = 3 * 1024 * 1024 * 1024;
const MIN_MOSS_SETUP_FREE_BYTES = 1024 * 1024 * 1024;
const TORCH_VERSION = "2.7.0";
const MOSS_SOURCE_REVISION = "8b7bcc9341b3b4ef3a3a58ba1338a7d85ff133eb";
const MOSS_SOURCE_ARCHIVE_URL = `https://github.com/OpenMOSS/MOSS-TTS-Nano/archive/${MOSS_SOURCE_REVISION}.zip`;
const MOSS_TTS_REPO_REVISION = "f52645cb467506d8e18e746ddd59482685b74e58";
const MOSS_CODEC_REPO_REVISION = "ceff0d0749bfb3fa2d61149794ec6feef0d1e1ae";
const MOSS_TTS_REPO_ID = "OpenMOSS-Team/MOSS-TTS-Nano-100M-ONNX";
const MOSS_CODEC_REPO_ID = "OpenMOSS-Team/MOSS-Audio-Tokenizer-Nano-ONNX";
const MOSS_SOURCE_MAX_BYTES = 20 * 1024 * 1024;
const MOSS_MODEL_FILES = [
  { repo: MOSS_TTS_REPO_ID, revision: MOSS_TTS_REPO_REVISION, model: "MOSS-TTS-Nano-100M-ONNX", path: "browser_poc_manifest.json", size: 503354, gitSha1: "8a04b980c3b9ea2f56747650ea255efe421ada38" },
  { repo: MOSS_TTS_REPO_ID, revision: MOSS_TTS_REPO_REVISION, model: "MOSS-TTS-Nano-100M-ONNX", path: "moss_tts_decode_step.onnx", size: 291483, sha256: "698cbc2fc1c2feca16e5895614ed52bbb32ded10f236c076f477b2e69abf32d8" },
  { repo: MOSS_TTS_REPO_ID, revision: MOSS_TTS_REPO_REVISION, model: "MOSS-TTS-Nano-100M-ONNX", path: "moss_tts_global_shared.data", size: 440813568, sha256: "bce8312c3df6a44545302cae229b61054fe0672e0b252ba59cba47adeed831dc" },
  { repo: MOSS_TTS_REPO_ID, revision: MOSS_TTS_REPO_REVISION, model: "MOSS-TTS-Nano-100M-ONNX", path: "moss_tts_local_cached_step.onnx", size: 53685, sha256: "aa9035fefc1c138a951a8bcfc0374fb03a25f1ece67f7f7f53bce349b84a1dd5" },
  { repo: MOSS_TTS_REPO_ID, revision: MOSS_TTS_REPO_REVISION, model: "MOSS-TTS-Nano-100M-ONNX", path: "moss_tts_local_decoder.onnx", size: 49231, sha256: "51aa754301b38550a5f9adda0ad93bd3dc95819afb511e6dcabf4a90b345a454" },
  { repo: MOSS_TTS_REPO_ID, revision: MOSS_TTS_REPO_REVISION, model: "MOSS-TTS-Nano-100M-ONNX", path: "moss_tts_local_fixed_sampled_frame.onnx", size: 471262, sha256: "40cdb00efc171c450cf91468e01429caa41b0252222cd308e978f58fe354afa8" },
  { repo: MOSS_TTS_REPO_ID, revision: MOSS_TTS_REPO_REVISION, model: "MOSS-TTS-Nano-100M-ONNX", path: "moss_tts_local_shared.data", size: 229678080, sha256: "bae7782032c0fb12490ab42afe009f87ae6c75a0f0596fc7b5c08e4d5ee93916" },
  { repo: MOSS_TTS_REPO_ID, revision: MOSS_TTS_REPO_REVISION, model: "MOSS-TTS-Nano-100M-ONNX", path: "moss_tts_prefill.onnx", size: 283305, sha256: "d56126dcd0574c2f15d98fc6b35eda68d0386b5bd9c5e38e28548d6f2ea8f3db" },
  { repo: MOSS_TTS_REPO_ID, revision: MOSS_TTS_REPO_REVISION, model: "MOSS-TTS-Nano-100M-ONNX", path: "tokenizer.model", size: 470897, sha256: "c353ee1479b536bf414c1b247f5542b6607fb8ae91320e5af1781fee200fddff" },
  { repo: MOSS_TTS_REPO_ID, revision: MOSS_TTS_REPO_REVISION, model: "MOSS-TTS-Nano-100M-ONNX", path: "tts_browser_onnx_meta.json", size: 4487, gitSha1: "883597607ce139b2c4871468396af2c088ed2fe0" },
  { repo: MOSS_CODEC_REPO_ID, revision: MOSS_CODEC_REPO_REVISION, model: "MOSS-Audio-Tokenizer-Nano-ONNX", path: "codec_browser_onnx_meta.json", size: 17036, gitSha1: "886953a56489516b847b7c1c953bde063eb78faa" },
  { repo: MOSS_CODEC_REPO_ID, revision: MOSS_CODEC_REPO_REVISION, model: "MOSS-Audio-Tokenizer-Nano-ONNX", path: "moss_audio_tokenizer_decode_full.onnx", size: 681902, sha256: "0fbbafe3fd4afa2a019af5c5ced204af6e2d1db044fa40f021525d2aee95b4ac" },
  { repo: MOSS_CODEC_REPO_ID, revision: MOSS_CODEC_REPO_REVISION, model: "MOSS-Audio-Tokenizer-Nano-ONNX", path: "moss_audio_tokenizer_decode_shared.data", size: 44198912, sha256: "e69d52e0f4e84ca27850557ee54face46632d3a5a16c89bd246c7c408466dcad" },
  { repo: MOSS_CODEC_REPO_ID, revision: MOSS_CODEC_REPO_REVISION, model: "MOSS-Audio-Tokenizer-Nano-ONNX", path: "moss_audio_tokenizer_decode_step.onnx", size: 351400, sha256: "9527c86a29e1837edec1f74db57d5eeaadb3a715af3382703566460afed25855" },
  { repo: MOSS_CODEC_REPO_ID, revision: MOSS_CODEC_REPO_REVISION, model: "MOSS-Audio-Tokenizer-Nano-ONNX", path: "moss_audio_tokenizer_encode.data", size: 44507136, sha256: "aa751265b2bab2887eac224484546b194875aa7494b607115439b3dc6b228a2c" },
  { repo: MOSS_CODEC_REPO_ID, revision: MOSS_CODEC_REPO_REVISION, model: "MOSS-Audio-Tokenizer-Nano-ONNX", path: "moss_audio_tokenizer_encode.onnx", size: 815775, sha256: "eadea4a645abdcf98714c7aead122ee2ce7da6e080f9f80b977cd1ca8e19473a" },
];
const MOSS_MODEL_DOWNLOAD_BYTES = MOSS_MODEL_FILES.reduce((total, item) => total + item.size, 0);
const MOSS_SOURCE_FILES = [
  { path: "onnx_tts_runtime.py", size: 29099, gitSha1: "c6b1d70cbcaa52cf51de138612ac2d0c6bec3435" },
  { path: "ort_cpu_runtime.py", size: 40665, gitSha1: "0b9e5d2c95b0e20d7044123b2e4515f1a76f96a6" },
  { path: "text_normalization_pipeline.py", size: 11909, gitSha1: "f755d7fc47e296f46ffcfd0dc53075e70af6d812" },
  { path: "tts_robust_normalizer_single_script.py", size: 17272, gitSha1: "014b3575332cd9522b8beee11056f9e3718e0e0d" },
  { path: "moss_tts_nano/__init__.py", size: 49, gitSha1: "a05eb9abb93a3c0a4e3f1ef478fe80d1793cee90" },
  { path: "moss_tts_nano/defaults.py", size: 350, gitSha1: "aaae6252c213ba1b6c1a5a6f604bc6c33472722f" },
  { path: "LICENSE", size: 11374, gitSha1: "f95ac2d6ec3449e33a18b54792e733a1701d6482" },
];
const MOSS_EXTRACTOR = String.raw`import pathlib, shutil, sys, zipfile
archive_path = pathlib.Path(sys.argv[1])
target = pathlib.Path(sys.argv[2]).resolve()
allowed = {
  "LICENSE",
  "onnx_tts_runtime.py",
  "ort_cpu_runtime.py",
  "text_normalization_pipeline.py",
  "tts_robust_normalizer_single_script.py",
  "moss_tts_nano/__init__.py",
  "moss_tts_nano/defaults.py",
}
target.mkdir(parents=True, exist_ok=True)
with zipfile.ZipFile(archive_path) as archive:
  for info in archive.infolist():
    parts = pathlib.PurePosixPath(info.filename).parts
    if len(parts) < 2 or parts[0].startswith("/") or ".." in parts:
      continue
    relative = pathlib.PurePosixPath(*parts[1:])
    if relative.as_posix() not in allowed:
      continue
    destination = (target / pathlib.Path(*relative.parts)).resolve()
    if target not in destination.parents:
      raise ValueError("unsafe path in MOSS source archive")
    destination.parent.mkdir(parents=True, exist_ok=True)
    with archive.open(info) as source, destination.open("wb") as output:
      shutil.copyfileobj(source, output)
`;

function defaultCpuThreads() {
  return Math.max(1, Math.min(4, (require("node:os").cpus()?.length ?? 2) - 1));
}

function formatMiB(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function pinnedFileValid(filePath, expected) {
  let fd;
  try {
    const stats = fs.statSync(filePath);
    if (!stats.isFile() || stats.size !== expected.size) return false;
    const sha256 = expected.sha256 ? crypto.createHash("sha256") : null;
    const gitSha1 = expected.gitSha1 ? crypto.createHash("sha1").update(`blob ${expected.size}\0`) : null;
    fd = fs.openSync(filePath, "r");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let bytesRead = 0;
    while ((bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      const chunk = buffer.subarray(0, bytesRead);
      sha256?.update(chunk);
      gitSha1?.update(chunk);
    }
    const actualSha256 = sha256?.digest("hex");
    const actualGitSha1 = gitSha1?.digest("hex");
    return (!expected.sha256 || actualSha256 === expected.sha256) && (!expected.gitSha1 || actualGitSha1 === expected.gitSha1);
  } catch {
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}


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
    const error = new Error(`Soundwave's local voice setup needs about ${requiredGb} GB of free disk space for ${purpose}; ${freeGb} GB is available. Free some space and choose Retry.`);
    error.code = "LOCAL_VOICE_INSUFFICIENT_DISK_SPACE";
    throw error;
  } catch (error) {
    if (error?.code === "LOCAL_VOICE_INSUFFICIENT_DISK_SPACE") throw error;
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

// Lines that are noise for a diagnosis: pip reports transient retries that it
// then recovers from, and the service prints progress. Matching the whole log
// once turned any failure into "needs an internet connection" because an
// earlier, recovered "Retrying ... timed out" warning was still in the tail.
const RECOVERED_NOISE = /Retrying \(Retry\(|^\s*WARNING:|^\s*Downloading |^\s*Requirement already satisfied|^\s*Collecting |^\s*Using cached /i;

/** The last lines that look like the actual failure (a traceback's final line, pip's ERROR:). */
function failureLines(logTail = "", max = 6) {
  const lines = String(logTail).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const picked = [];
  for (let i = lines.length - 1; i >= 0 && picked.length < max; i--) {
    const line = lines[i];
    if (RECOVERED_NOISE.test(line)) continue;
    if (/error|exception|failed|refused|denied|timed out|timeout|unreachable|certificate|ssl|proxy|errno|winerror/i.test(line)) picked.unshift(line);
  }
  return picked.join("\n");
}

const TLS_BLOCKED = /CERTIFICATE_VERIFY_FAILED|SSLCertVerificationError|certificate verify failed|self[- ]signed certificate|unable to get local issuer certificate|UNABLE_TO_VERIFY_LEAF_SIGNATURE|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_GET_ISSUER_CERT|CERT_HAS_EXPIRED|ERR_TLS_CERT|\bSSLError\b|\bEPROTO\b|wrong version number/i;
// Error codes as whole words: case-insensitively, "ModuleNotFoundError"
// contains "eNotFound" and was being reported as no internet.
const NO_CONNECTION = /\b(?:ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH)\b|network is unreachable|getaddrinfo failed|(?:temporary )?failure in name resolution|nameresolutionerror|failed to establish a new connection|max retries exceeded|newconnectionerror|connectionreseterror|remotedisconnected|connection (?:aborted|broken|reset)|proxyerror|could not fetch url|no route to host|download timed out|read timed out|connecttimeout|winerror 100(?:51|54|60|61)/i;

function hostIn(text) {
  const m = /(?:https?:\/\/|host='?|getaddrinfo \w+ )([a-z0-9-]+(?:\.[a-z0-9-]+)+)/i.exec(text);
  return m ? m[1] : "";
}

function oneLine(text, max = 220) {
  return String(text ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

function describeSetupFailure(error, logTail = "", logPath = "") {
  const summary = `${error?.code ?? ""} ${error?.message ?? error ?? ""}`;
  const fromLog = failureLines(logTail);
  const evidence = `${summary}\n${fromLog}`;
  const where = logPath ? ` Details: ${logPath}` : " Details are in the local voice setup log (kokoro.log in Soundwave's app data).";
  const detail = oneLine(fromLog.split("\n").pop() || error?.message || "");
  const because = detail ? ` (${detail})` : "";
  const kept = "Completed runtime, packages, and model files are kept.";
  if (/LOCAL_VOICE_INSUFFICIENT_DISK_SPACE|KOKORO_INSUFFICIENT_DISK_SPACE|ENOSPC|no space left on device|disk quota exceeded|not enough (?:free )?disk space|WinError 112|insufficient disk space/i.test(evidence)) {
    return /Soundwave's local voice setup needs about/i.test(summary)
      ? String(error.message)
      : `There isn't enough free disk space to finish local voice setup. Free up space and choose Retry; ${kept.toLowerCase()}`;
  }
  if (TLS_BLOCKED.test(evidence)) {
    const host = hostIn(evidence);
    return `Local voice setup reached ${host || "the download server"}, but a secure connection was blocked${because}. This is usually antivirus web/HTTPS scanning, a VPN, or a proxy intercepting downloads — not your internet connection. Allow Soundwave (or pause HTTPS scanning) and choose Retry. ${kept}${where}`;
  }
  if (NO_CONNECTION.test(evidence)) {
    const host = hostIn(evidence);
    return `Local voice setup couldn't download from ${host || "a setup server"}${because}. If your internet is working, a firewall, antivirus, VPN, or proxy may be blocking it, or the server was briefly unavailable. Choose Retry. ${kept}${where}`;
  }
  if (/timed out during local voice setup/i.test(summary)) {
    return `A local voice setup step took too long and was stopped${because}. Choose Retry to continue where it left off. ${kept}${where}`;
  }
  return `Local voice setup couldn't finish${because}. Choose Retry to continue. ${kept}${where}`;
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

// Antivirus HTTPS scanning and company proxies re-sign traffic with a root
// they install in the Windows certificate store. Trust that store as well as
// Node's bundled roots, so downloads work wherever the browser works.
let httpsAgent;
function downloadAgent() {
  if (httpsAgent !== undefined) return httpsAgent;
  httpsAgent = null;
  try {
    if (typeof tls.getCACertificates === "function") {
      const ca = [...new Set([...tls.getCACertificates("default"), ...tls.getCACertificates("system")])];
      httpsAgent = new https.Agent({ ca, keepAlive: false });
    }
  } catch {
    httpsAgent = null; // older runtime: Node's bundled roots
  }
  return httpsAgent;
}

/** A failure worth retrying (connection trouble), not a bad file or a cancel. */
function retryableDownloadError(error) {
  const text = `${error?.code ?? ""} ${error?.message ?? ""}`;
  if (/cancelled|checksum|larger than expected|bytes; expected|insecure|must use HTTPS|Too many redirects|ENOSPC|EACCES|EPERM/i.test(text)) return false;
  if (/HTTP (?:4(?:0[0-9]|1[0-9]))\b/.test(text) && !/HTTP 408|HTTP 429/.test(text)) return false;
  return true;
}

async function downloadHttps(url, destination, options = {}) {
  const attempts = options.attempts ?? 4;
  for (let attempt = 1; ; attempt++) {
    try {
      return await downloadHttpsOnce(url, destination, options);
    } catch (error) {
      if (attempt >= attempts || options.signal?.aborted || !retryableDownloadError(error)) throw error;
      await delay(Math.min(15_000, 2_000 * attempt * attempt));
      if (options.signal?.aborted) throw error;
    }
  }
}

function downloadHttpsOnce(url, destination, { sha256, gitSha1, expectedBytes, maxBytes, label = "download", onProgress, signal } = {}) {
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
    const onAbort = () => finish(new Error(`The local voice ${label} was cancelled.`));

    const request = (currentUrl, redirects = 0) => {
      if (settled) return;
      let parsed;
      try {
        parsed = new URL(currentUrl);
      } catch (error) {
        return finish(error);
      }
      if (parsed.protocol !== "https:") return finish(new Error("Downloads must use HTTPS."));
      if (redirects > 5) return finish(new Error(`Too many redirects while downloading ${label}.`));

      const req = https.get(parsed, { headers: { "User-Agent": "SoundwaveAI-Desktop" }, timeout: 60_000, ...(downloadAgent() ? { agent: downloadAgent() } : {}) }, (res) => {
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
          return finish(new Error(`The ${label} download returned HTTP ${res.statusCode ?? "?"}.`));
        }
        const length = Number(res.headers["content-length"] ?? 0);
        if (length > maxBytes) {
          res.resume();
          return finish(new Error(`The ${label} download was larger than expected.`));
        }

        const hash = crypto.createHash("sha256");
        const gitHash = gitSha1 ? crypto.createHash("sha1").update(`blob ${expectedBytes}\0`) : null;
        let received = 0;
        const output = fs.createWriteStream(destination);
        activeOutput = output;
        res.on("data", (chunk) => {
          received += chunk.length;
          if (received > maxBytes) {
            req.destroy(new Error(`The ${label} download was larger than expected.`));
            return;
          }
          hash.update(chunk);
          gitHash?.update(chunk);
          if (typeof onProgress === "function") onProgress(received, length);
        });
        res.on("error", (error) => output.destroy(error));
        output.on("error", finish);
        output.on("finish", () => {
          const actual = hash.digest("hex");
          const actualGitSha1 = gitHash?.digest("hex");
          if (expectedBytes !== undefined && received !== expectedBytes) {
            return finish(new Error(`The ${label} download had ${received} bytes; expected ${expectedBytes}.`));
          }
          if (sha256 && actual.toLowerCase() !== sha256.toLowerCase()) {
            return finish(new Error(`The ${label} SHA-256 checksum didn't match the pinned manifest.`));
          }
          if (gitSha1 && actualGitSha1?.toLowerCase() !== gitSha1.toLowerCase()) {
            return finish(new Error(`The ${label} Git blob checksum didn't match the pinned revision.`));
          }
          finish();
        });
        res.pipe(output);
      });
      activeRequest = req;
      req.on("timeout", () => req.destroy(new Error(`The ${label} download timed out (${parsed.hostname}).`)));
      req.on("error", (error) => {
        // Name the server: "ECONNRESET" alone doesn't say what was blocked.
        if (error && !String(error.message).includes(parsed.hostname)) error.message = `${error.message} (https://${parsed.hostname})`;
        finish(error);
      });
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
  prepareVoiceAssets: prepareVoiceAssetsOverride,
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
  const mossSourceDir = path.join(runtimeDir, "moss-source");
  const mossSourceMarker = path.join(runtimeDir, "moss-source-ready.json");
  const mossModelDir = path.join(runtimeDir, "models");
  const cpuThreads = defaultCpuThreads();

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
  // Automatic retries after a failure (a dropped connection, a server
  // hiccup): people shouldn't have to babysit setup. Reset on success.
  const AUTO_RETRY_DELAYS_MS = [20_000, 90_000, 5 * 60_000];
  let autoRetries = 0;
  let autoRetryTimer = null;
  let state = { phase: "checking", message: "Soundwave is preparing the on-device narration and voice-cloning engines in the background." };

  function writeState(phase, message, progress, progressLabel, extras = {}) {
    if (cancelled && phase !== "cancelling" && phase !== "cancelled") return;
    state = {
      managed: true,
      phase,
      message,
      ...(typeof extras.cloneError === "string" && extras.cloneError ? { cloneError: extras.cloneError.slice(0, 600) } : {}),
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
      console.warn("[soundwave-desktop] could not save local voice setup status:", error.message);
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
      if (stopped || cancelled) return reject(new Error(stopped ? "Local voice setup was cancelled because Soundwave is closing." : "Local voice setup was cancelled."));
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
        else if (!successCodes.includes(code)) reject(new Error(`${path.basename(executable)} exited with code ${code ?? "unknown"}. See the local voice setup log in Soundwave's user-data folder.`));
        else resolve(code);
      };
      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          /* already exited */
        }
        finish(new Error(`${path.basename(executable)} timed out during local voice setup.`));
      }, timeoutMs);
      timer.unref?.();
      child.once("error", (error) => finish(error));
      child.once("exit", (code) => finish(null, code));
    });
  }

  function mossSourceVerified() {
    return MOSS_SOURCE_FILES.every((item) => pinnedFileValid(path.join(mossSourceDir, ...item.path.split("/")), item));
  }

  async function ensureMossSource() {
    if (mossSourceVerified()) {
      if (readJson(mossSourceMarker)?.revision !== MOSS_SOURCE_REVISION) {
        atomicWriteJson(mossSourceMarker, { revision: MOSS_SOURCE_REVISION, verifiedAt: new Date().toISOString() });
      }
      return;
    }

    assertFreeSpace(runtimeDir, MIN_MOSS_SETUP_FREE_BYTES, "the MOSS-TTS-Nano runtime and model assets");
    writeState("loading-model", "Downloading the pinned MOSS-TTS-Nano CPU runtime.", 0, "MOSS runtime source");
    const archive = path.join(cacheDir, `MOSS-TTS-Nano-${MOSS_SOURCE_REVISION}.zip`);
    fs.rmSync(archive, { force: true });
    await downloadHttps(MOSS_SOURCE_ARCHIVE_URL, archive, {
      maxBytes: MOSS_SOURCE_MAX_BYTES,
      label: "MOSS runtime source",
      signal: setupAbortController.signal,
      onProgress: (received, total) => {
        const progress = total > 0 ? Math.round((received / total) * 100) : undefined;
        writeState(
          "loading-model",
          "Downloading the pinned MOSS-TTS-Nano CPU runtime.",
          progress,
          progress === undefined ? "MOSS runtime source" : `MOSS runtime source (${progress}%)`,
        );
      },
    });
    if (stopped || cancelled) throw new Error("Local voice setup was cancelled.");
    writeState("loading-model", "Verifying and extracting the pinned MOSS runtime source.", undefined, "MOSS runtime source");
    fs.rmSync(mossSourceDir, { recursive: true, force: true });
    await runCommand(pythonExe, ["-c", MOSS_EXTRACTOR, archive, mossSourceDir], {
      cwd: runtimeDir,
      env: managedPythonEnv(),
      timeoutMs: 60_000,
    });
    fs.rmSync(archive, { force: true });
    if (!mossSourceVerified()) throw new Error("The downloaded MOSS runtime source didn't match its pinned Git revision.");
    atomicWriteJson(mossSourceMarker, { revision: MOSS_SOURCE_REVISION, verifiedAt: new Date().toISOString() });
  }

  async function ensureMossModelAssets() {
    const allVerified = MOSS_MODEL_FILES.every((item) => pinnedFileValid(path.join(mossModelDir, item.model, item.path), item));
    if (allVerified) return;

    assertFreeSpace(runtimeDir, MIN_MOSS_SETUP_FREE_BYTES, "the 727 MiB MOSS-TTS-Nano ONNX model");
    fs.mkdirSync(mossModelDir, { recursive: true });
    let completedBytes = 0;
    const reportProgress = (received, total, item) => {
      const progress = Math.round((received / Math.max(1, total)) * 100);
      writeState(
        "loading-model",
        `Downloading MOSS-TTS-Nano CPU clone assets (${formatMiB(received)} of ${formatMiB(total)}).`,
        progress,
        `MOSS model (${formatMiB(received)} / ${formatMiB(total)})`,
      );
    };

    for (const item of MOSS_MODEL_FILES) {
      if (stopped || cancelled) throw new Error("Local voice setup was cancelled.");
      const destination = path.join(mossModelDir, item.model, item.path);
      if (pinnedFileValid(destination, item)) {
        completedBytes += item.size;
        reportProgress(completedBytes, MOSS_MODEL_DOWNLOAD_BYTES, item);
        continue;
      }
      fs.rmSync(destination, { force: true });
      const encodedPath = item.path.split("/").map(encodeURIComponent).join("/");
      const url = `https://huggingface.co/${item.repo}/resolve/${item.revision}/${encodedPath}`;
      const assetBase = completedBytes;
      await downloadHttps(url, destination, {
        sha256: item.sha256,
        gitSha1: item.gitSha1,
        expectedBytes: item.size,
        maxBytes: item.size,
        label: "MOSS model asset",
        signal: setupAbortController.signal,
        onProgress: (received) => reportProgress(assetBase + received, MOSS_MODEL_DOWNLOAD_BYTES, item),
      });
      if (!pinnedFileValid(destination, item)) throw new Error(`MOSS model asset ${item.path} failed its pinned integrity check.`);
      completedBytes += item.size;
      reportProgress(completedBytes, MOSS_MODEL_DOWNLOAD_BYTES, item);
    }
  }

  async function ensureVoiceAssets() {
    if (typeof prepareVoiceAssetsOverride === "function") {
      await prepareVoiceAssetsOverride({
        signal: setupAbortController.signal,
        reportProgress: (received, total, label = "MOSS model") => {
          const progress = total > 0 ? Math.round((received / total) * 100) : undefined;
          writeState("loading-model", `Preparing ${label}.`, progress, label);
        },
      });
      return;
    }
    await ensureMossSource();
    await ensureMossModelAssets();
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
    if (stopped || cancelled) throw new Error("Local voice setup was cancelled.");
    writeState("installing-python", "Installing the private Python runtime for local voice in the background.", undefined, "Python runtime");
    fs.rmSync(pythonHome, { recursive: true, force: true });
    fs.mkdirSync(runtimeDir, { recursive: true });
    if (!pythonInstallerVerified()) {
      assertFreeSpace(runtimeDir, MIN_PYTHON_SETUP_FREE_BYTES, "the Python runtime");
      fs.rmSync(pythonInstaller, { force: true });
      writeState("installing-python", "Downloading the signed Python runtime for local voice.", 0, "Python runtime download");
      let lastProgress = -1;
      await downloadHttps(PYTHON_INSTALLER_URL, pythonInstaller, {
        sha256: PYTHON_INSTALLER_SHA256,
        maxBytes: MAX_PYTHON_INSTALLER_BYTES,
        label: "Python runtime",
        signal: setupAbortController.signal,
        onProgress: (received, total) => {
          const progress = total > 0 ? Math.round((received / total) * 100) : undefined;
          if (progress !== undefined && progress !== lastProgress) {
            lastProgress = progress;
            writeState("installing-python", "Downloading the signed Python runtime for local voice.", progress, "Python runtime download");
          }
        },
      });
    }
    writeState("installing-python", "Installing the private Python runtime for local voice.", undefined, "Installing Python runtime");
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
          ["-c", "import fastapi, huggingface_hub, misaki, numpy, onnxruntime, sentencepiece, spacy, torch, torchaudio, transformers, uvicorn; from kokoro.model import KModel; assert torch.__version__.split('+')[0] == '2.7.0'; assert torchaudio.__version__.split('+')[0] == '2.7.0'; print('Kokoro + MOSS CPU runtime verified')"],
          { cwd: resourcesDir, env: managedPythonEnv(), timeoutMs: 60_000 },
        );
        return;
      } catch {
        // A broken or incomplete update is repaired below; no app crash.
      }
    }

    assertFreeSpace(runtimeDir, MIN_PACKAGE_SETUP_FREE_BYTES, "Kokoro narration, MOSS cloning, and their Python packages");
    writeState("installing-packages", "Preparing Soundwave's private on-device voice environment.", undefined, "Isolated Python environment");
    fs.mkdirSync(runtimeDir, { recursive: true });
    // Retry settings go through pip's environment (PIP_RETRIES / PIP_TIMEOUT) so
    // every pip run gets them, including the one spaCy starts for its model.
    // (Passed as arguments to spaCy's download they reached pip as a package
    // name: "No matching distribution found for 10".)
    const pipEnv = managedPythonEnv({
      PIP_CACHE_DIR: path.join(cacheDir, "pip"),
      PIP_DISABLE_PIP_VERSION_CHECK: "1",
      PIP_RETRIES: "10",
      PIP_TIMEOUT: "60",
    });
    if (!fs.existsSync(venvPython)) {
      await runCommand(pythonExe, ["-m", "venv", venvDir], { cwd: runtimeDir, env: pipEnv, timeoutMs: 2 * 60_000 });
    }
    // pip retries flaky connections itself (PIP_RETRIES above) and, from pip
    // 24.2, trusts the Windows certificate store.
    const common = ["-m", "pip", "install", "--disable-pip-version-check", "--progress-bar", "off"];
    const packageSteps = 6;
    let completedPackageSteps = 0;
    const runPackageStep = async (label, executable, args, options = {}) => {
      const progress = Math.round((completedPackageSteps / packageSteps) * 100);
      writeState("installing-packages", `Installing ${label} for the local voice service.`, progress, `${label} (${completedPackageSteps + 1}/${packageSteps})`);
      await runCommand(executable, args, options);
      completedPackageSteps++;
    };
    await runPackageStep("the package installer", venvPython, [...common, "--upgrade", "pip"], { cwd: resourcesDir, env: pipEnv });
    // CPU-only PyTorch: works on ordinary Windows PCs without CUDA or an
    // NVIDIA card and avoids pulling the multi-gigabyte CUDA runtime.
    await runPackageStep(
      "CPU PyTorch and Torchaudio",
      venvPython,
      [...common, `torch==${TORCH_VERSION}`, `torchaudio==${TORCH_VERSION}`, "--index-url", TORCH_CPU_INDEX],
      { cwd: resourcesDir, env: pipEnv },
    );
    await runPackageStep("Local voice dependencies", venvPython, [...common, "-r", path.join(resourcesDir, "requirements-kokoro.txt")], { cwd: resourcesDir, env: pipEnv });
    // Installing the package without its optional [en] extra is deliberate:
    // that extra brings GPL phonemizer/espeak-ng, which Soundwave never uses.
    await runPackageStep("Kokoro's speech engine", venvPython, [...common, "--no-deps", "kokoro"], { cwd: resourcesDir, env: pipEnv });
    // spaCy looks up the model with requests (certifi roots only); truststore
    // makes it trust the Windows store too, like pip and the browser do.
    await runPackageStep(
      "English pronunciation data",
      venvPython,
      ["-c", "import truststore; truststore.inject_into_ssl(); from spacy.cli import download; download('en_core_web_sm')"],
      { cwd: resourcesDir, env: pipEnv },
    );
    await runPackageStep(
      "runtime verification",
      venvPython,
      [
        "-c",
        "import sys, truststore, fastapi, huggingface_hub, misaki, numpy, onnxruntime, sentencepiece, spacy, torch, torchaudio, transformers, uvicorn; from kokoro.model import KModel; forbidden={'phonemizer','espeakng_loader','misaki.espeak'} & set(sys.modules); assert not forbidden, forbidden; assert torch.__version__.split('+')[0] == '2.7.0'; assert torchaudio.__version__.split('+')[0] == '2.7.0'; print('Kokoro + MOSS CPU runtime verified')",
      ],
      { cwd: resourcesDir, env: pipEnv, timeoutMs: 2 * 60_000 },
    );
    atomicWriteJson(installMarker, { revision: SETUP_REVISION, python: PYTHON_VERSION, installedAt: new Date().toISOString() });
    writeState("installing-packages", "The on-device narration and cloning packages are ready.", 100, "Python packages");
  }

  function readLogSince(offset = 0) {
    try {
      const log = fs.readFileSync(logFile);
      return log.subarray(Math.min(offset, log.length)).toString("utf8").slice(-20_000);
    } catch {
      return "";
    }
  }

  function launchService({ mossEnabled = true } = {}) {
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
      // Cloning is optional for the managed app: Kokoro narration must come up
      // even when the cloning model couldn't be downloaded or loaded.
      MOSS_OFF: mossEnabled ? "0" : "1",
      MOSS_OPTIONAL: "1",
      MOSS_PRELOAD: "1",
      MOSS_SOURCE_DIR: mossSourceDir,
      MOSS_MODEL_DIR: mossModelDir,
      MOSS_CPU_THREADS: String(cpuThreads),
      LOCAL_TTS_CPU_THREADS: String(cpuThreads),
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
      if (stopped || cancelled || child.soundwaveRestarting) return;
      if (state.phase === "ready") {
        fs.rmSync(assetsMarker, { force: true });
        writeState("failed", describeSetupFailure(error, readLogSince(serviceLogOffset), logFile));
      }
      fs.rmSync(runtimeFile, { force: true });
    };
    child.once("error", (error) => recordServiceFailure(error));
    child.once("exit", (code, signal) => recordServiceFailure(new Error(`Kokoro service exited (${code ?? signal ?? "unknown"}).`)));
    return child;
  }

  /** Resolves with the health once Kokoro is loaded and cloning has settled (loaded, failed, or off). */
  async function waitForService(child) {
    const deadline = Date.now() + SERVICE_START_TIMEOUT_MS;
    while (!stopped && !cancelled && Date.now() < deadline) {
      if (serviceExitError || child.exitCode !== null || child.signalCode !== null) throw serviceExitError ?? new Error("The local voice service exited before it became ready.");
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
      if (cancelled) throw new Error("Local voice setup was cancelled.");
      if (serviceExitError || child.exitCode !== null || child.signalCode !== null) throw serviceExitError ?? new Error("The local voice service exited before it became ready.");
      if (
        health?.ok === true &&
        health?.engines?.kokoro?.enabled === true &&
        health?.engines?.kokoro?.loaded === true &&
        (health?.engines?.moss?.enabled !== true || health?.engines?.moss?.loaded === true || typeof health?.engines?.moss?.error === "string")
      ) return health;
      await delay(1_000);
    }
    if (stopped) throw new Error("Soundwave is closing.");
    if (cancelled) throw new Error("Local voice setup was cancelled.");
    throw new Error("The local voice engines did not finish loading before the startup timeout.");
  }

  function scheduleAutoRetry(reason) {
    if (stopped || cancelled || autoRetryTimer) return false;
    if (/disk space/i.test(reason)) return false; // retrying can't fix a full disk
    const wait = AUTO_RETRY_DELAYS_MS[autoRetries];
    if (wait === undefined) return false;
    autoRetries++;
    autoRetryTimer = setTimeout(() => {
      autoRetryTimer = null;
      if (!stopped && !cancelled) void retrySetup();
    }, wait);
    autoRetryTimer.unref?.();
    return wait;
  }

  function waitLabel(ms) {
    return ms >= 60_000 ? `${Math.round(ms / 60_000)} minute${ms >= 120_000 ? "s" : ""}` : `${Math.round(ms / 1000)} seconds`;
  }

  async function runSetupAttempt() {
    if (runtime?.alreadyRunning) {
      writeState("ready", "On-device narration and voice cloning are ready.");
      return;
    }
    if (stopped || cancelled) return;
    setupStarted = true;
    try {
      writeState("checking", "Soundwave is preparing its on-device narration and voice-cloning engines in the background.");
      for (const file of ["server.py", "kokoro_engine.py", "moss_engine.py", "requirements-kokoro.txt"]) {
        if (!fs.existsSync(path.join(resourcesDir, file))) throw new Error(`The packaged local voice component is missing ${file}.`);
      }
      await ensureEnvironment();
      if (stopped || cancelled) return;
      // The cloning model (~730 MB) must not hold the Kokoro voices hostage:
      // if its download fails, narration still starts and cloning says why.
      let cloneError = "";
      try {
        await ensureVoiceAssets();
      } catch (error) {
        if (stopped || cancelled) throw error;
        console.warn("[soundwave-desktop] voice-cloning assets unavailable:", error.message);
        cloneError = describeSetupFailure(error, readLogSince(setupLogOffset), logFile);
      }
      if (stopped || cancelled) return;
      writeState(
        "loading-model",
        cloneError ? "Loading Kokoro narration voices." : "Loading Kokoro narration and the CPU voice-cloning model.",
        undefined,
        "Loading local voice engines",
      );
      const child = launchService({ mossEnabled: !cloneError });
      const health = await waitForService(child);
      if (!cloneError && typeof health?.engines?.moss?.error === "string") {
        cloneError = describeSetupFailure(new Error(health.engines.moss.error), "", logFile);
      }
      if (!stopped && !cancelled) {
        atomicWriteJson(assetsMarker, { revision: RUNTIME_REVISION, readyAt: new Date().toISOString() });
        if (cloneError) {
          const wait = scheduleAutoRetry(cloneError);
          const next = wait ? ` Soundwave will try cloning again by itself in ${waitLabel(wait)}.` : "";
          writeState("ready", `Kokoro narration voices are ready. Voice cloning isn't yet: ${cloneError}${next}`, undefined, undefined, { cloneError });
        } else {
          autoRetries = 0;
          writeState("ready", "On-device narration and voice cloning are ready.");
        }
      }
    } catch (error) {
      if (stopped) return;
      if (cancelled) {
        writeState("cancelled", "Local voice setup was cancelled. Soundwave voices are unaffected; choose Retry to continue later.");
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
      console.error("[soundwave-desktop] local voice setup failed:", error.message);
      fs.rmSync(assetsMarker, { force: true });
      const reason = describeSetupFailure(error, readLogSince(setupLogOffset), logFile);
      const wait = scheduleAutoRetry(reason);
      writeState("failed", wait ? `${reason} Soundwave will try again by itself in ${waitLabel(wait)} — you don't need to do anything.` : reason);
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
    if (autoRetryTimer) {
      clearTimeout(autoRetryTimer);
      autoRetryTimer = null;
    }
    const retryable = () => ["failed", "cancelled"].includes(state.phase) || (state.phase === "ready" && Boolean(state.cloneError));
    if (stopped || !retryable()) return false;
    if (setupPromise) await setupPromise.catch(() => {});
    if (stopped || !retryable()) return false;
    if (state.phase === "ready" && serviceProcess) {
      // Kokoro works but cloning didn't: restart the service with cloning on.
      const running = serviceProcess;
      running.soundwaveRestarting = true;
      serviceProcess = null;
      try {
        running.kill();
      } catch {
        /* already exited */
      }
      await new Promise((resolve) => {
        if (running.exitCode !== null || running.signalCode !== null) return resolve();
        running.once?.("exit", resolve);
        setTimeout(resolve, 5_000).unref?.();
      });
    }

    try {
      fs.rmSync(runtimeFile, { force: true });
      fs.rmSync(setupProgressFile, { force: true });
      if (!pythonInstallerVerified()) fs.rmSync(pythonInstaller, { force: true });
      cleanIncompleteDownloads(cacheDir);
    } catch (error) {
      cancelled = false;
      writeState("failed", describeSetupFailure(error, "", logFile));
      return false;
    }

    cancelled = false;
    setupStarted = false;
    setupAbortController = new AbortController();
    writeState("checking", "Repairing local voice setup. Verified runtime, packages, and model assets will be reused.");
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
      setupStarted ? "Cancelling local voice setup…" : "Local voice setup was cancelled.",
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
    if (autoRetryTimer) clearTimeout(autoRetryTimer);
    autoRetryTimer = null;
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
      manager.writeState("ready", "On-device narration and voice cloning are ready.");
      return manager;
    }
  }

  const port = await getFreePort();
  const runtime = { revision: RUNTIME_REVISION, port, token: crypto.randomBytes(32).toString("hex"), pid: null };
  runtime.url = `http://127.0.0.1:${port}`;
  atomicWriteJson(runtimeFile, runtime);
  manager.configure(runtime);
  manager.writeState("checking", "Soundwave is preparing the on-device narration and voice-cloning engines in the background.");
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

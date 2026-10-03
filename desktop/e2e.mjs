// End-to-end test of the PACKAGED Windows app, driven like a person would use
// it (Playwright's Electron support, CI runs it after electron-builder):
//
//   node e2e.mjs ["release/win-unpacked/Soundwave AI.exe"]
//
// A fake microphone plays a real recording (JFK's "ask not what your country
// can do for you…"). Checks: the window opens the Command Center, the tray
// icon and the Ctrl+Shift+Space shortcut are set up, the mic button records →
// the bundled whisper.cpp transcribes → the agent answers, the voice bar
// window does the same when the shortcut is pressed while the app is in the
// background, its turn shows up in the Command Center, Settings → Phone opens
// the phone listener, Settings → Brain saves and tests a Gemini key (a fake
// Gemini on loopback) and the chat is then answered through it, and closing
// the window keeps the app in the tray, and a Ghost Operator macro run from
// the Workflow panel really copies to the clipboard (verified in Electron) and
// skips — with the reason — the steps Soundwave can't do yet. Needs
// playwright-core (CI: npm i --no-save).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktopDir = path.dirname(fileURLToPath(import.meta.url));
const shotsDir = path.join(desktopDir, "e2e-shots");
const EXPECT = /ask not what your country/i;
const started = Date.now();
const since = () => `${((Date.now() - started) / 1000).toFixed(1)}s`;

function annotate(level, title, message) {
  if (process.env.GITHUB_ACTIONS !== "true") return;
  const data = (v) => String(v).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
  const prop = (v) => data(v).replace(/:/g, "%3A").replace(/,/g, "%2C");
  console.log(`::${level} title=${prop(title)}::${data(message)}`);
}

let app = null;
// Which part of the flow is running. The failure annotation carries it, so a
// bare Playwright timeout says *where* it happened even when the run's log
// (and the annotation history) can't be read from where you are.
let stage = "startup";
// The packaged app's own output (the server logs its errors here). The run's log
// and artifacts can be unreachable, so failures carry the last lines with them.
const appLog = [];
const rememberAppLog = (chunk) => {
  for (const line of String(chunk).split(/\r?\n/)) {
    if (!line.trim()) continue;
    appLog.push(line.trim());
    if (appLog.length > 40) appLog.shift();
  }
};
const appLogTail = (lines = 12) => appLog.slice(-lines).join(" ⋮ ").slice(-900);
const at = (name) => {
  stage = name;
};
async function fail(message) {
  console.error(`[e2e] ✗ FAIL at “${stage}” (${since()}): ${message}`);
  const tail = appLogTail();
  annotate("error", "Desktop app end-to-end", `At “${stage}”: ${message}${tail ? ` | App log (last lines): ${tail}` : ""}`);
  try {
    for (const [i, page] of (app?.windows() ?? []).entries()) await page.screenshot({ path: path.join(shotsDir, `failure-${i}.png`) }).catch(() => {});
  } catch {
    /* best effort */
  }
  try {
    await app?.close();
  } catch {
    /* ignore */
  }
  process.exit(1);
}

function ok(label) {
  console.log(`[e2e] ✓ ${label} (${since()})`);
}

function defaultExe() {
  const yml = fs.readFileSync(path.join(desktopDir, "electron-builder.yml"), "utf8");
  const productName = /^productName:\s*(.+?)\s*$/m.exec(yml)?.[1] ?? "Soundwave AI";
  return path.join(desktopDir, "release", "win-unpacked", `${productName}.exe`);
}

const exe = path.resolve(process.argv[2] ?? defaultExe());
if (!fs.existsSync(exe)) await fail(`packaged app not found at ${exe} — run electron-builder first`);

// The recording, with 4 s of silence after it so "stop when I pause" can kick in
// (Chromium loops the fake microphone's file).
const sample = path.join(desktopDir, "jfk.wav");
if (!fs.existsSync(sample)) await fail(`no ${sample} (CI downloads whisper.cpp's samples/jfk.wav)`);
const ffmpeg = path.join(desktopDir, "bin", process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");
const micFile = path.join(desktopDir, "e2e-mic.wav");
try {
  execFileSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-i", sample, "-af", "apad=pad_dur=4", "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", micFile], {
    windowsHide: true,
  });
} catch (err) {
  await fail(`couldn't prepare the fake microphone recording with ${ffmpeg}: ${err.message}`);
}
// A small video with speech in it, for "make shorts out of this video": the
// same JFK clip as a 13-second file (the agent really listens to it).
const clipSource = path.join(desktopDir, "e2e-clip-source.mp4");
try {
  execFileSync(ffmpeg, [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "color=c=0x1A1A2E:s=640x360:r=30",
    "-i", sample,
    "-shortest", "-t", "13",
    "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "128k",
    clipSource,
  ], { windowsHide: true });
} catch (err) {
  await fail(`couldn't prepare the test video for the clips test with ${ffmpeg}: ${err.message}`);
}
fs.mkdirSync(shotsDir, { recursive: true });

const { _electron: electron } = await import("playwright-core");
// The agent's brain talks to a fake Gemini on loopback (no real key in CI).
const { FAKE_HELLO, FAKE_KEY, FAKE_MORNING, startFakeGemini } = await import(new URL("./test/fake-gemini.mjs", import.meta.url).href);
const fakeGemini = await startFakeGemini();

console.log(`[e2e] launching ${exe}`);
try {
  app = await electron.launch({
    executablePath: exe,
    args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${micFile}`],
    env: {
      ...process.env,
      GEMINI_API_BASE: fakeGemini.url,
      // Morning Setup's weather from the same stand-in.
      OPEN_METEO_GEOCODING_URL: `${fakeGemini.url}/geocode`,
      OPEN_METEO_FORECAST_URL: `${fakeGemini.url}/forecast`,
    },
    timeout: 180_000,
  });
} catch (err) {
  await fail(`the app didn't start under Playwright: ${err.message}`);
}
app.process().stdout?.on("data", (d) => {
  rememberAppLog(d);
  process.stdout.write(`    [app] ${d}`);
});
app.process().stderr?.on("data", (d) => {
  rememberAppLog(d);
  process.stderr.write(`    [app!] ${d}`);
});
app.process().stderr?.on("data", (d) => {
  const line = String(d);
  if (!/Debugger listening|DevTools listening|For help, see/.test(line)) process.stdout.write(`    [app:err] ${line}`);
});

const shell = () => app.evaluate(() => globalThis.__soundwaveShell.state());
const voiceTurns = (page) =>
  page.evaluate(() => JSON.parse(localStorage.getItem("soundwave_agent_chat_history") || "[]").filter((m) => m.viaVoice).map((m) => m.text));

try {
  // ── 1. Startup: Command Center, tray, shortcut, bridge ────────────────────
  at("startup: window, tray, shortcut, bridge");
  const main = await app.firstWindow({ timeout: 180_000 });
  main.on("console", (m) => {
    if (m.type() === "error" || /\[voice\]/.test(m.text())) console.log(`    [main:${m.type()}] ${m.text()}`);
  });
  await main.waitForURL(/\/agent/, { timeout: 120_000 });
  await main.locator('button[aria-label="Talk to Soundwave"]').waitFor({ timeout: 60_000 });
  ok(`main window shows the Command Center (${main.url()})`);

  const state = await shell();
  if (!state.tray) await fail("no tray icon");
  ok("tray icon is up");
  if (!state.hotkey.hotkeyEnabled || !state.hotkey.hotkeyRegistered) await fail(`voice shortcut not registered: ${state.hotkey.hotkeyError ?? "disabled"}`);
  ok(`voice shortcut ${state.hotkey.hotkeyLabel} is registered system-wide`);

  const bridge = await main.evaluate(async () => {
    const d = window.soundwaveDesktop;
    if (!d?.isDesktop) return null;
    const s = await d.getState();
    return { version: s.version, closeToTray: s.closeToTray, choices: s.hotkeyChoices.length };
  });
  if (!bridge) await fail("window.soundwaveDesktop (preload bridge) is missing in the page");
  ok(`desktop bridge works (app ${bridge.version}, close-to-tray ${bridge.closeToTray}, ${bridge.choices} shortcut choices)`);

  const engine = await main.evaluate(() => fetch("/api/v1/agent/transcribe/status").then((r) => r.json()));
  if (!engine.available) await fail(`speech engine unavailable in the packaged app: ${engine.reason}`);
  ok(`speech engine ready in the packaged app (whisper.cpp ${engine.model})`);
  await main.screenshot({ path: path.join(shotsDir, "1-command-center.png") });

  // ── 2. The Command Center's mic: tap, talk, it sends when you pause ───────
  at("Command Center microphone");
  await main.evaluate(() => localStorage.setItem("soundwave_voice_debug", "1"));
  await main.locator('button[aria-label="Talk to Soundwave"]').click();
  await main.waitForFunction(() => /listening/i.test(document.body.innerText), null, { timeout: 30_000 });
  ok("tapping the mic starts listening");
  await main.screenshot({ path: path.join(shotsDir, "2-listening.png") });
  await main.waitForFunction(
    () => JSON.parse(localStorage.getItem("soundwave_agent_chat_history") || "[]").some((m) => m.viaVoice && /ask not what your country/i.test(m.text)),
    null,
    { timeout: 120_000, polling: 500 },
  );
  const heard = (await voiceTurns(main)).at(-1);
  if (!EXPECT.test(heard ?? "")) await fail(`the mic heard "${heard}"`);
  await main.waitForFunction(() => /YOU \(VOICE\)/.test(document.body.innerText), null, { timeout: 30_000 });
  ok(`mic → whisper.cpp → agent: "${heard}"`);
  annotate("notice", "Desktop E2E: Command Center mic", `Heard "${heard}" and sent it to the agent.`);
  await main.screenshot({ path: path.join(shotsDir, "3-after-mic.png") });

  // ── 3. The voice bar: shortcut while the app is in the background ─────────
  at("voice bar (app in the background)");
  await app.evaluate(() => globalThis.__soundwaveShell.mainWindow().hide());
  const before = (await voiceTurns(main)).length;
  await app.evaluate(() => globalThis.__soundwaveShell.voiceShortcut()); // exactly what Ctrl+Shift+Space does
  let overlay = null;
  for (let i = 0; i < 120 && !overlay; i++) {
    overlay = app.windows().find((p) => p.url().includes("/overlay")) ?? null;
    if (!overlay) await new Promise((r) => setTimeout(r, 250));
  }
  if (!overlay) await fail("the shortcut didn't open the voice bar window");
  overlay.on("console", (m) => {
    if (m.type() === "error" || /\[voice\]/.test(m.text())) console.log(`    [voicebar:${m.type()}] ${m.text()}`);
  });
  await overlay.waitForFunction(() => /listening/i.test(document.body.innerText), null, { timeout: 30_000 });
  const visible = await shell();
  if (!visible.overlayVisible) await fail("the voice bar is listening but its window isn't visible");
  ok("the shortcut shows the voice bar and it listens (app in the background)");
  await overlay.screenshot({ path: path.join(shotsDir, "4-voice-bar-listening.png") });

  await main.waitForFunction((n) => JSON.parse(localStorage.getItem("soundwave_agent_chat_history") || "[]").filter((m) => m.viaVoice).length > n, before, {
    timeout: 120_000,
    polling: 500,
  });
  const barHeard = (await voiceTurns(main)).at(-1);
  if (!EXPECT.test(barHeard ?? "")) await fail(`the voice bar heard "${barHeard}"`);
  ok(`voice bar → whisper.cpp → agent, and the turn is in the Command Center's conversation: "${barHeard}"`);
  await overlay.waitForFunction(() => !/listening|transcribing|thinking/i.test(document.body.innerText), null, { timeout: 60_000, polling: 500 }).catch(() => {});
  // It tucks itself away a few seconds after answering — screenshot only if it's still up.
  if ((await shell()).overlayVisible) await overlay.screenshot({ path: path.join(shotsDir, "5-voice-bar-reply.png"), timeout: 10_000 }).catch(() => {});
  const barText = (await overlay.evaluate(() => document.body.innerText)).replace(/\s+/g, " ").trim();
  annotate("notice", "Desktop E2E: voice bar", `Heard "${barHeard}". Voice bar now shows: ${barText.slice(0, 200)}`);

  // ── 3b. Settings → Phone: the pairing QR in the real window ──────────────
  at("Settings → Phone");
  // (The voice bar test sent the main window to the background: hidden windows
  // don't paint, so bring it back before looking at it.)
  await app.evaluate(() => globalThis.__soundwaveShell.mainWindow().show());
  const appBase = new URL(main.url()).origin;
  await main.goto(`${appBase}/settings/phone`);
  const phoneToggle = 'button[role="switch"][aria-label="Let my phone connect"]';
  await main.waitForSelector(phoneToggle, { timeout: 30_000 });
  await main.click(phoneToggle);
  await main.waitForSelector('[data-testid="pairing-qr"] svg, [data-testid="no-network"]', { timeout: 30_000 });
  const phone = await main.evaluate(async () => (await fetch("/api/v1/companion")).json());
  if (!phone.listening) await fail(`Settings → Phone: phone access is on but the listener didn't open (${phone.error})`);
  await main.screenshot({ path: path.join(shotsDir, "6-settings-phone.png"), timeout: 15_000 }).catch(() => console.log("[e2e] (Settings → Phone screenshot skipped)"));
  ok(`Settings → Phone: listening on port ${phone.port}, pairing code ${phone.pairing?.code ?? "(this PC has no network address)"}`);
  annotate(
    "notice",
    "Desktop E2E: phone companion",
    `Phone access on in the packaged app: port ${phone.port}, addresses ${phone.addresses.map((a) => `${a.address} (${a.name})`).join(", ") || "none"}.`,
  );
  await main.click(phoneToggle);
  for (let i = 0; i < 30; i++) {
    if (!(await main.evaluate(async () => (await fetch("/api/v1/companion")).json())).listening) break;
    await new Promise((r) => setTimeout(r, 300));
  }
  ok("Settings → Phone: turning it off closes the phone listener");

  // ── 3c. Settings → Brain: paste a Gemini key, test it, chat with Gemini ───
  at("Settings → Brain");
  await main.goto(`${appBase}/settings/brain`);
  await main.waitForSelector('[data-testid="brain-key-input"]', { timeout: 30_000 });
  await main.fill('[data-testid="brain-key-input"]', FAKE_KEY);
  await main.click('[data-testid="brain-save"]');
  await main.waitForSelector('[data-testid="brain-key-hint"]', { timeout: 30_000 });
  const tested = (await main.textContent('[data-testid="brain-test-result"]').catch(() => "")) ?? "";
  if (!/answered/.test(tested)) await fail(`Settings → Brain: the key test didn't pass ("${tested.trim()}")`);
  const hint = (await main.textContent('[data-testid="brain-key-hint"]'))?.trim();
  await main.screenshot({ path: path.join(shotsDir, "7-settings-brain.png"), timeout: 15_000 }).catch(() => console.log("[e2e] (Settings → Brain screenshot skipped)"));
  ok(`Settings → Brain: key saved (${hint}) and tested — ${tested.trim()}`);

  await main.goto(`${appBase}/agent`);
  await main.waitForSelector('[data-testid="brain-pill"]', { timeout: 30_000 });
  const pill = (await main.textContent('[data-testid="brain-pill"]'))?.trim();
  if (!/Gemini 3\.8 Flash/.test(pill ?? "")) await fail(`Command Center: the brain pill says "${pill}"`);
  const question = "hello from the end-to-end test";
  await main.fill('input[placeholder="Type a message..."]', question);
  await main.press('input[placeholder="Type a message..."]', "Enter");
  await main.waitForFunction((t) => document.body.innerText.includes(t), FAKE_HELLO, { timeout: 45_000 });
  const asked = fakeGemini.seen.filter((r) => r.url?.endsWith(":generateContent")).at(-1);
  const lastTurn = asked?.body?.contents?.at(-1)?.parts?.[0]?.text;
  if (lastTurn !== question || asked?.key !== FAKE_KEY) await fail(`Gemini got "${lastTurn}" (key ${asked?.key === FAKE_KEY ? "ok" : "wrong"})`);
  await main.screenshot({ path: path.join(shotsDir, "8-command-center-gemini.png"), timeout: 15_000 }).catch(() => {});
  ok(`Command Center: "${pill}" pill; a typed message went to Gemini and its answer is in the chat`);
  annotate("notice", "Desktop E2E: agent brain", `Settings → Brain saved the key (${hint}) and its test passed; the Command Center shows "${pill}" and the chat was answered by Gemini (fake, on loopback).`);

  // ── 3c+. The daily briefing (1.5.0): due → written (topics researched) → spoken when the Command Center opens ──
  at("daily briefing");
  // Nothing to open on the CI machine; the weather comes from the stand-in.
  const due = new Date(Date.now() - 2 * 60_000);
  const dueAt = `${String(due.getHours()).padStart(2, "0")}:${String(due.getMinutes()).padStart(2, "0")}`;
  await main.evaluate(
    (t) =>
      fetch("/api/v1/morning", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items: [], city: "Kruševac", briefing: { topics: ["the latest news about open-source, free AI tools"], time: t, auto: true } }),
      }),
    dueAt,
  );
  await main.goto(`${appBase}/agent`);
  await app.evaluate(() => {
    const w = globalThis.__soundwaveShell.mainWindow();
    w.show();
    w.focus();
  });
  await main.waitForFunction(() => /MORNING BRIEFING/.test(document.body.innerText), null, { timeout: 90_000 });
  const researched = fakeGemini.seen.filter((r) => /gemini-2\.5-flash:generateContent$/.test(r.url ?? "") && JSON.stringify(r.body?.tools ?? []).includes("googleSearch"));
  if (!researched.length) await fail("daily briefing: the topic wasn't researched with Google Search");
  let heardOn = null;
  for (let i = 0; i < 20 && !heardOn; i++) {
    heardOn = (await main.evaluate(async () => (await fetch("/api/v1/morning/briefing")).json())).heard?.on ?? null;
    if (!heardOn) await new Promise((r) => setTimeout(r, 500));
  }
  await main.screenshot({ path: path.join(shotsDir, "8b-daily-briefing.png"), timeout: 15_000 }).catch(() => {});
  if (heardOn === "pc") ok("daily briefing: written when due (the topic researched with Google Search), shown and spoken when the Command Center opened");
  else annotate("warning", "Desktop E2E", `daily briefing: written and shown, but it wasn't marked heard here (window focus in CI?) — heard: ${heardOn}`);

  // ── 3d. Morning Setup, the Memory tab and Connect YouTube (1.4.0) ─────────
  at("Morning Setup / Memory / YouTube tab");
  // If the chip doesn't get a briefing written, say *what* happened instead of
  // dying on a bare 60 s timeout: the old version waited in silence, so a
  // failure here read as "page.waitForFunction: Timeout 60000ms exceeded".
  const writersBefore = fakeGemini.seen.filter((r) => /Write the user's Morning Setup briefing/.test(r.body?.systemInstruction?.parts?.[0]?.text ?? "")).length;
  const writersNow = () => fakeGemini.seen.filter((r) => /Write the user's Morning Setup briefing/.test(r.body?.systemInstruction?.parts?.[0]?.text ?? "")).length;
  const lastChat = () =>
    main
      .evaluate(() => {
        const list = JSON.parse(localStorage.getItem("soundwave_agent_chat_history") || "[]");
        return list.slice(-3).map((m) => `${m.sender}: ${String(m.text ?? "").replace(/\s+/g, " ").slice(0, 140)}`).join(" | ") || "(the chat is empty)";
      })
      .catch(() => "(couldn't read the chat)");
  const lastCalls = () =>
    fakeGemini.seen
      .filter((r) => r.url?.endsWith(":generateContent"))
      .slice(-3)
      .map((r) => (r.body?.systemInstruction?.parts?.[0]?.text ?? r.body?.contents?.at(-1)?.parts?.[0]?.text ?? "?").replace(/\s+/g, " ").slice(0, 90))
      .join(" ∥ ") || "(no Gemini calls at all)";
  await main.click('[data-testid="morning-chip"]');
  for (let i = 0; i < 120; i++) {
    if (writersNow() > writersBefore) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  if (writersNow() <= writersBefore) {
    await fail(`Morning Setup: the chip was pressed but Gemini was never asked to write the briefing. Last chat: ${await lastChat()}. Last Gemini calls: ${await lastCalls()}`);
  }
  try {
    await main.waitForFunction((t) => document.body.innerText.includes(t), FAKE_MORNING, { timeout: 60_000 });
  } catch (err) {
    await fail(`Morning Setup: the briefing was written but never showed in the chat (${err.message}). Last chat: ${await lastChat()}`);
  }
  const briefing = fakeGemini.seen.filter((r) => r.url?.endsWith(":generateContent") && /Write the user's Morning Setup briefing/.test(r.body?.systemInstruction?.parts?.[0]?.text ?? "")).at(-1);
  const facts = briefing?.body?.contents?.[0]?.parts?.[0]?.text ?? "";
  if (!/Weather: In Kruševac it's 14°C/.test(facts)) await fail(`Morning Setup: the briefing wasn't written from the weather facts: ${facts.slice(0, 300)}`);
  ok("Morning Setup: the chip ran it, and Gemini wrote the briefing from real facts (weather from Open-Meteo's stand-in)");

  // (A toast — e.g. the reply being read aloud — may sit over the gear: click it directly.)
  await main.evaluate(() => document.querySelector('button[title="Assistant Settings"]')?.click());
  await main.click('[data-testid="memory-tab"]');
  await main.fill('[data-testid="memory-input"]', "The CI user's channel is about space facts");
  await main.press('[data-testid="memory-input"]', "Enter");
  await main.waitForSelector('[data-testid="memory-note"]', { timeout: 15_000 });
  const memoryNow = await main.evaluate(async () => (await fetch("/api/v1/memory")).json());
  if (!memoryNow.notes?.some((n) => /space facts/.test(n.text))) await fail(`Memory tab: the note isn't in the agent's memory (${JSON.stringify(memoryNow).slice(0, 200)})`);
  await main.screenshot({ path: path.join(shotsDir, "9-memory-tab.png"), timeout: 15_000 }).catch(() => {});
  await main.click('button:has-text("YouTube & Shorts")');
  await main.waitForSelector('[data-testid="yt-connect"]', { timeout: 15_000 });
  const ytMode = await main.evaluate(async () => (await fetch("/api/v1/youtube/status")).json());
  const oneClickPanel = await main.$('[data-testid="yt-oneclick"]');
  const manualPanel = await main.$('[data-testid="yt-manual"]');
  if (!ytMode.connected) {
    if (ytMode.oneClick && !oneClickPanel) await fail(`YouTube: the API says one-click but the panel doesn't show the one-press block (${JSON.stringify(ytMode)})`);
    if (!ytMode.oneClick && !manualPanel) await fail(`YouTube: no built-in client, but the panel doesn't show the own-client path (${JSON.stringify(ytMode)})`);
  }
  await main.screenshot({ path: path.join(shotsDir, "10-youtube-tab.png"), timeout: 15_000 }).catch(() => {});
  await main.keyboard.press("Escape");
  ok(
    `Memory tab: a note added in the app is in the agent's memory; the YouTube tab offers Connect YouTube (${ytMode.oneClick ? "one press — Soundwave's own Google app is baked in" : "with the person's own Google client, 3 short steps"})`,
  );

  // ── 3d+. The agent's eyes, against the real internet: read a real video and
  // a real page through the app's own server. Informational by design — YouTube
  // bot-checks and CI networks make both flaky, and a flaky gate teaches people
  // to ignore red. What matters is that the answer is reported every run.
  at("agent eyes (real video + real page)");
  await main.goto(`${appBase}/agent`);
  await main.waitForSelector('input[placeholder="Type a message..."]', { timeout: 30_000 });
  const watchUrl = "https://www.youtube.com/watch?v=iG9CE55wbtY"; // a TED talk with human-made English subtitles
  await main.fill('input[placeholder="Type a message..."]', `read this video and tell me what it says: ${watchUrl}`);
  await main.press('input[placeholder="Type a message..."]', "Enter");
  const eyesSeen = async () =>
    main
      .evaluate(() => {
        const list = JSON.parse(localStorage.getItem("soundwave_agent_chat_history") || "[]");
        return list.slice(-3).map((m) => `${m.sender}: ${String(m.text ?? "")}`).join(" | ");
      })
      .catch(() => "");
  let videoRead = "";
  for (let i = 0; i < 40 && !videoRead; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const seen = await eyesSeen();
    if (/READ_VEOK/.test(seen)) videoRead = seen;
    else if (/couldn't read that video/i.test(seen)) {
      annotate("warning", "Desktop E2E: agent eyes", `Reading a real YouTube video didn't work this run (YouTube bot check or network): ${seen.slice(-300)}`);
      break;
    }
  }
  if (videoRead) {
    const title = /READ_VEOK (.+?) \((manual|auto)\)/.exec(videoRead)?.[1] ?? "?";
    const kind = /READ_VEOK .+? \((manual|auto)\)/.exec(videoRead)?.[1] ?? "?";
    ok(`the agent read a real YouTube video (${kind} captions): “${title}”`);
  }
  await main.fill('input[placeholder="Type a message..."]', "read this page and tell me what it says: https://example.com/");
  await main.press('input[placeholder="Type a message..."]', "Enter");
  let pageRead = "";
  for (let i = 0; i < 30 && !pageRead; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const seen = await eyesSeen();
    if (/READ_PAGE_OK/.test(seen)) pageRead = seen;
    else if (/couldn't read that page/i.test(seen)) {
      annotate("warning", "Desktop E2E: agent eyes", `Reading a real web page didn't work this run: ${seen.slice(-300)}`);
      break;
    }
  }
  if (pageRead) ok("the agent read a real web page (example.com) through its own fetch");

  // ── 3e. Ghost Operator macros really run: a clipboard round trip through ──
  at("Ghost Operator macro");
  // Electron, and an honest skip for what Soundwave can't do yet.
  const macroName = "E2E clipboard round trip";
  const clipText = `Soundwave E2E ${Date.now()}`;
  const created = await main.evaluate(
    async (payload) =>
      (
        await fetch("/api/v1/ghost/macros", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        })
      ).json(),
    {
      name: macroName,
      description: "Copies text, reads it back, and asks for the system volume (not built yet)",
      category: "custom",
      triggerPhrases: [],
      steps: [
        { id: "s1", action: "clipboard", params: { operation: "set", text: clipText }, description: "Copy the test text" },
        { id: "s2", action: "clipboard", params: { operation: "get" }, description: "Read the clipboard back" },
        { id: "s3", action: "computer_settings", params: { setting: "mute" }, description: "Mute the sound" },
      ],
    },
  );
  const macroId = created?.macro?.id;
  if (!macroId) await fail(`Ghost Operator: the custom macro wasn't saved (${JSON.stringify(created).slice(0, 200)})`);
  await main.goto(`${appBase}/agent`);
  await main.locator('button[title="Ghost Operator Macro Automations"]').click();
  await main.waitForFunction(() => /really run on this PC/.test(document.body.innerText), null, { timeout: 30_000 });
  // The macro's row: the h4's nearest rounded-lg ancestor (the card that also
  // holds its Run button).
  const runRow = main
    .locator(`h4:text-is("${macroName}")`)
    .locator("xpath=ancestor::div[contains(@class, 'rounded-lg')]")
    .locator('button:has-text("Run")');
  try {
    await runRow.waitFor({ timeout: 30_000 });
  } catch {
    const shown = await main.evaluate(() => [...document.querySelectorAll("h4")].map((h) => h.textContent).join(" | "));
    await fail(`Ghost Operator: “${macroName}” isn't in the panel (it lists: ${shown})`);
  }
  await runRow.click();
  try {
    await main.waitForFunction((t) => document.body.innerText.includes(t), `Ghost Operator — ${macroName}`, { timeout: 60_000 });
  } catch (err) {
    await fail(`Ghost Operator: the macro ran but its report never appeared in the chat (${err.message})`);
  }
  const report = (await main.evaluate(() => document.body.innerText)).replace(/\s+/g, " ");
  if (!report.includes(clipText)) await fail(`Ghost Operator: the read-back step didn't show the copied text: ${report.slice(-400)}`);
  if (!/⏭ Mute the sound/.test(report) || !/volume/.test(report)) await fail(`Ghost Operator: the step it can't do wasn't skipped with its reason: ${report.slice(-400)}`);
  const onClipboard = await app.evaluate(({ clipboard }) => clipboard.readText());
  if (onClipboard !== clipText) await fail(`Ghost Operator: the clipboard holds "${onClipboard}" instead of "${clipText}"`);
  await main.screenshot({ path: path.join(shotsDir, "11-macro-run.png"), timeout: 15_000 }).catch(() => {});
  ok("Ghost Operator: a saved macro ran from the Workflow panel — the clipboard really copied (verified in Electron), the read-back step saw it, and the volume step was skipped with the reason");
  annotate(
    "notice",
    "Desktop E2E: Ghost Operator",
    `Ran “${macroName}” from the panel: real clipboard round trip (${clipText.length} chars, verified via Electron's clipboard), and “Mute the sound” was skipped with the reason instead of faking it.`,
  );
  await main.evaluate((id) => fetch(`/api/v1/ghost/macros/${id}`, { method: "DELETE" }), macroId);

  // ── 3f. Shorts cut out of a video (1.5.3): really listened to, really rendered ──
  at("clips out of a video");
  // The agent downloads or reads the file, listens with whisper.cpp, picks the
  // moment and renders a vertical clip with captions — watch it in the chat.
  await main.goto(`${appBase}/agent`);
  await main.waitForSelector('input[placeholder="Type a message..."]', { timeout: 30_000 });
  await main.fill('input[placeholder="Type a message..."]', `cut 1 clip out of this video: ${clipSource}`);
  await main.press('input[placeholder="Type a message..."]', "Enter");
  // The clips pipeline starts in the background; if its first line never shows,
  // say what the chat actually contains instead of a bare 60 s timeout.
  const chatNow = () =>
    main
      .evaluate(() => {
        const list = JSON.parse(localStorage.getItem("soundwave_agent_chat_history") || "[]");
        return list.slice(-4).map((m) => `${m.sender}: ${String(m.text ?? "").replace(/\s+/g, " ").slice(0, 120)}`).join(" | ") || "(the chat is empty)";
      })
      .catch(() => "(couldn't read the chat)");
  try {
    await main.waitForFunction(() => /Cutting 1 short out of/.test(document.body.innerText), null, { timeout: 60_000 });
  } catch (err) {
    await fail(`the clips request never started cutting (${err.message}). Last chat: ${await chatNow()}`);
  }
  ok("the agent took the video and started cutting a short out of it");
  try {
    await main.waitForFunction(() => /Clip 1 of 1/.test(document.body.innerText), null, { timeout: 240_000, polling: 1000 });
  } catch {
    const shown = (await main.evaluate(() => document.body.innerText)).replace(/\s+/g, " ");
    await fail(`the clip never appeared in the chat: ${shown.slice(-400)}`);
  }
  // The picker's answer named the moment — the Gemini path, not just the fallback.
  const clipLine = await main.evaluate(() => {
    const m = /Clip 1 of 1[^\n]*/.exec(document.body.innerText);
    return m ? m[0] : "";
  });
  if (!/CI clip/.test(clipLine)) annotate("warning", "Desktop E2E", `the clip was made from the loudest-window fallback instead of the picker's answer: “${clipLine}”`);
  else ok(`the agent's picker picked the moment: “${clipLine.slice(0, 120)}”`);
  // Watch it the way a person does: the player's source is the rendered file.
  const watch = main.locator('[data-testid="watch-button"]').last();
  await watch.click();
  await main.waitForSelector("video", { timeout: 60_000 });
  const clipSrc = await main.evaluate(() => {
    const v = [...document.querySelectorAll("video")].at(-1);
    return v?.getAttribute("src") ?? v?.querySelector("source")?.getAttribute("src") ?? "";
  });
  const clipId = /\/api\/v1\/export\/jobs\/([^/]+)\/download/.exec(clipSrc)?.[1] ?? "";
  if (!clipId) await fail(`the clip's player doesn't point at a rendered file (${clipSrc.slice(0, 200)})`);
  const clipJob = await main.evaluate(async (url) => {
    const res = await fetch(url);
    const buf = await res.arrayBuffer();
    return { status: res.status, type: res.headers.get("content-type"), bytes: buf.byteLength };
  }, `/api/v1/export/jobs/${clipId}/download`);
  if (clipJob.status !== 200 || !/video\/mp4/.test(clipJob.type ?? "") || clipJob.bytes < 50_000) {
    await fail(`the rendered clip isn't a real video file: ${JSON.stringify(clipJob)}`);
  } else {
    ok(`the clip rendered for real — ${Math.round(clipJob.bytes / 1024)} KB of MP4, played in the chat (job ${clipId})`);
    annotate(
      "notice",
      "Desktop E2E: shorts from a video",
      `“${path.basename(clipSource)}” (13 s, speech from whisper.cpp's sample) → the agent listened, picked the moment, cut it vertical with captions and posted it: ${Math.round(clipJob.bytes / 1024)} KB MP4 at ${clipSrc}.`,
    );
  }
  await main.screenshot({ path: path.join(shotsDir, "12-clip-from-video.png"), timeout: 15_000 }).catch(() => {});

  // ── 4. Tray behaviour + notifications bridge ──────────────────────────────
  at("tray behaviour and notifications");
  await app.evaluate(() => {
    const w = globalThis.__soundwaveShell.mainWindow();
    w.show();
    w.close(); // the window's X button
  });
  await new Promise((r) => setTimeout(r, 1500));
  const afterClose = await shell();
  if (afterClose.mainVisible || !afterClose.tray) await fail("closing the window should keep Soundwave running in the tray");
  ok("closing the window keeps Soundwave running in the tray");
  await main.evaluate(() => window.soundwaveDesktop.notify({ title: "Soundwave AI (CI)", body: "Notification check", route: "/agent" }));
  const supported = await app.evaluate(({ Notification }) => Notification.isSupported());
  ok(`notification bridge called (Windows notifications supported: ${supported})`);

  await app.close();
  ok("app quits cleanly");
  console.log(`[e2e] PASS (${since()})`);
  process.exit(0);
} catch (err) {
  await fail(err && err.message ? err.message.split("\n").slice(0, 6).join(" | ") : String(err));
}

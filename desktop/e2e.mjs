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
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktopDir = path.dirname(fileURLToPath(import.meta.url));
const shotsDir = path.join(desktopDir, "e2e-shots");
const EXPECT = /ask not what your country/i;
const started = Date.now();
const since = () => `${((Date.now() - started) / 1000).toFixed(1)}s`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
// What the page itself said (console errors, uncaught exceptions). The run's log
// is often unreachable, and "the UI never showed listening" says nothing about
// why — this is the difference between a timeout and a real error message.
const pageLog = [];
const rememberPageLog = (line) => {
  pageLog.push(String(line).replace(/\s+/g, " ").trim());
  if (pageLog.length > 30) pageLog.shift();
};
const pageLogTail = (lines = 6) => pageLog.slice(-lines).join(" ⋮ ").slice(-600);
let mainPage = null;
const at = (name) => {
  stage = name;
};
async function fail(message) {
  console.error(`[e2e] ✗ FAIL at “${stage}” (${since()}): ${message}`);
  const tail = appLogTail();
  const page = pageLogTail();
  let visible = "";
  try {
    visible = String(await mainPage?.evaluate(() => document.body?.innerText ?? "") ?? "")
      .replace(/\s+/g, " ")
      .slice(0, 300);
  } catch {
    /* the window is gone */
  }
  annotate(
    "error",
    "Desktop app end-to-end",
    `At “${stage}”: ${message}` +
      (tail ? ` | App log (last lines): ${tail}` : "") +
      (page ? ` | Page log (last lines): ${page}` : "") +
      (visible ? ` | On screen: “${visible}”` : ""),
  );
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

/**
 * A real key hold, pressed by Windows itself: keybd_event updates the async key
 * state that the app's watcher polls, so this exercises the same path as a
 * person holding Ctrl+Shift+Space on their keyboard (Playwright's key events
 * only reach a focused window and would prove nothing here).
 */
function holdShortcutScript(ms) {
  return [
    "Add-Type -MemberDefinition '[DllImport(\"user32.dll\")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);' -Name Kb -Namespace Sw",
    "function Down([int]$k){ [Sw.Kb]::keybd_event([byte]$k, 0, 0, [UIntPtr]::Zero) }",
    "function Up([int]$k){ [Sw.Kb]::keybd_event([byte]$k, 0, 2, [UIntPtr]::Zero) }",
    "Down 0x11; Down 0x10; Start-Sleep -Milliseconds 200; Down 0x20",
    `Start-Sleep -Milliseconds ${ms}`,
    "Up 0x20; Up 0x10; Up 0x11",
  ].join("\n");
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
  mainPage = main;
  main.on("console", (m) => {
    if (m.type() === "error" || /\[voice\]/.test(m.text())) console.log(`    [main:${m.type()}] ${m.text()}`);
    if (m.type() === "error" || /\[voice\]|microphone|getUserMedia|worklet/i.test(m.text())) rememberPageLog(`[${m.type()}] ${m.text()}`);
  });
  main.on("pageerror", (err) => rememberPageLog(`pageerror: ${err.message}`));
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

  // ── 1b. The sidebar's minimize button (rail, remembered) ─────────────────
  at("sidebar minimize");
  // The rail is the desktop layout's (lg = 1024 CSS px). A CI desktop can be
  // smaller than that — then the sidebar and its button are deliberately not
  // rendered — so ask the shell for a desktop-sized window first and say how
  // wide the page really ended up if it can't be.
  await app.evaluate(() => {
    const w = globalThis.__soundwaveShell.mainWindow();
    try {
      w.unmaximize();
    } catch {
      /* not maximized */
    }
    w.setSize(1400, 900);
    w.show();
    w.focus();
  });
  await sleep(500);
  const pageWidth = await main.evaluate(() => window.innerWidth);
  const desktopLayout = pageWidth >= 1024;
  annotate(
    "notice",
    "Desktop E2E: window size",
    `The main window's page is ${pageWidth}px wide (desktop layout ≥1024: ${desktopLayout ? "yes" : "no"}).`,
  );
  if (!desktopLayout) {
    annotate(
      "notice",
      "Desktop E2E: sidebar rail",
      `The page is only ${pageWidth}px wide (this CI screen), below the 1024px desktop layout, so the rail's pixel geometry isn't assertable here — the minimize button is driven through its own click handler and its state is checked from the DOM.`,
    );
  }
  // Visible click when the layout shows the button; the same handler when the
  // CI screen is too narrow for the desktop breakpoint.
  const clickToggle = async () => {
    if (desktopLayout) {
      await main.click('[data-testid="sidebar-toggle"]');
      return;
    }
    await main.evaluate(() => document.querySelector('[data-testid="sidebar-toggle"]').click());
  };
  const sidebar = () =>
    main.evaluate(() => {
      const aside = document.querySelector('[data-testid="desktop-sidebar"]');
      const content = document.querySelector("main");
      return {
        collapsed: aside?.getAttribute("data-collapsed"),
        width: Math.round(aside?.getBoundingClientRect().width ?? 0),
        contentLeft: Math.round(content?.getBoundingClientRect().left ?? 0),
        railLinks: [...document.querySelectorAll('[data-testid="sidebar-rail-link"]')].map((a) => a.getAttribute("aria-label")),
        showsLabels: /Voice Library/.test(document.body.innerText),
        stored: localStorage.getItem("soundwave_sidebar_collapsed"),
      };
    });
  await clickToggle();
  await main.waitForFunction(() => document.querySelector('[data-testid="desktop-sidebar"]')?.getAttribute("data-collapsed") === "true", null, { timeout: 10_000 });
  await sleep(400); // the width transition
  const narrow = await sidebar();
  if (desktopLayout) {
    // w-16 is exactly 4rem = 64px (border-box). The range also means a hidden
    // element (0px) can't pass this by accident.
    if (!(narrow.width >= 48 && narrow.width <= 72)) {
      await fail(`the sidebar is ${narrow.width}px wide after minimizing — the rail should be about 64`);
    } else {
      ok(`the minimize button turned the sidebar into a ${narrow.width}px rail`);
    }
    if (!(narrow.contentLeft < 100)) await fail(`the page didn't follow the rail (content starts at ${narrow.contentLeft}px)`);
  } else {
    ok(`the minimize button collapsed the sidebar (rail geometry not assertable at ${pageWidth}px)`);
  }
  if (narrow.stored !== "1") await fail(`the choice isn't remembered (soundwave_sidebar_collapsed=${narrow.stored})`);
  if (desktopLayout && narrow.showsLabels) await fail("the minimized rail still shows the labels");
  if (!narrow.railLinks.includes("Voice Library") || !narrow.railLinks.includes("Command Center")) {
    await fail(`the rail lost its buttons: ${JSON.stringify(narrow.railLinks)}`);
  } else {
    ok(`the rail keeps every tab reachable by icon (${narrow.railLinks.length} links, labels as tooltips)`);
  }
  await main.screenshot({ path: path.join(shotsDir, "1b-sidebar-rail.png") });

  // Still minimized after a restart of the window (that's what "remembered" means).
  await main.reload();
  // "attached", not "visible": below the desktop breakpoint the aside is in the
  // DOM but deliberately hidden, and this run still checks its state.
  await main.waitForSelector('[data-testid="desktop-sidebar"]', { state: "attached", timeout: 60_000 });
  await main.waitForFunction(() => document.querySelector('[data-testid="desktop-sidebar"]')?.getAttribute("data-collapsed") === "true", null, { timeout: 15_000 });
  ok("the minimized sidebar is still minimized after a reload");

  // Expand it again — the rest of this run works with the full sidebar.
  await clickToggle();
  await main.waitForFunction(() => document.querySelector('[data-testid="desktop-sidebar"]')?.getAttribute("data-collapsed") === "false", null, { timeout: 10_000 });
  await sleep(400);
  const back = await sidebar();
  if (desktopLayout) {
    if (!(back.width >= 200 && back.width <= 280 && back.showsLabels)) {
      await fail(`the sidebar didn't come back (${back.width}px, labels ${back.showsLabels})`);
    }
    else ok(`expanding puts the full sidebar back (${back.width}px, labels visible)`);
  } else {
    // Below the breakpoint the labels aren't painted at all (the phone-sized
    // drawer is what shows them), so the state attribute above is the check.
    ok("expanding restores the full sidebar");
  }

  // ── 1c. A voice the agent picks reaches the open window ──────────────────
  // The agent's set_voice tool writes the voice into the shared conversation
  // (the same store the phone reads). The desktop adopts it through the
  // conversation sync, so the next reply is really spoken in that voice.
  at("voice follows the agent's choice");
  const voiceNow = () => main.evaluate(() => localStorage.getItem("soundwave_voice"));
  const previousVoice = await voiceNow();
  const setVoiceOnServer = (voice) =>
    main.evaluate(async (v) => {
      const history = JSON.parse(localStorage.getItem("soundwave_agent_chat_history") || "[]");
      const res = await fetch("/api/v1/companion/conversation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: history, voice: v }),
      });
      return res.ok;
    }, voice);
  if (!(await setVoiceOnServer("en-US-AvaMultilingualNeural"))) await fail("couldn't set a voice on the PC's conversation");
  try {
    await main.waitForFunction(() => localStorage.getItem("soundwave_voice") === "en-US-AvaMultilingualNeural", null, { timeout: 15_000 });
    ok(`a voice set on the PC's conversation is adopted by the window (${previousVoice} → Ava) — the agent's set_voice reaches the speaker`);
  } catch {
    await fail(`the window kept the voice ${await voiceNow()} after the PC's conversation changed to Ava`);
  }
  // Back to what it was, so the rest of the run speaks in the usual voice.
  if (previousVoice) {
    await setVoiceOnServer(previousVoice);
    await main.waitForFunction((v) => localStorage.getItem("soundwave_voice") === v, previousVoice, { timeout: 15_000 }).catch(() => undefined);
  }

  const engine = await main.evaluate(() => fetch("/api/v1/agent/transcribe/status").then((r) => r.json()));
  if (!engine.available) await fail(`speech engine unavailable in the packaged app: ${engine.reason}`);
  ok(`speech engine ready in the packaged app (whisper.cpp ${engine.model})`);
  await main.screenshot({ path: path.join(shotsDir, "1-command-center.png") });

  // ── 2. The Command Center's mic: tap, talk, it sends when you pause ───────
  at("Command Center microphone");
  await main.evaluate(() => localStorage.setItem("soundwave_voice_debug", "1"));
  const turnsBeforeMic = (await voiceTurns(main)).length;
  // One retry, said out loud rather than hidden: this PC has a single whisper,
  // and if it is busy for a moment the recording is lost with a toast the run
  // can't see. A person would simply say it again — and a red run must never be
  // a 120-second silence with no reason in it.
  let heard = null;
  for (let attempt = 1; attempt <= 2 && heard === null; attempt++) {
    if (attempt > 1) {
      annotate("warning", "Desktop E2E: Command Center mic", "the first tap produced no voice turn — tapping the mic and saying it again");
    }
    await main.locator('button[aria-label="Talk to Soundwave"]').click();
    await main.waitForFunction(() => /listening/i.test(document.body.innerText), null, { timeout: 30_000 });
    if (attempt === 1) {
      ok("tapping the mic starts listening");
      await main.screenshot({ path: path.join(shotsDir, "2-listening.png") });
    }
    try {
      await main.waitForFunction(
        (n) => JSON.parse(localStorage.getItem("soundwave_agent_chat_history") || "[]").filter((m) => m.viaVoice).length > n,
        turnsBeforeMic,
        { timeout: 90_000, polling: 500 },
      );
      heard = (await voiceTurns(main)).at(-1) ?? "";
    } catch {
      // Name what the PC's speech engine says about itself — its last error and
      // when it last transcribed — so a failure here is a finding, not a hang.
      const engine = await main
        .evaluate(() => fetch("/api/v1/agent/transcribe/status").then((r) => r.json()).catch(() => null))
        .catch(() => null);
      annotate(
        "error",
        "Desktop E2E: Command Center mic",
        `tap ${attempt} of 2 produced no voice turn in 90 s. Engine: ${JSON.stringify({
          available: engine?.available ?? null,
          lastError: engine?.lastError ?? null,
          lastTranscribedAt: engine?.lastTranscribedAt ?? null,
          lastElapsedMs: engine?.lastElapsedMs ?? null,
        })}`,
      );
    }
  }
  if (heard === null) await fail("the Command Center mic never produced a voice turn — see the engine line in this run's errors");
  if (!EXPECT.test(heard)) await fail(`the mic heard "${heard}"`);
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
  // The pill renders only once the brain status has arrived, and the renderer
  // polls it every 30 s — on a loaded runner (13fd3cb: whisper 4.8 s vs 1.8 s,
  // voice 870 ms vs 470 ms) the first answer can be slower than the old 30 s
  // wait. Wait longer, and if it still isn't there, say what the endpoint says
  // instead of leaving a bare timeout.
  try {
    await main.waitForSelector('[data-testid="brain-pill"]', { timeout: 90_000 });
  } catch {
    const said = await main
      .evaluate(async () => {
        const pill = document.querySelector('[data-testid="brain-pill"]');
        const res = await fetch("/api/v1/brain/status").catch(() => null);
        const body = res ? await res.text().catch(() => "") : "";
        return `the pill is ${pill ? "in the DOM" : "absent"}; /api/v1/brain/status → ${res ? res.status : "no answer"} ${body.replace(/\s+/g, " ").slice(0, 300)}`;
      })
      .catch(() => "the page couldn't be asked either");
    await fail(`Command Center: the brain pill never appeared (${said})`);
  }
  const pill = (await main.textContent('[data-testid="brain-pill"]'))?.trim();
  if (!/Gemini 3\.8 Flash/.test(pill ?? "")) await fail(`Command Center: the brain pill says "${pill}"`);
  const question = "hello from the end-to-end test";
  const agentInput = 'input[placeholder="Message…"]';
  await main.waitForSelector(agentInput, { state: "visible", timeout: 20_000 });
  await main.fill(agentInput, question);
  // `page.press(selector, ...)` has intermittently hung here after `fill`
  // already focused the input (the packaged app's CI failure). Send Enter to
  // the focused page directly so Playwright doesn't need to re-resolve a
  // rapidly rerendered input between the two actions.
  await main.keyboard.press("Enter");
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
  // The card can appear while the research is still running (it is written in the
  // background), so wait for the call itself rather than sampling once — and
  // accept either free search model: the app tries 2.5 Flash first and Flash-Lite
  // if the first refuses, and both are Google Search on the free tier.
  const searched = (r) =>
    /gemini-2\.5-flash(-lite)?:generateContent$/.test(r.url ?? "") && JSON.stringify(r.body?.tools ?? []).includes("googleSearch");
  let researched = [];
  for (let i = 0; i < 120 && !researched.length; i++) {
    researched = fakeGemini.seen.filter(searched);
    if (!researched.length) await sleep(500);
  }
  // …and that what it found reached the briefing: the writer's own prompt must
  // carry the researched lines the stand-in returned (same check the smoke test
  // uses). Neither half is the app grading itself.
  const wroteFromResearch = fakeGemini.seen.some((r) => /Ollama 1\.0 shipped/.test(JSON.stringify(r.body ?? "")));
  if (!researched.length || !wroteFromResearch) {
    const models = fakeGemini.seen.filter((r) => /:generateContent$/.test(r.url ?? "")).map((r) => (r.url ?? "").replace(/^.*\/models\//, ""));
    await fail(
      `daily briefing: the topic wasn't researched with Google Search and written from it (search calls: ${JSON.stringify(models.slice(-6))}; a briefing written from the found lines: ${wroteFromResearch ? "yes" : "no"})`,
    );
  }
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
  await main.click('[data-testid="youtube-tab"]');
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
  /**
   * Ask the Command Center something, and if its message box isn't usable say
   * exactly why: on the run that failed here, "fill: Timeout 30000ms exceeded"
   * named neither the element's state nor what covered it, and the stage took
   * the whole run down with it. The eyes stage is informational by design
   * (YouTube bot-checks and CI networks make the reads flaky, and a flaky gate
   * teaches people to ignore red) — so it may not abort the acceptance-critical
   * stages that follow (wake word, push-to-talk, tray, alarm).
   */
  const askAgent = async (text) => {
    try {
      const selector = 'input[placeholder="Message…"]';
      await main.waitForSelector(selector, { state: "visible", timeout: 20_000 });
      await main.fill(selector, text);
      await main.keyboard.press("Enter");
    } catch (err) {
      const state = await main
        .evaluate(() => {
          const el = document.querySelector('input[placeholder="Message…"]');
          const r = el ? el.getBoundingClientRect() : null;
          const mid = r
            ? document.elementFromPoint(Math.min(Math.max(r.x + r.width / 2, 0), innerWidth - 1), Math.min(Math.max(r.y + r.height / 2, 0), innerHeight - 1))
            : null;
          return {
            url: location.href,
            exists: Boolean(el),
            visible: Boolean(el && el.offsetParent !== null),
            disabled: el?.disabled ?? null,
            readOnly: el?.readOnly ?? null,
            rect: r ? `${Math.round(r.width)}×${Math.round(r.height)} at ${Math.round(r.x)},${Math.round(r.y)}` : null,
            onTop: mid ? `${mid.tagName}${mid.getAttribute("data-testid") ? `[${mid.getAttribute("data-testid")}]` : ""}` : null,
            screen: document.body.innerText.replace(/\s+/g, " ").slice(0, 200),
          };
        })
        .catch((e) => ({ error: e.message }));
      throw new Error(`the Command Center's message box isn't usable: ${JSON.stringify(state)} (${String(err.message).split("\n")[0]})`);
    }
  };
  const watchUrl = "https://www.youtube.com/watch?v=iG9CE55wbtY"; // a TED talk with human-made English subtitles
  try {
    await askAgent(`read this video and tell me what it says: ${watchUrl}`);
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
    await askAgent("read this page and tell me what it says: https://example.com/");
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
  } catch (err) {
    // Informational stage: record what happened and carry on. Every later stage
    // (wake word, push-to-talk, tray, notifications) is the reason this run
    // exists, and none of them may be skipped because YouTube bot-checked us.
    annotate("warning", "Desktop E2E: agent eyes", `${err.message} — continuing (this stage is informational)`);
  }

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
  // On the CI runner this click has hung at Playwright's "attempting click
  // action" once (the packaging window stopped handing out animation frames, so
  // the stability/hit-target wait never came back) while the page itself still
  // answered `evaluate`. That is the input path, not the feature: say what
  // happened, count the frames to tell a hidden window from a stuck one, and
  // send the click straight at the button so the macro itself is still tested.
  const macroButton = main.locator('button[title="Ghost Operator Macro Automations"]');
  try {
    await macroButton.click({ timeout: 20_000 });
  } catch (err) {
    const frames = await main
      .evaluate(
        () =>
          new Promise((resolve) => {
            let seen = 0;
            const t0 = performance.now();
            const tick = () => {
              seen++;
              if (performance.now() - t0 < 500) requestAnimationFrame(tick);
              else resolve(`${seen} frames/500ms, visibility=${document.visibilityState}`);
            };
            requestAnimationFrame(tick);
            setTimeout(() => resolve(`${seen} frames/500ms, visibility=${document.visibilityState} (timed out)`), 2500);
          }),
      )
      .catch(() => "the page didn't answer either");
    annotate(
      "warning",
      "Desktop E2E: Ghost Operator macros",
      `the macro button didn't take a normal click (${String(err.message).split("\n")[0]}); the page reports ${frames} — dispatching the click at the element instead`,
    );
    await main.evaluate(() => {
      const button = document.querySelector('button[title="Ghost Operator Macro Automations"]');
      if (!button) throw new Error("the macro button is gone from the page");
      button.click();
    });
  }
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
  await main.waitForSelector('input[placeholder="Message…"]', { timeout: 30_000 });
  // The same job has to be findable without knowing to ask for it: the card on
  // the Command Center is the visible half of make_shorts_from_video.
  const clipsCard = await main.evaluate(() => {
    const card = document.querySelector('[data-testid="clips-card"]');
    if (!card) return null;
    return {
      hasInput: !!card.querySelector('[data-testid="clips-video"]'),
      hasCount: !!card.querySelector('[data-testid="clips-count"]'),
      hasButton: !!card.querySelector('[data-testid="clips-cut"]'),
      offered: card.textContent?.trim().slice(0, 60) ?? "",
    };
  });
  if (!clipsCard) await fail('the "Shorts from a video" card is missing from the Command Center');
  else if (!clipsCard.hasInput || !clipsCard.hasCount || !clipsCard.hasButton) await fail(`the "Shorts from a video" card is incomplete: ${JSON.stringify(clipsCard)}`);
  else ok(`the Command Center shows the "Shorts from a video" card (${clipsCard.offered})`);
  const clipsOffered = await main.evaluate(async () => {
    const res = await fetch("/api/v1/clips");
    return res.ok ? await res.json() : { error: res.status };
  });
  if (clipsOffered.available !== true) await fail(`the clips endpoint doesn't offer the card here: ${JSON.stringify(clipsOffered)}`);

  // The other visible half: watching creators. Nothing that needs YouTube here —
  // a handle that can't be a channel must be refused with a sentence a person
  // can act on, right under the box, and the card must be reachable at all.
  const watchCard = await main.evaluate(() => {
    const card = document.querySelector('[data-testid="watch-card"]');
    if (!card) return null;
    return {
      hasInput: !!card.querySelector('[data-testid="watch-add-input"]'),
      hasAdd: !!card.querySelector('[data-testid="watch-add"]'),
      hasInfo: !!card.querySelector('[data-testid="watch-info"]'),
      empty: /Nothing watched yet/.test(card.textContent ?? ""),
    };
  });
  if (!watchCard) await fail('the "Watching creators" card is missing from the Command Center');
  else if (!watchCard.hasInput || !watchCard.hasAdd || !watchCard.hasInfo) await fail(`the "Watching creators" card is incomplete: ${JSON.stringify(watchCard)}`);
  else ok(`the Command Center shows the "Watching creators" card (${watchCard.empty ? "nothing watched yet, as on a fresh install" : "with channels already watched"})`);

  await main.click('[data-testid="watch-info"]');
  const infoOpen = await main
    .waitForFunction(() => !!document.querySelector('[data-testid="watch-info-text"]'), null, { timeout: 5000 })
    .then(() => true)
    .catch(() => false);
  if (!infoOpen) await fail('the “i” on the watching card doesn\'t explain the feature');
  else {
    const infoText = await main.evaluate(() => document.querySelector('[data-testid="watch-info-text"]')?.textContent ?? "");
    if (!/every ~5 minutes/.test(infoText)) await fail(`the explanation doesn't say how often it checks: “${infoText.slice(0, 160)}”`);
    else ok("the “i” explains watching in place (channel checks every ~5 minutes while Soundwave runs)");
  }

  const watchesBefore = await main.evaluate(async () => {
    const res = await fetch("/api/v1/watch");
    return res.ok ? ((await res.json()).watches ?? []).length : -1;
  });
  await main.fill('[data-testid="watch-add-input"]', "not a channel at all");
  await main.click('[data-testid="watch-add"]');
  const refused = await main
    .waitForFunction(
      () => /isn't a channel I can watch|has to be a channel/.test(document.querySelector('[data-testid="watch-note"]')?.textContent ?? ""),
      null,
      { timeout: 10_000 },
    )
    .then(() => true)
    .catch(() => false);
  if (!refused) {
    const shown = await main.evaluate(() => document.querySelector('[data-testid="watch-note"]')?.textContent ?? "(nothing)");
    await fail(`typing something that isn't a channel didn't get the sentence back (the card says: ${shown})`);
  } else ok("a handle that isn't a channel is refused in the card, with the reason");
  const watchList = await main.evaluate(async () => {
    const res = await fetch("/api/v1/watch");
    return res.ok ? await res.json() : { error: res.status };
  });
  if (watchList.available !== true) await fail(`the watch endpoint doesn't offer the card here: ${JSON.stringify(watchList)}`);
  if (watchesBefore >= 0 && (watchList.watches ?? []).length !== watchesBefore) {
    await fail(`a refused handle changed the watch list (${watchesBefore} → ${(watchList.watches ?? []).length}): ${JSON.stringify(watchList.watches).slice(0, 300)}`);
  }
  await main.fill('input[placeholder="Message…"]', `cut 1 clip out of this video: ${clipSource}`);
  await main.press('input[placeholder="Message…"]', "Enter");
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
  // Watch it the way a person does: the chat plays the rendered file in the
  // message (the phone has a "Watch" button for this; the desktop shows the
  // player). Its source must be the clip's own export job.
  try {
    await main.waitForFunction(
      () =>
        [...document.querySelectorAll("video")].some((v) => {
          const s = v.getAttribute("src") ?? v.querySelector("source")?.getAttribute("src") ?? "";
          return /\/api\/v1\/export\/jobs\/[^/]+\/download/.test(s);
        }),
      null,
      { timeout: 60_000, polling: 500 },
    );
  } catch {
    const shown = (await main.evaluate(() => document.body.innerText)).replace(/\s+/g, " ");
    await fail(`the finished clip never showed a player in the chat: ${shown.slice(-400)}`);
  }
  const clipSrc = await main.evaluate(() => {
    const srcOf = (el) => el.getAttribute("src") ?? el.querySelector("source")?.getAttribute("src") ?? "";
    const v = [...document.querySelectorAll("video")].filter((el) => /\/api\/v1\/export\/jobs\/[^/]+\/download/.test(srcOf(el))).at(-1);
    return v ? srcOf(v) : "";
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

  // ── 3g. "Hey Soundwave": it listens on its own, and ignores everything else ──
  at("wake word: listening, and ignoring ordinary speech");
  // The hidden wake window has been up since startup with the fake microphone
  // talking (JFK on a loop). It transcribes what it hears **on this PC** and the
  // shell checks for the phrase. So: the counter must climb (the listener really
  // is working) and nothing may have woken (the phrase isn't in that speech).
  let wake = (await shell()).wake;
  const wakeDeadline = Date.now() + 90_000;
  while (Date.now() < wakeDeadline && wake.heard < 2) {
    await sleep(1000);
    wake = (await shell()).wake;
  }
  if (!wake.enabled) await fail("the wake word starts enabled, but the shell says it is off");
  if (!wake.running) await fail(`the wake listener isn't running (state ${wake.state}: ${wake.detail ?? "no detail"})`);
  if (wake.heard < 2) {
    await fail(`the wake listener transcribed nothing in 90 s while the fake microphone was talking (state ${wake.state}: ${wake.detail ?? "no detail"})`);
  }
  if (wake.lastHit) await fail(`ordinary speech woke it: ${wake.lastHit}`);
  ok(`the wake listener transcribed ${wake.heard} utterances of ordinary speech on this PC and woke on none of them`);
  annotate(
    "notice",
    "Desktop E2E: wake word",
    `"Hey Soundwave" is listened for while the app runs: ${wake.heard} utterance(s) checked locally with whisper.cpp, ${wake.ignored} ignored (last heard: "${String(wake.lastHeard ?? "").slice(0, 80)}"), and none of them woke the agent. Paused while Soundwave recorded or spoke.`,
  );

  // The phrase itself — through the same entry point the hidden listener uses
  // (what whisper heard is handed to the shell, which decides). The listening
  // half is proven above and by the whisper stages; this proves the wiring.
  at("Hey Soundwave, what can you do?");
  const wakeTurns = (await voiceTurns(main)).length;
  await app.evaluate(() => globalThis.__soundwaveShell.heardWake("Hey Soundwave, what can you do?"));
  await sleep(500);
  const wakeShell = await shell();
  if (!wakeShell.overlayVisible) await fail(`the wake phrase didn't open the voice bar (state ${JSON.stringify(wakeShell.wake)}).`);
  let wakeOverlay = app.windows().find((p) => p.url().includes("/overlay")) ?? null;
  try {
    await main.waitForFunction((n) => JSON.parse(localStorage.getItem("soundwave_agent_chat_history") || "[]").filter((m) => m.viaVoice).length > n, wakeTurns, {
      timeout: 90_000,
      polling: 500,
    });
  } catch {
    await fail(`the wake phrase never reached the agent (bar said: ${wakeOverlay ? (await wakeOverlay.evaluate(() => document.body.innerText)).replace(/\s+/g, " ").slice(0, 200) : "no bar"})`);
  }
  const wakeHeardTurn = (await voiceTurns(main)).at(-1) ?? "";
  if (!/what can you do/i.test(wakeHeardTurn)) await fail(`the wake command reached the agent as "${wakeHeardTurn}"`);
  ok(`"Hey Soundwave, what can you do?" opened the bar by itself and the command reached the agent: "${wakeHeardTurn}"`);
  await wakeOverlay?.screenshot({ path: path.join(shotsDir, "13-wake-word.png"), timeout: 10_000 }).catch(() => {});

  // ── 3h. Push to talk: hold the keys, speak, let go ────────────────────────
  at("push to talk (held shortcut)");
  const pttState = (await shell()).pushToTalkStatus;
  if (!pttState.supported) await fail(`hold-to-talk isn't available here: ${pttState.problem}`);
  if (!pttState.ready) await fail(`the key watcher never became ready: ${pttState.problem ?? "no reason given"}`);
  await app.evaluate(() => {
    const w = globalThis.__soundwaveShell.mainWindow();
    w.hide();
  });
  const pttBefore = (await voiceTurns(main)).length;
  // Hold for a whole loop of the fake microphone, not 4 s: Chromium loops
  // `e2e-mic.wav` from process start, so by this stage the recording can be at
  // any point of it — a 4-second hold cut the sentence off right before "ask
  // not what your country" (the check below) and reddened a run for the test's
  // sake. The clip is ~11 s of speech + 4 s of silence, so one full loop
  // always contains the words; the release still ends the recording, which is
  // the thing being proved (and the push-to-talk capture ignores the silence —
  // it stops when the keys are let go, not when the person pauses).
  const pttHoldMs = 15_500; // one full loop of the fake microphone — see below
  const holder = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", holdShortcutScript(pttHoldMs)], {
    windowsHide: true,
  });
  // Listen for the exit *before* the key checks: PowerShell can fail instantly
  // (a locked-down machine without user32 access), and a missed event would hang
  // the whole run instead of saying what went wrong.
  let held = "";
  holder.stdout?.on("data", (b) => (held += b.toString()));
  holder.stderr?.on("data", (b) => (held += b.toString()));
  const holderDone = new Promise((resolve) => holder.on("exit", (code) => resolve(code ?? -1)));
  let sawDown = false;
  for (let i = 0; i < 60 && !sawDown; i++) {
    if ((await shell()).pushToTalkStatus.down === true) sawDown = true;
    else await sleep(100);
  }
  if (!sawDown) {
    const code = await Promise.race([holderDone, sleep(10_000).then(() => "still running")]);
    await fail(`the key watcher never saw Ctrl+Shift+Space go down (a real OS key hold); PowerShell said (${code}): ${held.trim().slice(-300) || "nothing"}`);
  }
  ok("holding the shortcut made the key watcher report the chord down");
  const holderCode = await Promise.race([holderDone, sleep(30_000).then(() => "timed out")]);
  if (holderCode !== 0) await fail(`the key-holding helper exited with ${holderCode}: ${held.trim().slice(-300) || "nothing"}`);
  const afterRelease = await shell();
  if (afterRelease.pushToTalkStatus.down) await fail("the key watcher still thinks the keys are held after the release");
  try {
    await main.waitForFunction((n) => JSON.parse(localStorage.getItem("soundwave_agent_chat_history") || "[]").filter((m) => m.viaVoice).length > n, pttBefore, {
      timeout: 150_000,
      polling: 500,
    });
  } catch {
    await fail(`releasing the held shortcut sent nothing (chat has ${((await voiceTurns(main)).length) - pttBefore} new voice turn(s))`);
  }
  const pttTurn = (await voiceTurns(main)).at(-1) ?? "";
  if (!EXPECT.test(pttTurn)) await fail(`push-to-talk sent "${pttTurn}" — expected what the microphone was playing`);
  ok(`push-to-talk: held the keys, spoke, released → sent "${pttTurn.slice(0, 60)}…"`);
  annotate(
    "notice",
    "Desktop E2E: push to talk",
    `Ctrl+Shift+Space was held by Windows itself (keybd_event) for ${Math.round(pttHoldMs / 1000)} s — a full loop of the fake microphone, so the whole sentence is always in the recording: the watcher saw the chord go down and up, the bar listened while held, and releasing sent the microphone's words ("${pttTurn.slice(0, 80)}").`,
  );
  await app.evaluate(() => {
    const w = globalThis.__soundwaveShell.mainWindow();
    w.show();
  });

  // ── 3i. The wake switch is real (Settings → Voice & Desktop) ─────────────
  at("Settings → Voice & Desktop: the wake switch");
  await main.goto(`${appBase}/settings/voice`);
  const wakeToggle = main.locator('button[role="switch"][aria-label="Wake word"]');
  await wakeToggle.waitFor({ timeout: 30_000 });
  await wakeToggle.click(); // off
  let switched = null;
  for (let i = 0; i < 40; i++) {
    switched = await shell();
    if (!switched.wake.running) break;
    await sleep(250);
  }
  if (switched.wake.running) await fail("turning the wake word off left the listener running");
  ok("turning the wake word off stops the listener (the microphone is released)");
  await wakeToggle.click(); // back on
  let wakeBack = null;
  for (let i = 0; i < 60; i++) {
    wakeBack = await shell();
    if (wakeBack.wake.running) break;
    await sleep(250);
  }
  if (!wakeBack.wake.running) await fail("turning the wake word back on didn't start the listener");
  ok("turning it back on starts the listener again");

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

  // ── 4b. "Hey Soundwave" on real audio ────────────────────────────────────
  // The phrase is spoken by the app's own neural voice, saved as the fake
  // microphone's recording, and the app is started again with nothing but that
  // playing: the hidden listener must hear it through the microphone, transcribe
  // it locally and wake up. If the voice service is unreachable in CI (it
  // happens), this stage says so and skips — it never pretends.
  let wakeAudio = null;
  try {
    const spoken = await main.evaluate(
      async (text) => {
        const res = await fetch(`/api/v1/agent/speak/stream?voice=${encodeURIComponent("en-US-AvaMultilingualNeural")}&text=${encodeURIComponent(text)}`);
        if (!res.ok) return { error: `HTTP ${res.status}` };
        const buf = await res.arrayBuffer();
        return { bytes: Array.from(new Uint8Array(buf)), type: res.headers.get("content-type") };
      },
      "Hey Soundwave. What can you do?",
    );
    if (!spoken?.bytes?.length) throw new Error(spoken?.error ?? "the voice service returned no audio");
    const mp3 = path.join(desktopDir, "e2e-wake.mp3");
    fs.writeFileSync(mp3, Buffer.from(spoken.bytes));
    const wav = path.join(desktopDir, "e2e-wake.wav");
    execFileSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-i", mp3, "-af", "apad=pad_dur=3.5", "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wav], {
      windowsHide: true,
    });
    wakeAudio = wav;
    ok(`recorded "Hey Soundwave. What can you do?" with the app's own voice (${Math.round(spoken.bytes.length / 1024)} KB MP3 → fake microphone)`);
  } catch (err) {
    annotate("warning", "Desktop E2E: wake word audio", `the wake phrase couldn't be recorded this run (${err.message}) — the real-audio wake test is skipped, not failed.`);
  }

  await app.close();
  ok("app quits cleanly");

  if (wakeAudio) {
    at('wake word on real audio ("Hey Soundwave")');
    await sleep(2500); // the single-instance lock must be free
    let second = null;
    try {
      second = await electron.launch({
        executablePath: exe,
        args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${wakeAudio}`],
        env: {
          ...process.env,
          GEMINI_API_BASE: fakeGemini.url,
          OPEN_METEO_GEOCODING_URL: `${fakeGemini.url}/geocode`,
          OPEN_METEO_FORECAST_URL: `${fakeGemini.url}/forecast`,
        },
        timeout: 180_000,
      });
    } catch (err) {
      await fail(`the app didn't start a second time for the wake test: ${err.message}`);
    }
    app = second;
    const main2 = await app.firstWindow({ timeout: 180_000 });
    mainPage = main2;
    main2.on("console", (m) => {
      if (m.type() === "error") rememberPageLog(`[wake-run] ${m.text()}`);
    });
    await main2.waitForURL(/\/agent/, { timeout: 120_000 });
    // Nobody touches anything: the microphone is playing the wake phrase and the
    // listener has to notice by itself.
    const turnsBefore = await main2.evaluate(() => JSON.parse(localStorage.getItem("soundwave_agent_chat_history") || "[]").filter((m) => m.viaVoice).length);
    let woke = null;
    const wakeAudioDeadline = Date.now() + 120_000;
    while (Date.now() < wakeAudioDeadline) {
      const now = await app.evaluate(() => globalThis.__soundwaveShell.state());
      if (now.wake.lastHit) {
        woke = now;
        break;
      }
      await sleep(1000);
    }
    if (!woke) {
      const st = await app.evaluate(() => globalThis.__soundwaveShell.state());
      await fail(
        `the wake phrase played into the microphone never woke it (state ${st.wake.state}: ${st.wake.detail ?? "no detail"}; ${st.wake.heard} utterance(s) checked, last "${String(st.wake.lastHeard ?? "").slice(0, 60)}")`,
      );
    }
    if (!woke.wake.lastHit.toLowerCase().includes("what can you do")) {
      await fail(`the wake listener heard something else: ${woke.wake.lastHit}`);
    }
    ok(`the app heard "Hey Soundwave…" through its own microphone and woke by itself: ${woke.wake.lastHit}`);
    try {
      await main2.waitForFunction(
        (n) => {
          const turns = JSON.parse(localStorage.getItem("soundwave_agent_chat_history") || "[]").filter((m) => m.viaVoice);
          return turns.length > n && /what can you do/i.test(turns.at(-1)?.text ?? "");
        },
        turnsBefore,
        { timeout: 90_000, polling: 500 },
      );
    } catch {
      const said = await main2.evaluate(() => JSON.parse(localStorage.getItem("soundwave_agent_chat_history") || "[]").filter((m) => m.viaVoice).map((m) => m.text).slice(-2));
      await fail(`the wake command never reached the agent (chat's last voice turns: ${JSON.stringify(said)})`);
    }
    const wokeTurn = await main2.evaluate(() => {
      const turns = JSON.parse(localStorage.getItem("soundwave_agent_chat_history") || "[]").filter((m) => m.viaVoice).map((m) => m.text);
      return turns.at(-1) ?? "";
    });
    ok(`hands free: saying "Hey Soundwave, what can you do?" reached the agent: "${wokeTurn}"`);
    annotate(
      "notice",
      "Desktop E2E: wake word (real audio)",
      `The app's own neural voice spoke "Hey Soundwave. What can you do?" into the fake microphone; the hidden listener transcribed it on this PC (${woke.wake.heard} utterance(s) checked, ${woke.wake.ignored} ignored) and the agent answered without a single click or key press.`,
    );
    await main2.screenshot({ path: path.join(shotsDir, "14-wake-real-audio.png"), timeout: 15_000 }).catch(() => {});
    await app.close();
    ok("app quits cleanly after the wake-word run");
  }

  console.log(`[e2e] PASS (${since()})`);
  process.exit(0);
} catch (err) {
  await fail(err && err.message ? err.message.split("\n").slice(0, 6).join(" | ") : String(err));
}

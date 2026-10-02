// End-to-end test of the phone app on a real Android emulator (CI).
// The PC side is the real Soundwave server running on the CI machine with the
// phone companion on; the emulator reaches it at 10.0.2.2. Its "Gemini" is the
// stand-in from desktop/test/fake-gemini.mjs (GEMINI_API_BASE). Playwright
// attaches to the app's WebView (debug build) and drives it like a person would.
//
//   COMPANION_APK=…/app-debug.apk  PC_URL=http://127.0.0.1:4000  FAKE_GEMINI_URL=http://127.0.0.1:4100  node mobile/e2e/android-e2e.mjs
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { _android as android } from "playwright-core";
import { FAKE_HELLO, FAKE_KEY, FAKE_MORNING, FAKE_PHONE, FAKE_RESEARCH } from "../../desktop/test/fake-gemini.mjs";

const PKG = "ai.soundwave.companion";
const PC = process.env.PC_URL || "http://127.0.0.1:4000";
const GEMINI = process.env.FAKE_GEMINI_URL || "http://127.0.0.1:4100";
const APK = process.env.COMPANION_APK;
const SHOTS = path.resolve(process.env.SHOTS_DIR || "mobile/e2e-shots");
const ADB = process.env.ANDROID_HOME ? path.join(process.env.ANDROID_HOME, "platform-tools", "adb") : "adb";
fs.mkdirSync(SHOTS, { recursive: true });

const clean = (s) => String(s).replace(/\r?\n/g, " ").slice(0, 900);
const annotate = (level, title, message) => console.log(`::${level} title=${title}::${clean(message)}`);
const ok = (m) => {
  console.log(`✓ ${m}`);
  annotate("notice", "Phone app E2E", m);
};
let failed = false;
const fail = (m) => {
  failed = true;
  console.log(`✗ ${m}`);
  annotate("error", "Phone app E2E", m);
};

const adb = (...args) => execFileSync(ADB, args, { encoding: "utf8", timeout: 120_000 });
const screenshot = (name) => {
  try {
    fs.writeFileSync(path.join(SHOTS, `${name}.png`), execFileSync(ADB, ["exec-out", "screencap", "-p"], { maxBuffer: 64 * 1024 * 1024 }));
  } catch (e) {
    console.log(`(screenshot ${name} failed: ${e.message})`);
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function pc(route, body, method = body === undefined ? "GET" : "POST") {
  const res = await fetch(`${PC}${route}`, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${route} → ${res.status} ${JSON.stringify(json).slice(0, 200)}`);
  return json;
}

let webviewPid = null;
/** JavaScript errors the app's page reported (shown when a step fails). */
const pageErrors = [];
function watch(page) {
  page.on("pageerror", (e) => pageErrors.push(`pageerror: ${e.message}`.slice(0, 300)));
  page.on("console", (m) => {
    if (m.type() === "error") pageErrors.push(`console: ${m.text()}`.slice(0, 300));
  });
  return page;
}

/** The app's JavaScript errors as logged by Capacitor/Chromium (in case the page we hold isn't the live one). */
function logcatErrors() {
  try {
    return adb("logcat", "-d", "-t", "4000")
      .split("\n")
      .filter((l) => /Capacitor\/Console|chromium|AndroidRuntime/.test(l) && /error|uncaught|exception|fatal/i.test(l))
      .slice(-6)
      .map((l) => l.replace(/^\S+\s+\S+\s+\d+\s+\d+\s+/, "").slice(0, 240));
  } catch {
    return [];
  }
}

/**
 * The app's WebView page. After a restart, Playwright can still hand out the
 * killed process's WebView for a moment (its page is already closed) — so
 * wait for one from a new process. And prefer a page that shows the app: right
 * after a cold start Playwright has handed out a blank page that never filled.
 */
async function attach(device, { notPid = null } = {}) {
  const deadline = Date.now() + 90_000;
  for (;;) {
    const webview = await device.webView({ pkg: PKG }, { timeout: Math.max(1_000, deadline - Date.now()) });
    if (notPid === null || webview.pid() !== notPid) {
      webviewPid = webview.pid();
      const page = watch(await webview.page());
      page.setDefaultTimeout(45_000);
      return page;
    }
    if (Date.now() > deadline) throw new Error(`the restarted app's WebView never appeared (still pid ${notPid})`);
    await sleep(500);
  }
}

/** Every page of the app's WebViews that shows something (the live one), else null. */
async function livePage(device) {
  for (const webview of device.webViews().filter((w) => w.pkg() === PKG)) {
    try {
      const page = await webview.page();
      const text = await page.evaluate(() => document.body?.innerText ?? "").catch(() => "");
      if (text.trim()) {
        webviewPid = webview.pid();
        page.setDefaultTimeout(45_000);
        return watch(page);
      }
    } catch {
      /* a closed WebView */
    }
  }
  return null;
}

const bodyHas = (page, re, timeout = 45_000) =>
  page.waitForFunction((src) => new RegExp(src, "i").test(document.body.innerText), re.source, { timeout, polling: 300 });

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const firstLine = (s) => (s.split("\n").find((l) => l.length > 20) ?? s).slice(0, 110);

/** Type a message on the phone, send it, and wait for the agent's answer (matching `re`). */
async function say(page, text, re, timeout = 45_000) {
  const before = await page.$$eval('[data-testid="msg-agent"]', (els) => els.length);
  await page.fill('[data-testid="composer-input"]', text);
  await page.click('[data-testid="send-button"]');
  await page.waitForFunction(
    ({ n, src }) => {
      const els = [...document.querySelectorAll('[data-testid="msg-agent"]')];
      return els.length > n && new RegExp(src, "i").test(els.at(-1).innerText);
    },
    { n: before, src: re.source },
    { timeout, polling: 300 },
  );
  return page.$$eval('[data-testid="msg-agent"]', (els) => els.at(-1)?.innerText ?? "");
}

/** What the app was showing when the phone didn't answer on its own (for the annotation). */
const offlineState = (page) =>
  page
    ? page
        .evaluate(() => {
          const agents = [...document.querySelectorAll('[data-testid="msg-agent"]')];
          const send = document.querySelector('[data-testid="send-button"]');
          const composer = document.querySelector('[data-testid="composer-input"]');
          return {
            lastAgent: (agents.at(-1)?.innerText ?? "").replace(/\s+/g, " ").slice(0, 160),
            agentCount: agents.length,
            composerDisabled: composer ? Boolean(composer.disabled || composer.readOnly) : null,
            sendDisabled: send ? Boolean(send.disabled) : null,
            banner: (document.querySelector('[data-testid="phone-mode-banner"]')?.innerText ?? "").replace(/\s+/g, " ").slice(0, 180),
          };
        })
        .catch((e) => ({ error: e.message }))
    : Promise.resolve({ error: "no page" });

const userText = (request) => (request?.body?.contents?.at(-1)?.parts ?? []).map((p) => p.text ?? "").join("");

/** What the app shows right now, in one line (for the annotations — CI screenshots aren't always at hand). */
const screenText = async (page) =>
  page
    ? clean(await page.evaluate(() => document.body.innerText).catch((e) => `(page unavailable: ${e.message})`))
        .replace(/\s+/g, " ")
        .slice(0, 400)
    : "(no page)";

let device;
let page;
try {
  if (!APK || !fs.existsSync(APK)) throw new Error(`COMPANION_APK not found: ${APK}`);
  console.log(adb("install", "-r", "-g", APK).trim());
  const sdk = adb("shell", "getprop", "ro.build.version.sdk").trim();
  const release = adb("shell", "getprop", "ro.build.version.release").trim();
  ok(`installed on Android ${release} (API ${sdk})`);

  // The PC: phone access on, a fresh pairing code.
  await pc("/api/v1/companion/enabled", { enabled: true });
  const status = await pc("/api/v1/companion/pairing", {});
  const link = status.pairing.link;
  if (!/[?&]h=[^&]*10\.0\.2\.2/.test(link)) throw new Error(`pairing link doesn't include the emulator's host address: ${link}`);
  console.log(`pairing link: ${link.replace(/c=[^&]+/, "c=…")}`);

  // Pair the way the system camera would: open the soundwave:// link.
  const openLink = () => adb("shell", `am start -W -a android.intent.action.VIEW -d '${link}' ${PKG}`);
  openLink();
  [device] = await android.devices({ omitDriverInstall: true });
  if (!device) throw new Error("no Android device visible to Playwright");
  page = await attach(device);
  const ua = await page.evaluate(() => navigator.userAgent);
  const webviewVersion = /Chrome\/([\d.]+)/.exec(ua)?.[1] ?? "unknown";
  try {
    await page.waitForSelector('[data-testid="chat"]', { timeout: 45_000 });
  } catch {
    // No chat after 45 s: say what we see, then look for the app's live page (Playwright
    // sometimes hands out a blank one on a cold start), and only then send the link again.
    annotate(
      "warning",
      "Phone app E2E",
      `no chat 45 s after opening the link — page ${page.url()} says: “${await screenText(page)}”; page errors: ${pageErrors.slice(-3).join(" | ") || "none"}; logcat: ${logcatErrors().join(" | ") || "nothing"}`,
    );
    screenshot("0-not-paired-yet");
    const live = await livePage(device);
    if (live && (await live.$('[data-testid="chat"]'))) {
      page = live;
      annotate("warning", "Phone app E2E", `the app was paired; Playwright had handed out a blank page (now attached to the live one, ${page.url()})`);
    } else {
      if (live) page = live;
      openLink();
      for (let i = 0; i < 12 && !(await page.$('[data-testid="chat"]').catch(() => null)); i++) {
        await sleep(5000);
        const again = await livePage(device);
        if (again) page = again;
      }
      await page.waitForSelector('[data-testid="chat"]', { timeout: 15_000 });
      annotate("warning", "Phone app E2E", "the chat appeared after the link was opened a second time");
    }
  }
  await bodyHas(page, /Connected to/, 60_000);
  const paired = (await pc("/api/v1/companion")).devices;
  ok(`paired from the soundwave:// link and connected (WebView ${webviewVersion}); the PC lists it as "${paired[0]?.name}" (${paired[0]?.model ?? "?"})`);
  await sleep(1500);
  screenshot("1-paired");

  // Secure context + encryption available in the WebView (https://localhost page → http://10.0.2.2).
  const env = await page.evaluate(() => ({ secure: window.isSecureContext, subtle: Boolean(crypto.subtle), origin: location.origin }));
  if (!env.secure || !env.subtle) fail(`WebView isn't a secure context (${JSON.stringify(env)})`);
  else ok(`app page ${env.origin} is a secure context with Web Crypto`);

  // Phone → agent, before the PC has a Gemini key: the agent says where to add one.
  const noKey = await say(page, "hello from the Android emulator", /Gemini API key/);
  ok(`sent a message over the encrypted channel; no Gemini key on the PC yet, so the agent says: "${firstLine(noKey)}…"`);
  const onPc = (await pc("/api/v1/companion/conversation")).messages.find((m) => m.text === "hello from the Android emulator");
  if (onPc?.via === "phone") ok("the message is in the PC's conversation, marked as sent from the phone");
  else fail("the phone's message isn't in the PC's conversation");

  // The PC gets a key (what Settings → Brain → Save does). Nothing changes on the phone.
  const brain = await pc("/api/v1/brain", { apiKey: FAKE_KEY }, "PUT");
  if (!brain.configured) throw new Error(`Settings → Brain didn't take the key: ${JSON.stringify(brain).slice(0, 200)}`);
  ok(`Settings → Brain on the PC: key saved (${brain.keyHint}), model ${brain.model}`);

  // Now Gemini answers the phone…
  const hello = await say(page, "hi again, from my phone", new RegExp(escapeRe(FAKE_HELLO)));
  ok(`Gemini answered the phone: "${firstLine(hello)}"`);
  // …and the agent's tools work from it: a PC status check (function call → runs on the PC → answer).
  const pcReport = await say(page, "how is my pc doing?", /Your PC runs .+ CPU cores/);
  ok(`a tool round trip from the phone (get_pc_status ran on the PC): "${firstLine(pcReport)}"`);
  await sleep(800);
  screenshot("2-gemini");

  // What Gemini got: the phone's words with the key, the note that they came
  // from the phone, and the PC status result under the call's id.
  const calls = (await (await fetch(`${GEMINI}/_fake/requests`)).json()).filter((r) => /:generateContent$/.test(r.url ?? ""));
  const asked = calls.find((r) => userText(r) === "how is my pc doing?");
  const result = calls.map((r) => r.body?.contents?.at(-1)?.parts?.find((p) => p.functionResponse)?.functionResponse).find((f) => f?.name === "get_pc_status");
  const instruction = asked?.body?.systemInstruction?.parts?.[0]?.text ?? "";
  if (!asked || asked.key !== FAKE_KEY) fail(`Gemini didn't get the phone's message with the key (${calls.length} calls: ${calls.map(userText).join(" | ").slice(0, 300)})`);
  else if (!/sent from the Soundwave phone app/.test(instruction)) fail("Gemini wasn't told the message came from the phone");
  else if (result?.id !== "pc-status-1" || typeof result?.response?.os !== "string") fail(`the PC status didn't go back to Gemini under the call's id (${JSON.stringify(result).slice(0, 200)})`);
  else ok(`Gemini got the phone's messages with the key and the note that they came from the phone, and the PC status (${result.response.os}) under the call's id — ${calls.length} Gemini calls`);

  // PC → phone (the Command Center pushes a message; the phone's long-poll brings it).
  const pushedAt = Date.now();
  await pc("/api/v1/companion/conversation", { messages: [{ id: `${pushedAt}-ci-pc`, sender: "user", text: "Typed in the Command Center during CI", time: "", at: pushedAt }] });
  await bodyHas(page, /Typed in the Command Center during CI/, 30_000);
  ok(`a message typed on the PC reached the phone in ${Date.now() - pushedAt} ms (long-poll)`);
  await sleep(800);
  screenshot("3-conversation");

  // The keyboard must not cover the message box.
  const before = await page.evaluate(() => window.innerHeight);
  await page.tap('[data-testid="composer-input"]').catch(async () => page.click('[data-testid="composer-input"]'));
  await sleep(2500);
  const ime = adb("shell", "dumpsys input_method").match(/mInputShown=(true|false)/)?.[1];
  const layout = await page.evaluate(() => {
    const r = document.querySelector('[data-testid="composer-input"]').getBoundingClientRect();
    return { innerHeight: window.innerHeight, bottom: r.bottom, top: r.top };
  });
  if (ime === "true") {
    screenshot("4-keyboard");
    if (layout.innerHeight < before && layout.bottom <= layout.innerHeight && layout.top >= 0) {
      ok(`keyboard open: the page shrank from ${before}px to ${layout.innerHeight}px and the message box stays visible`);
    } else {
      fail(`keyboard open but the message box is covered (page ${before}→${layout.innerHeight}px, box ${Math.round(layout.top)}–${Math.round(layout.bottom)}px)`);
    }
    adb("shell", "input keyevent 4"); // BACK closes the keyboard
    await sleep(800);
  } else {
    annotate("notice", "Phone app E2E", `keyboard check skipped (the emulator didn't show a soft keyboard: mInputShown=${ime})`);
  }

  // Settings sheet — including "Chat without the PC", set up from the PC's Gemini key.
  await page.click('[data-testid="settings-button"]');
  await bodyHas(page, /Read replies aloud/);
  await bodyHas(page, /Ready — Gemini 3\.8 Flash/, 30_000);
  ok('settings: "Chat without the PC — Ready — Gemini 3.8 Flash" (the PC shared its brain kit)');
  await sleep(900);
  screenshot("5-settings");
  adb("shell", "input keyevent 4"); // Android back closes the sheet
  await page.waitForFunction(() => !/Read replies aloud/.test(document.body.innerText), null, { timeout: 10_000 });
  ok("Android back button closes the settings sheet");

  // The daily briefing (app 1.2.0): set on the PC, due in ~2 minutes by the phone's clock — so it
  // isn't delivered while the PC still answers; the phone gets the plan with the agent's memory.
  const BRIEF_TOPIC = "the latest news about open-source, free AI tools";
  const [ph, pm, ps] = adb("shell", "date +%H:%M:%S").trim().split(":").map(Number);
  const dueMin = (ph * 60 + pm + 2) % (24 * 60);
  const dueAt = `${String(Math.floor(dueMin / 60)).padStart(2, "0")}:${String(dueMin % 60).padStart(2, "0")}`;
  const dueAtMs = Date.now() + (((dueMin * 60 - (ph * 3600 + pm * 60 + ps)) + 86_400) % 86_400) * 1000;
  await pc("/api/v1/morning", { items: [], city: "Kruševac", briefing: { topics: [BRIEF_TOPIC], time: dueAt, auto: true } }, "PUT");
  await page.click('[data-testid="settings-button"]');
  await bodyHas(page, new RegExp(`Every morning at ${dueAt}`), 60_000);
  await bodyHas(page, new RegExp(escapeRe(BRIEF_TOPIC)), 10_000);
  adb("shell", "input keyevent 4");
  await page.waitForFunction(() => !/Read replies aloud/.test(document.body.innerText), null, { timeout: 10_000 });
  ok(`the briefing plan reached the phone with the agent's memory (every morning at ${dueAt}: “${BRIEF_TOPIC}”)`);

  // The PC goes away (phone access off): the phone keeps chatting on its own, with Gemini directly.
  await pc("/api/v1/companion/enabled", { enabled: false });
  await page.waitForSelector('[data-testid="phone-mode-banner"]', { timeout: 60_000 });
  ok("the PC stopped answering: the phone switched to chatting on its own");
  // Asking again after a moment is fair — the WebView's first request to the
  // stand-in can hiccup on the emulator — and each failed try says what the app
  // was showing, so a real problem doesn't hide behind a flake.
  let offlineText = null;
  for (let attempt = 1; attempt <= 2 && !offlineText; attempt++) {
    try {
      offlineText = await say(page, "are you still there without the PC?", new RegExp(escapeRe(FAKE_PHONE)), 60_000);
    } catch (e) {
      annotate("warning", "Phone app E2E", `the phone didn't answer on its own (attempt ${attempt}): ${e.message} — ${JSON.stringify(await offlineState(page))}; screen: “${(await screenText(page)).slice(0, 160)}”`);
      await sleep(1500);
    }
  }
  if (offlineText) ok(`answered on the phone itself while the PC was off: "${firstLine(offlineText)}"`);
  else fail("the phone never answered on its own while the PC was off");
  if (!(await page.$('[data-testid="answered-on-phone"]'))) fail('the phone\'s own answer isn\'t marked "on phone"');

  // The briefing is due: open the app again (as in the morning) — with the PC off, the phone
  // researches the topic with Gemini, writes the briefing and starts talking by itself.
  while (Date.now() < dueAtMs + 4000) await sleep(2000);
  const pidBeforeMorning = webviewPid;
  adb("shell", `am force-stop ${PKG}`);
  await sleep(1000);
  adb("shell", `monkey -p ${PKG} -c android.intent.category.LAUNCHER 1`);
  page = await attach(device, { notPid: pidBeforeMorning });
  await page.waitForSelector('[data-testid="chat"]', { timeout: 90_000 });
  await page.waitForSelector('[data-testid="briefing-bar"], [data-testid="briefing-label"]', { timeout: 60_000 });
  ok("opened after the briefing time with the PC off: the briefing started by itself");
  let phase = null;
  let problem = null;
  for (let i = 0; i < 600 && phase !== "speaking" && !problem; i++) {
    const st = await page.evaluate(() => ({ phase: document.querySelector('[data-testid="briefing-bar"]')?.getAttribute("data-phase") ?? null, text: document.body.innerText }));
    phase = st.phase;
    problem = /The morning briefing didn't work this time: ([^\n]+)/.exec(st.text)?.[1] ?? null;
    if (phase !== "speaking" && !problem) await sleep(200);
  }
  await bodyHas(page, new RegExp(escapeRe(FAKE_MORNING)), 30_000);
  await sleep(500);
  screenshot("6a-briefing-on-open");
  if (phase === "speaking") ok("the briefing was written on the phone and is being read aloud in the Soundwave voice — by the phone itself");
  else fail(`the briefing didn't start talking: ${problem ?? "no speaking phase seen"}`);
  const brief = (await (await fetch(`${GEMINI}/_fake/requests`)).json()).filter(
    (r) => /Write the user's Morning Setup briefing/.test(r.body?.systemInstruction?.parts?.[0]?.text ?? "") && /The PC is off/.test(userText(r)),
  )[0];
  const firstFinding = FAKE_RESEARCH.split("\n")[0];
  if (!brief) fail("the phone's briefing request never reached Gemini");
  else if (!userText(brief).includes(`1. “${BRIEF_TOPIC}” — researched with Google Search:\n${firstFinding}`))
    fail(`the phone's briefing wasn't written from the topic's research: ${userText(brief).slice(0, 400)}`);
  else ok(`with the PC off the phone researched “${BRIEF_TOPIC}” (Gemini 2.5 Flash + Google Search) and wrote the briefing from it`);
  // The native voice on its own (Microsoft's service, straight from the phone).
  const voice = await page.evaluate(async () => {
    try {
      const r = await window.Capacitor.Plugins.EdgeTts.synthesize({ text: "Good morning from Soundwave, speaking on your phone.", voice: "en-US-GuyNeural" });
      return { ok: true, bytes: r.bytes };
    } catch (e) {
      return { ok: false, error: String(e?.message ?? e) };
    }
  });
  if (voice.ok && voice.bytes > 2000) ok(`the phone made Soundwave speech itself: Guy, ${voice.bytes} bytes of MP3 from Microsoft's voice service`);
  else fail(`the phone couldn't make Soundwave speech itself: ${voice.error ?? `${voice.bytes} bytes`}`);

  // Morning Setup with the PC off: the phone's own briefing (weather from the stand-in Open-Meteo).
  await page.click('[data-testid="morning-chip"]');
  await bodyHas(page, new RegExp(escapeRe(FAKE_MORNING)), 60_000);
  await sleep(800);
  screenshot("6-phone-mode");
  const fromPhone = (await (await fetch(`${GEMINI}/_fake/requests`)).json()).filter((r) => /:generateContent$/.test(r.url ?? ""));
  const phoneChat = fromPhone.find((r) => userText(r) === "are you still there without the PC?");
  const phoneMorning = fromPhone.find((r) => /Write the user's Morning Setup briefing/.test(r.body?.systemInstruction?.parts?.[0]?.text ?? "") && /The PC is off/.test(userText(r)));
  if (!phoneChat || phoneChat.key !== FAKE_KEY) fail("the phone's own Gemini request wasn't seen (with the key)");
  else if (!/answering from the Soundwave phone app on your own/.test(phoneChat.body?.systemInstruction?.parts?.[0]?.text ?? "")) fail("the phone didn't tell Gemini the PC is off");
  else if (!phoneMorning) fail("the phone's Morning Setup briefing request wasn't seen");
  else if (!/Weather: In Kruševac it's 14°C/.test(userText(phoneMorning))) fail(`the phone's briefing had no weather: ${userText(phoneMorning).slice(0, 300)}`);
  else ok("with the PC off the phone asked Gemini itself (key, \"PC is off\" note, memory) and briefed with the weather from Open-Meteo");

  // The PC is back: what was said on the phone goes into the PC's conversation.
  // (Coming out of offline mode is the flakiest part of the WebView: the page's
  // reconnect can need a nudge, or a second one, on the emulator — retry, and
  // say so in the annotations, instead of failing the whole run on one try.)
  await pc("/api/v1/companion/enabled", { enabled: true });
  const lookForThePc = () =>
    page.evaluate(() => [...document.querySelectorAll("button")].find((b) => /Try now|Look for the PC/.test(b.textContent ?? ""))?.click());
  let reconnected = false;
  let attempts = 0;
  for (let attempt = 1; attempt <= 4 && !reconnected; attempt++) {
    attempts = attempt;
    await lookForThePc().catch(() => undefined);
    try {
      await bodyHas(page, /Connected to/, 45_000);
      reconnected = true;
    } catch {
      const screen = (await screenText(page)).replace(/\s+/g, " ").slice(0, 200);
      annotate("warning", "Phone app E2E", `the phone hadn't reconnected after attempt ${attempt} (screen: “${screen}”) — trying again`);
      await sleep(2000);
    }
  }
  if (!reconnected) fail("the phone never reconnected to the PC after it came back");
  else ok(`the phone reconnected to the PC${attempts > 1 ? ` (needed ${attempts} tries)` : ""} and is exchanging messages again`);
  let synced = null;
  for (let i = 0; i < 30 && !synced; i++) {
    const msgs = (await pc("/api/v1/companion/conversation")).messages;
    const asked = msgs.find((m) => m.text === "are you still there without the PC?");
    const answered = msgs.find((m) => m.text === FAKE_PHONE);
    if (asked && answered) synced = { asked, answered, morning: msgs.some((m) => m.text === FAKE_MORNING && m.answeredBy === "phone") };
    else await sleep(1000);
  }
  if (!synced) fail("the phone's offline messages never reached the PC");
  else if (synced.asked.via !== "phone" || synced.answered.answeredBy !== "phone" || !synced.morning) fail(`offline messages reached the PC without their labels: ${JSON.stringify(synced).slice(0, 300)}`);
  else ok("reconnected, and the offline chat + Morning Setup are now in the PC's conversation (marked as answered on the phone)");
  const briefingNow = await pc("/api/v1/morning/briefing");
  const phoneBriefing = (await pc("/api/v1/companion/conversation")).messages.find((m) => m.briefingDate === briefingNow.day && m.answeredBy === "phone");
  if (!phoneBriefing) fail("the phone's morning briefing isn't in the PC's conversation");
  else if (briefingNow.heard?.on !== "phone") fail(`the PC doesn't know the briefing was heard on the phone (${JSON.stringify(briefingNow.heard)})`);
  else ok("the phone's morning briefing is in the PC's conversation, and the PC knows it was heard (it won't speak it again)");

  // ── The alarm (1.3.0): the agent arms a real alarm on this phone ──────────
  // The agent's `set_phone_alarm` tool leaves a control message in the shared
  // conversation; the phone runs it natively (AlarmManager) and answers in the
  // chat. Then a short alarm really rings: turning it off starts the briefing
  // after the delay that came with the alarm.
  await say(page, "set an alarm for 6:30 tomorrow morning, call it CI wake-up", /Alarm set for 6:30 AM/, 60_000);
  // The agent's reply and the phone's own confirmation race each other: wait for
  // the phone's message (the “on phone” one, naming the alarm time).
  const phoneAlarmMsg = () =>
    page.evaluate(() => {
      const els = [...document.querySelectorAll('[data-testid="msg-agent"]')];
      const mine = [...els].reverse().find((e) => e.querySelector('[data-testid="answered-on-phone"]') && /Alarm set for 6:30 AM/.test(e.innerText));
      return (mine?.innerText ?? "").replace(/\s+/g, " ");
    });
  let armedMsg = "";
  for (let i = 0; i < 30 && !armedMsg; i++) {
    armedMsg = await phoneAlarmMsg();
    if (!armedMsg) await sleep(1000);
  }
  if (!armedMsg) fail("the phone never confirmed the alarm in the chat itself");
  else ok(`the agent set an alarm on the phone and the phone armed it itself: “${firstLine(armedMsg)}”`);
  const armedInOs = adb("shell", "dumpsys alarm | grep -ci soundwave || true").trim();
  if (!(Number(armedInOs) > 0)) fail(`the alarm isn't in Android's own alarm list (dumpsys alarm: ${armedInOs})`);
  else ok(`Android has the alarm armed (dumpsys alarm lists Soundwave ${armedInOs}×)`);

  // A short one, so it really rings here: in 20 seconds, briefing 5 s after Turn off.
  await say(page, "set an alarm in 20 seconds", /Alarm set for/, 60_000);
  const alarmSetAt = Date.now();
  let alarmScreen = "";
  for (let i = 0; i < 24 && !/AlarmActivity/.test(alarmScreen); i++) {
    await sleep(1500);
    alarmScreen = [
      adb("shell", "dumpsys activity activities | grep -E 'topResumedActivity|ResumedActivity' | head -3"),
      adb("shell", "dumpsys window | grep -E 'mCurrentFocus|mFocusedApp' | head -2"),
    ].join(" | ");
  }
  if (!/AlarmActivity/.test(alarmScreen)) fail(`the alarm didn't ring 20 s after it was set (top activity: ${alarmScreen.replace(/\s+/g, " ").slice(0, 200)})`);
  else ok(`the alarm rang ${Math.round((Date.now() - alarmSetAt) / 1000)} s after it was set, and its own alarm screen is up`);
  screenshot("8-alarm-ringing");

  // “Turn off”, the way a person does it — through Android's own UI dump. If the
  // dump hiccups, the same thing through the app's `soundwave_alarm` extra (what
  // the notification's button uses; MainActivity is singleTask, so the running
  // app gets it without reloading).
  const tapTurnOff = () => {
    const dump = adb("shell", "rm -f /sdcard/sw-alarm.xml; uiautomator dump /sdcard/sw-alarm.xml >/dev/null 2>&1; cat /sdcard/sw-alarm.xml 2>/dev/null || true");
    const m = /resource-id="ai\.soundwave\.companion:id\/alarm_dismiss"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(dump);
    if (!m) return null;
    const x = Math.round((Number(m[1]) + Number(m[3])) / 2);
    const y = Math.round((Number(m[2]) + Number(m[4])) / 2);
    adb("shell", `input tap ${x} ${y}`);
    return { x, y };
  };
  let tapped = null;
  for (let i = 0; i < 4 && !tapped; i++) {
    await sleep(1200);
    tapped = tapTurnOff();
  }
  const turnedOffAt = Date.now();
  if (tapped) ok(`turned the alarm off on its own screen (tapped “Turn off” at ${tapped.x},${tapped.y})`);
  else {
    annotate("warning", "Phone app E2E", "the alarm screen didn't come out of the UI dump — turning it off through the app's own soundwave_alarm extra instead");
    adb("shell", `am start -n ${PKG}/.MainActivity -e soundwave_alarm dismiss`);
  }

  // The alarm's own delay (5 s here): the briefing must not start immediately,
  // and then it must actually start talking.
  await sleep(3000);
  const earlyPhase = await page.evaluate(() => document.querySelector('[data-testid="briefing-bar"]')?.getAttribute("data-phase") ?? null);
  if (earlyPhase === "speaking") fail("the briefing started before the alarm's delay was over");
  let alarmSpoke = false;
  let alarmProblem = null;
  for (let i = 0; i < 90 && !alarmSpoke && !alarmProblem; i++) {
    const st = await page
      .evaluate(() => ({
        phase: document.querySelector('[data-testid="briefing-bar"]')?.getAttribute("data-phase") ?? null,
        text: document.body.innerText,
      }))
      .catch(() => ({ phase: null, text: "" }));
    alarmSpoke = st.phase === "speaking";
    alarmProblem = /The morning briefing didn't work this time: ([^\n]+)/.exec(st.text)?.[1] ?? null;
    if (!alarmSpoke && !alarmProblem) await sleep(500);
  }
  if (alarmProblem) fail(`the briefing after the alarm failed: ${alarmProblem}`);
  else if (!alarmSpoke) fail("the briefing never started talking after the alarm was turned off");
  else ok(`turned off → the briefing started talking ${Math.round((Date.now() - turnedOffAt) / 1000)} s later (the alarm said 5 s; then today's briefing is fetched and the voice starts)`);
  await sleep(500);
  screenshot("9-alarm-briefing");

  // Settings → the alarm that is left (6:30, tomorrow) and cancel it there.
  await page.click('[data-testid="settings-button"]');
  await bodyHas(page, /Alarm & the briefing/, 20_000);
  const alarmSheet = async () => ((await page.textContent('[data-testid="alarm-settings"]')) ?? "").replace(/\s+/g, " ").trim();
  const withAlarm = await alarmSheet();
  if (!/Next alarm 6:30 AM/.test(withAlarm)) fail(`the 6:30 alarm isn't in the settings sheet: ${withAlarm.slice(0, 200)}`);
  else await page.click('[data-testid="alarm-cancel"]');
  await page.waitForFunction(() => /No alarm set/.test(document.body.innerText), null, { timeout: 20_000 }).catch(() => undefined);
  const withoutAlarm = await alarmSheet();
  if (!/No alarm set/.test(withoutAlarm)) fail(`cancelling didn't clear the alarm list: ${withoutAlarm.slice(0, 200)}`);
  else {
    const leftInOs = adb("shell", "dumpsys alarm | grep -ci soundwave || true").trim();
    if (Number(leftInOs) > 0) fail(`the cancelled alarm is still in Android's alarm list (dumpsys alarm: ${leftInOs})`);
    else ok("the settings sheet listed the 6:30 alarm, and cancelling it took it out of Android's alarm list too");
  }
  adb("shell", "input keyevent 4");
  await page.waitForFunction(() => !/Read replies aloud/.test(document.body.innerText), null, { timeout: 10_000 }).catch(() => undefined);

  // Restart the app: still paired, conversation still there.
  const oldPid = webviewPid;
  adb("shell", `am force-stop ${PKG}`);
  await sleep(1000);
  adb("shell", `monkey -p ${PKG} -c android.intent.category.LAUNCHER 1`);
  page = await attach(device, { notPid: oldPid });
  await page.waitForSelector('[data-testid="chat"]', { timeout: 90_000 });
  await bodyHas(page, /Typed in the Command Center during CI/, 30_000);
  await bodyHas(page, /Connected to/, 60_000);
  ok("after a restart the app is still paired and shows the conversation");
  // The alarm's briefing was heard: coming back must not say it again.
  const settledFake = await page.evaluate(() => [...document.querySelectorAll('[data-testid="msg-agent"]')].filter((e) => /fake gemini/i.test(e.innerText)).length);
  await sleep(4000);
  const afterRestart = await page.evaluate(() => ({
    phase: document.querySelector('[data-testid="briefing-bar"]')?.getAttribute("data-phase") ?? null,
    fake: [...document.querySelectorAll('[data-testid="msg-agent"]')].filter((e) => /fake gemini/i.test(e.innerText)).length,
  }));
  if (afterRestart.phase === "speaking" || afterRestart.fake > settledFake) fail(`the briefing was said again after a restart (phase ${afterRestart.phase}, briefing messages ${settledFake} → ${afterRestart.fake})`);
  else ok("after a restart the briefing wasn't said again — the alarm's briefing stays spoken once");
  await sleep(1000);
  screenshot("7-after-restart");
} catch (err) {
  fail(`stopped: ${err.message}`);
  annotate("error", "Phone app E2E", `the screen at that moment (${page?.url?.() ?? "no page"}): ${await screenText(page)}`);
  annotate("error", "Phone app E2E", `page errors: ${pageErrors.slice(-4).join(" | ") || "none"}; logcat: ${logcatErrors().join(" | ") || "nothing"}`);
  screenshot("zz-failure");
} finally {
  try {
    fs.writeFileSync(path.join(SHOTS, "logcat.txt"), adb("logcat", "-d", "-t", "3000"));
  } catch {
    /* no device */
  }
  await device?.close().catch(() => undefined);
}
process.exit(failed ? 1 : 0);

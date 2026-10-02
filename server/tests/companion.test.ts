// Phone companion: the PC listener (lib/companion) against the phone app's own
// protocol + client code (mobile/src/lib) — real HTTP on loopback, real crypto.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import request from "supertest";

const mocks = vi.hoisted(() => {
  // Routes under /api/v1/companion exist only in the desktop app.
  process.env.COMPANION = "1";
  return {
    transcribe: vi.fn(async () => ({ text: "make a note", noSpeech: false, durationMs: 1200, elapsedMs: 80, model: "test" })),
    synthesizeEdgeTTS: vi.fn(async () => ({ audioBase64: Buffer.from("ID3-fake-mp3").toString("base64"), mimeType: "audio/mpeg", duration: 1.2 })),
  };
});

vi.mock("../src/lib/stt.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/stt.js")>();
  return {
    ...actual,
    transcribe: mocks.transcribe,
    getSttStatus: () => ({ ...actual.getSttStatus(), available: true, reason: null }),
  };
});

vi.mock("../src/lib/edgeTts.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/edgeTts.js")>();
  return { ...actual, synthesizeEdgeTTS: mocks.synthesizeEdgeTTS };
});

const { config } = await import("../src/config.js");
const { createApp } = await import("../src/app.js");
const { JsonStore, setStoreForTests, getStore } = await import("../src/lib/store.js");
const { emitJob } = await import("../src/routes/export.js");
const serverCrypto = await import("../src/lib/companion/crypto.js");
const service = await import("../src/lib/companion/service.js");
const listener = await import("../src/lib/companion/listener.js");
const conversation = await import("../src/lib/conversation.js");
const phone = await import("../../mobile/src/lib/protocol.js");
const { CompanionClient, pairWithPc, CompanionError } = await import("../../mobile/src/lib/client.js");

const DATA = config.dataDir;
let base = "";
let app: ReturnType<typeof createApp>;

async function openListener() {
  service.setEnabledFlag(true);
  await listener.startListener({ host: "127.0.0.1", port: 0 });
  const { port } = listener.listenerState();
  base = `http://127.0.0.1:${port}`;
  return port!;
}

function linkFor(port: number): string {
  const session = service.activePairing() ?? service.startPairing();
  return service.pairingLink(session, port, [{ address: "127.0.0.1", name: "lo", kind: "lan" }]);
}

async function pairedClient() {
  const port = await openListener();
  const link = phone.parsePairingLink(linkFor(port))!;
  const record = await pairWithPc(link, { name: "Test Phone", platform: "android", model: "Pixel Test", appVersion: "1.0.0" });
  const client = new CompanionClient(record);
  expect(await client.connect()).toBe(true);
  return { client, record, port };
}

beforeAll(async () => {
  fs.rmSync(DATA, { recursive: true, force: true });
  const store = new JsonStore();
  await store.init();
  setStoreForTests(store);
  app = createApp();
});

beforeEach(() => {
  for (const f of ["companion.json", "agent-conversation.json"]) fs.rmSync(path.join(DATA, f), { force: true });
  service.resetCompanionStateForTests();
  conversation.resetConversationForTests();
});

afterEach(async () => {
  await listener.stopListener();
});

afterAll(async () => {
  await listener.stopListener();
});

describe("pairing codes and links", () => {
  it("makes 12-character Crockford codes and reads them back however they're typed", () => {
    const code = serverCrypto.generatePairingCode();
    expect(code).toMatch(/^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{12}$/);
    const pretty = serverCrypto.formatPairingCode(code);
    expect(pretty).toMatch(/^.{4}-.{4}-.{4}$/);
    expect(phone.normalizePairingCode(pretty.toLowerCase())).toBe(code);
    expect(phone.normalizePairingCode("ab1o-il23-4567")).toBe("AB1011234567");
    expect(phone.normalizePairingCode("too-short")).toBeNull();
    expect(phone.normalizePairingCode("UUUU-UUUU-UUUU")).toBeNull();
  });

  it("puts everything the phone needs in the QR link", () => {
    const session = service.startPairing();
    const link = service.pairingLink(session, 47801, [
      { address: "192.168.1.23", name: "Wi-Fi", kind: "lan" },
      { address: "100.101.102.103", name: "Tailscale", kind: "vpn" },
    ]);
    const parsed = phone.parsePairingLink(link)!;
    expect(parsed).toMatchObject({ code: session.code, pcId: session.pcId, port: 47801, hosts: ["192.168.1.23", "100.101.102.103"] });
    expect(phone.parsePairingLink("https://example.com/?c=x")).toBeNull();
    expect(phone.parsePairingLink("soundwave://pair?c=ABCD&i=pc_1&h=1.2.3.4")).toBeNull();
  });

  it("orders the PC's addresses: Wi-Fi/Ethernet first, VPN next, virtual adapters last", () => {
    const addrs = service.localAddresses({
      "vEthernet (WSL)": [{ address: "172.20.0.1", family: "IPv4", internal: false } as never],
      Tailscale: [{ address: "100.88.1.2", family: "IPv4", internal: false } as never],
      "Wi-Fi": [
        { address: "192.168.1.23", family: "IPv4", internal: false } as never,
        { address: "fe80::1", family: "IPv6", internal: false } as never,
      ],
      Ethernet: [{ address: "169.254.3.4", family: "IPv4", internal: false } as never],
      lo: [{ address: "127.0.0.1", family: "IPv4", internal: true } as never],
    });
    expect(addrs.map((a) => a.address)).toEqual(["192.168.1.23", "100.88.1.2", "172.20.0.1"]);
    expect(addrs[1]!.kind).toBe("vpn");
  });
});

describe("the encrypted channel (PC ⇄ phone implementations)", () => {
  it("derives the same pairing key on both sides and opens each other's envelopes", async () => {
    const code = serverCrypto.generatePairingCode();
    const pcKey = serverCrypto.derivePairingKey(code, "pc_0123456789abcdef");
    const phoneKey = await phone.derivePairingKey(code, "pc_0123456789abcdef");
    const ad = phone.aad("pair", "c2s", "pc_0123456789abcdef");

    const fromPhone = await phone.seal(phoneKey, phone.frame({ op: "pair", n: "x" }, new Uint8Array([1, 2, 3])), ad);
    const opened = serverCrypto.unframe(serverCrypto.open(pcKey, Buffer.from(fromPhone), Buffer.from(ad)));
    expect(opened.header).toEqual({ op: "pair", n: "x" });
    expect([...opened.payload]).toEqual([1, 2, 3]);

    const fromPc = serverCrypto.seal(pcKey, serverCrypto.frame({ ok: true }), Buffer.from(ad));
    expect(phone.unframe(await phone.open(phoneKey, fromPc, ad)).header).toEqual({ ok: true });
  });

  it("derives the same per-direction device keys", async () => {
    const deviceKey = Buffer.alloc(32, 7);
    const pc = serverCrypto.deriveDeviceKeys(deviceKey, "d_abc");
    const ph = await phone.deriveDeviceKeys(new Uint8Array(deviceKey), "d_abc");
    const ad = phone.aad("rpc", "s2c", "d_abc", "n1");
    const env = serverCrypto.seal(pc.s2c, Buffer.from("hello"), Buffer.from(ad));
    expect(new TextDecoder().decode(await phone.open(ph.s2c, env, ad))).toBe("hello");
    // The other direction's key can't open it.
    await expect(phone.open(ph.c2s, env, ad)).rejects.toThrow();
  });

  it("refuses tampered envelopes and wrong context", () => {
    const key = Buffer.alloc(32, 1);
    const env = serverCrypto.seal(key, Buffer.from("secret"), serverCrypto.aad("rpc", "c2s", "d_1"));
    const flipped = Buffer.from(env);
    flipped[flipped.length - 20]! ^= 0x01;
    expect(() => serverCrypto.open(key, flipped, serverCrypto.aad("rpc", "c2s", "d_1"))).toThrow(serverCrypto.EnvelopeError);
    expect(() => serverCrypto.open(key, env, serverCrypto.aad("rpc", "c2s", "d_2"))).toThrow(serverCrypto.EnvelopeError);
    expect(serverCrypto.open(key, env, serverCrypto.aad("rpc", "c2s", "d_1")).toString()).toBe("secret");
  });
});

describe("pairing a phone", () => {
  it("pairs with the code from the QR link, once", async () => {
    const port = await openListener();
    const link = phone.parsePairingLink(linkFor(port))!;
    const record = await pairWithPc(link, { name: "Pixel 8", platform: "android" });
    expect(record.deviceId).toMatch(/^d_[0-9a-f]{16}$/);
    expect(phone.fromBase64(record.deviceKey)).toHaveLength(32);
    expect(record.hosts[0]).toBe("127.0.0.1");

    const status = listener.companionStatus();
    expect(status.devices).toHaveLength(1);
    expect(status.devices[0]).toMatchObject({ name: "Pixel 8", platform: "android", online: true });
    expect(JSON.stringify(status)).not.toContain(record.deviceKey); // the key never leaves the PC's file
    expect(status.pairing).toBeNull(); // one code, one phone
    expect(status.lastPaired?.name).toBe("Pixel 8");

    // The same code can't pair a second phone.
    await expect(pairWithPc(link, { name: "Other", platform: "android" })).rejects.toMatchObject({ code: "NO_PAIRING" });
  });

  it("learns the phone app's version when it connects — an updated app stops looking old", async () => {
    const port = await openListener();
    const link = phone.parsePairingLink(linkFor(port))!;
    const record = await pairWithPc(link, { name: "Old Phone", platform: "android", appVersion: "1.2.1" });
    const stored = () => service.pairedPhones().find((d) => d.id === record.deviceId)?.appVersion;
    expect(stored()).toBe("1.2.1");

    // The phone installs the update and reconnects: alarms need 1.3.0, so the PC
    // must stop refusing it.
    const client = new CompanionClient(record, { appVersion: "1.3.0" });
    expect(await client.connect()).toBe(true);
    expect(stored()).toBe("1.3.0");
    client.stop();
  });

  it("refuses a wrong code without pairing anything", async () => {
    const port = await openListener();
    const link = phone.parsePairingLink(linkFor(port))!;
    const wrong = { ...link, code: link.code === "000000000000" ? "111111111111" : "000000000000" };
    await expect(pairWithPc(wrong, { name: "Guess", platform: "android" })).rejects.toMatchObject({ code: "WRONG_CODE" });
    expect(listener.companionStatus().devices).toHaveLength(0);
    expect(listener.companionStatus().pairing).not.toBeNull(); // the real code still works
  });

  it("says when the PC can't be reached", async () => {
    const link = phone.parsePairingLink(
      service.pairingLink(service.startPairing(), 9, [{ address: "127.0.0.1", name: "lo", kind: "lan" }]),
    )!;
    await expect(pairWithPc(link, { name: "X", platform: "android" })).rejects.toMatchObject({ code: "UNREACHABLE" });
  });
});

describe("talking to the agent from the phone", () => {
  it("sends a message, gets the agent's reply, and both land in the shared conversation", async () => {
    const { client } = await pairedClient();
    expect(client.state.kind).toBe("online");
    expect(client.pc?.voiceInput.available).toBe(true);

    const reply = await client.send("hello there", { viaVoice: true });
    expect(reply.sender).toBe("assistant");
    // No Gemini key on this test PC: the agent says how to add one (tests/brain.test.ts has Gemini answering).
    expect(reply.text).toMatch(/Gemini API key/);

    const shared = conversation.getConversation().messages;
    const said = shared.find((m) => m.sender === "user" && m.text === "hello there");
    expect(said).toMatchObject({ via: "phone", viaVoice: true });
    expect(shared.at(-1)!.id).toBe(reply.id);
    expect(client.conversation?.messages.map((m) => m.id)).toEqual(shared.map((m) => m.id));
  });

  it("sees what the Command Center says (desktop push → phone sync)", async () => {
    const { client } = await pairedClient();
    await client.sync();
    const before = client.conversation!.rev;

    const now = Date.now();
    const push = await request(app)
      .post("/api/v1/companion/conversation")
      .set("Host", "127.0.0.1")
      .send({
        voice: "en-GB-SoniaNeural",
        messages: [
          { id: `${now}-desk01`, sender: "user", text: "typed on the PC", time: "1:00 PM" },
          { id: "junk", sender: "robot", text: 5 }, // dropped
        ],
      });
    expect(push.status).toBe(200);
    expect(push.body.messages.map((m: { text: string }) => m.text)).toContain("typed on the PC");
    expect(push.body.messages.some((m: { id: string }) => m.id === "junk")).toBe(false);

    await client.sync();
    expect(client.conversation!.rev).toBeGreaterThan(before);
    expect(client.conversation!.messages.some((m) => m.text === "typed on the PC")).toBe(true);
    expect(client.pc?.voice).toBe("en-GB-SoniaNeural"); // the phone speaks with the PC's voice
  });

  it("long-polls: a waiting sync returns as soon as something is said", async () => {
    const { client } = await pairedClient();
    await client.sync();
    const started = Date.now();
    const waiting = client.sync(true);
    setTimeout(() => {
      conversation.appendToConversation({ id: `${Date.now()}-late01`, sender: "assistant", text: "news!", time: "", at: Date.now() });
    }, 150);
    await waiting;
    expect(Date.now() - started).toBeLessThan(5000);
    expect(client.conversation!.messages.at(-1)!.text).toBe("news!");
  });

  it("transcribes speech and speaks replies through the PC", async () => {
    const { client } = await pairedClient();
    const heard = await client.transcribe(new Uint8Array([82, 73, 70, 70, 1, 2, 3, 4]));
    expect(heard.text).toBe("make a note");
    expect(Buffer.from(mocks.transcribe.mock.calls.at(-1)![0] as Buffer).subarray(0, 4).toString()).toBe("RIFF");

    const spoken = await client.speak("Hello from the PC", "en-US-JennyNeural");
    expect(spoken.mime).toBe("audio/mpeg");
    expect(new TextDecoder().decode(spoken.audio)).toBe("ID3-fake-mp3");
    expect(mocks.synthesizeEdgeTTS.mock.calls.at(-1)![0]).toMatchObject({ text: "Hello from the PC", voice: "en-US-JennyNeural" });
  });

  it("downloads a finished short in pieces", async () => {
    const { client } = await pairedClient();
    const store = await getStore();
    const job = await store.createJob({
      projectId: null,
      userId: "local-user",
      status: "COMPLETED",
      progress: 100,
      settings: { topic: "black holes" } as never,
      outputUrl: "/api/v1/export/jobs/x/download",
      errorMessage: null,
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    });
    const bytes = Buffer.alloc(5 * 1024 * 1024 + 123);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
    fs.mkdirSync(path.join(config.uploadsDir, "jobs"), { recursive: true });
    const file = path.join(config.uploadsDir, "jobs", `${job.id}.mp4`);
    fs.writeFileSync(file, bytes);
    try {
      const progress: number[] = [];
      const blob = await client.video(job.id, (f) => progress.push(f));
      expect(blob.type).toBe("video/mp4");
      expect(Buffer.from(await blob.arrayBuffer()).equals(bytes)).toBe(true);
      expect(progress.at(-1)).toBe(1);
      expect(progress.length).toBeGreaterThanOrEqual(4); // 0 + three 2 MB pieces

      await expect(client.video("../../etc/passwd")).rejects.toMatchObject({ code: "NOT_FOUND" });
    } finally {
      fs.rmSync(file, { force: true });
    }
  });

  it("unpairs from the phone", async () => {
    const { client, record } = await pairedClient();
    await client.unpair();
    expect(service.findDevice(record.deviceId)).toBeNull();
  });
});

describe("what the PC refuses", () => {
  it("a phone removed on the PC is told it's forgotten", async () => {
    const { client, record } = await pairedClient();
    service.removeDevice(record.deviceId);
    await expect(client.sync()).rejects.toMatchObject({ code: "UNKNOWN_DEVICE" });
    expect(client.state.kind).toBe("forgotten");
  });

  it("replayed, stale, tampered and unknown requests", async () => {
    const { record } = await pairedClient();
    const keys = await phone.deriveDeviceKeys(phone.fromBase64(record.deviceKey), record.deviceId);
    const post = (body: Uint8Array, device = record.deviceId) =>
      fetch(`${base}/companion/v1/rpc`, { method: "POST", headers: { "Content-Type": "application/octet-stream", "X-Soundwave-Device": device }, body });
    const sealed = (header: Record<string, unknown>) => phone.seal(keys.c2s, phone.frame(header), phone.aad("rpc", "c2s", record.deviceId));

    const body = await sealed({ op: "hello", args: {}, t: Date.now(), n: phone.randomNonce() });
    expect((await post(body)).status).toBe(200);
    const again = await post(body);
    expect(again.status).toBe(409);
    expect((await again.json()).error.code).toBe("REPLAY");

    const stale = await post(await sealed({ op: "hello", args: {}, t: Date.now() - 60 * 60_000, n: phone.randomNonce() }));
    expect(stale.status).toBe(409);
    expect((await stale.json()).error.code).toBe("CLOCK");

    const tampered = new Uint8Array(await sealed({ op: "hello", args: {}, t: Date.now(), n: phone.randomNonce() }));
    tampered[20]! ^= 0xff;
    expect((await post(tampered)).status).toBe(400);

    expect((await post(body, "d_0000000000000000")).status).toBe(401);
    expect((await fetch(`${base}/api/v1/companion`)).status).toBe(404); // the app's API isn't on this port
  });

  it("the Settings API only answers the app's own window", async () => {
    expect((await request(app).get("/api/v1/companion").set("Host", "127.0.0.1:4000")).status).toBe(200);
    const cross = await request(app).post("/api/v1/companion/pairing").set("Host", "127.0.0.1:4000").set("Origin", "https://evil.example");
    expect(cross.status).toBe(403);

    const bind = config.bindHost;
    (config as { bindHost: string }).bindHost = "127.0.0.1";
    try {
      // DNS rebinding: evil.example resolving to 127.0.0.1 still sends its own Host.
      expect((await request(app).get("/api/v1/companion").set("Host", "evil.example:4000")).status).toBe(403);
      expect((await request(app).get("/api/v1/companion").set("Host", "localhost:4000")).status).toBe(200);
    } finally {
      (config as { bindHost: string }).bindHost = bind;
    }
  });

  it("Settings → Phone: turn on, show a code, turn off", async () => {
    const on = await request(app).post("/api/v1/companion/enabled").set("Host", "127.0.0.1").send({ enabled: true });
    expect(on.status).toBe(200);
    expect(on.body).toMatchObject({ available: true, enabled: true, listening: true });
    const code = await request(app).post("/api/v1/companion/pairing").set("Host", "127.0.0.1");
    expect(code.body.pairing.code).toMatch(/^.{4}-.{4}-.{4}$/);
    expect(code.body.pairing.link).toMatch(/^soundwave:\/\/pair\?/);
    const off = await request(app).post("/api/v1/companion/enabled").set("Host", "127.0.0.1").send({ enabled: false });
    expect(off.body).toMatchObject({ enabled: false, listening: false, pairing: null });
    const noCode = await request(app).post("/api/v1/companion/pairing").set("Host", "127.0.0.1");
    expect(noCode.status).toBe(409);
  });
});

describe("the shared conversation", () => {
  it("Clear in the Command Center starts a new conversation that replaces the phone's copy", async () => {
    const { client } = await pairedClient();
    await client.send("remember this");
    const before = client.conversation!.epoch;
    const res = await request(app)
      .post("/api/v1/companion/conversation/clear")
      .set("Host", "127.0.0.1")
      .send({ messages: [{ id: `${Date.now()}-clr`, sender: "assistant", text: "Conversation cleared.", time: "", at: Date.now() }] });
    expect(res.status).toBe(200);
    expect(res.body.epoch).not.toBe(before);
    await client.sync();
    expect(client.conversation!.epoch).toBe(res.body.epoch);
    expect(client.conversation!.messages.map((m) => m.text)).toEqual(["Conversation cleared."]);
  });

  it("puts COMPANION_HOSTS (a VPN or DNS name) in the pairing code too", () => {
    const hosts = config.companionHosts;
    (config as { companionHosts: string[] }).companionHosts = ["my-pc.tailnet.ts.net", "https://pc.example.com"];
    try {
      const link = phone.parsePairingLink(service.pairingLink(service.startPairing(), 47800, service.pairingAddresses()))!;
      expect(link.hosts).toEqual(expect.arrayContaining(["my-pc.tailnet.ts.net", "https://pc.example.com"]));
    } finally {
      (config as { companionHosts: string[] }).companionHosts = hosts;
    }
  });

  it("merges by id in time order and keeps the newest 100", () => {
    const t0 = 1_700_000_000_000;
    const msg = (i: number) => ({ id: `${t0 + i}-m${i}`, sender: "user" as const, text: `#${i}`, time: "" });
    conversation.mergeIntoConversation([msg(3), msg(1)]);
    conversation.mergeIntoConversation([msg(2), msg(1), { id: "init", sender: "assistant", text: "hi", time: "" }]);
    expect(conversation.getConversation().messages.map((m) => m.text)).toEqual(["hi", "#1", "#2", "#3"]);
    const rev = conversation.getConversation().rev;
    expect(conversation.mergeIntoConversation([msg(2)]).changed).toBe(false);
    expect(conversation.getConversation().rev).toBe(rev);
    conversation.mergeIntoConversation(Array.from({ length: 150 }, (_, i) => msg(100 + i)));
    const all = conversation.getConversation().messages;
    expect(all).toHaveLength(100);
    expect(all.at(-1)!.text).toBe("#249");
  });

  it("posts the outcome of a short the conversation announced — once", async () => {
    const store = await getStore();
    const job = await store.createJob({
      projectId: null,
      userId: "local-user",
      status: "PROCESSING",
      progress: 30,
      settings: { topic: "black holes" } as never,
      outputUrl: null,
      errorMessage: null,
      startedAt: new Date().toISOString(),
      completedAt: null,
    });
    conversation.appendToConversation({
      id: `${Date.now()}-start1`,
      sender: "assistant",
      text: "On it!",
      time: "",
      at: Date.now(),
      jobId: job.id,
      jobState: "started",
      topic: "black holes",
    });
    await new Promise((r) => setTimeout(r, 50));
    emitJob(job.id, { status: "COMPLETED", outputUrl: `/api/v1/export/jobs/${job.id}/download`, youtubeUrl: "https://youtube.com/shorts/abc" });
    const done = conversation.getConversation().messages.filter((m) => m.jobId === job.id && m.jobState === "done");
    expect(done).toHaveLength(1);
    expect(done[0]!.id).toBe(`job-${job.id}-done`);
    expect(done[0]!.text).toContain("published it to YouTube Shorts: https://youtube.com/shorts/abc");

    // The Command Center posting the same outcome (same fixed id) doesn't duplicate it.
    conversation.mergeIntoConversation([{ ...done[0]!, text: "window copy" }]);
    expect(conversation.getConversation().messages.filter((m) => m.jobId === job.id && m.jobState === "done")).toHaveLength(1);
  });

  it("at startup, reports a short that died with the last session", async () => {
    const store = await getStore();
    const job = await store.createJob({
      projectId: null,
      userId: "local-user",
      status: "PROCESSING",
      progress: 50,
      settings: { topic: "sharks" } as never,
      outputUrl: null,
      errorMessage: null,
      startedAt: new Date().toISOString(),
      completedAt: null,
    });
    fs.writeFileSync(
      path.join(DATA, "agent-conversation.json"),
      JSON.stringify({ epoch: "e1", rev: 4, messages: [{ id: `${Date.now()}-s`, sender: "assistant", text: "On it!", time: "", jobId: job.id, jobState: "started", topic: "sharks" }] }),
    );
    conversation.resetConversationForTests();
    conversation.initConversation();
    await vi.waitFor(() => {
      const failed = conversation.getConversation().messages.find((m) => m.id === `job-${job.id}-failed`);
      expect(failed?.text).toMatch(/closed before it finished/);
    });
  });
});

describe("the phone client's connection handling", () => {
  it("goes offline when the PC closes, and comes back when it reopens", async () => {
    const { client, port } = await pairedClient();
    client.start();
    await listener.stopListener();
    await vi.waitFor(() => expect(client.state.kind).toBe("offline"), { timeout: 8000 });
    await listener.startListener({ host: "127.0.0.1", port });
    client.retryNow();
    await vi.waitFor(() => expect(client.state.kind).toBe("online"), { timeout: 8000 });
    client.stop();
  });

  it("surfaces CompanionError codes for the UI", () => {
    const e = new CompanionError("OFFLINE", "x");
    expect(e).toBeInstanceOf(Error);
    expect(e.code).toBe("OFFLINE");
  });
});

// The file-chat tab over HTTP: uploading a file, asking about it, the answer
// streaming back, chats and notebooks surviving a restart. Gemini is the fake
// on loopback (tests/helpers/fakeGoogle) — nothing here touches the internet.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { startFakeGoogle, sseText, type FakeGoogle } from "./helpers/fakeGoogle.js";

// The tab is the desktop app's own window talking to its own PC — and this must
// be set before config.ts is imported, hence vi.hoisted (the same reason
// tests/setup.ts avoids importing the app).
vi.hoisted(() => {
  process.env.DESKTOP_APP = "1";
  process.env.DATA_DIR = process.env.DATA_DIR ?? "/tmp/soundwave-test-data";
});

const DATA_DIR = process.env.DATA_DIR;
let app: ReturnType<typeof import("../src/app.js").createApp>;
let fake: FakeGoogle;

/** A one-page PDF with a text layer, compressed the way real writers do it. */
function makePdf(lines: string[]): Buffer {
  const content = zlib.deflateSync(Buffer.from(`BT /F1 12 Tf 72 700 Td ${lines.map((l) => `(${l}) Tj T*`).join(" ")} ET`, "latin1"));
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>",
    `<< /Length ${content.length} /Filter /FlateDecode >>\nstream\n${content.toString("latin1")}\nendstream`,
  ];
  let out = "%PDF-1.4\n";
  objects.forEach((body, index) => {
    out += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  return Buffer.from(`${out}trailer\n<< /Size 4 /Root 1 0 R >>\n%%EOF\n`, "latin1");
}

const local = (req: request.Test) => req.set("Host", "127.0.0.1");

/** Read an SSE body into the events it carried. */
function events(raw: string): Array<Record<string, unknown>> {
  return raw
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => JSON.parse(line.slice(5).trim()) as Record<string, unknown>);
}

beforeAll(async () => {
  fake = await startFakeGoogle();
  const { config } = await import("../src/config.js");
  const { useFakeGoogle } = await import("./helpers/fakeGoogle.js");
  config.geminiApiKey = "test-key";
  useFakeGoogle(config, fake);
  const { createApp } = await import("../src/app.js");
  app = createApp();
});

afterAll(async () => {
  await fake.close();
});

const brain = await import("../src/lib/brain/settings.js");
const files = await import("../src/lib/geminiFiles.js");
const chats = await import("../src/lib/geminiChats.js");
const notebooks = await import("../src/lib/notebooks.js");

beforeEach(() => {
  fake.reset();
  brain.resetBrainSettingsForTests();
  files.resetChatFilesForTests();
  chats.resetGeminiChatsForTests();
  notebooks.resetNotebooksForTests();
  for (const name of ["brain.json", "gemini-chats.json", "notebooks.json", path.join("chat-files", "index.json")]) {
    try {
      fs.rmSync(path.join(DATA_DIR, name), { force: true });
    } catch {
      /* nothing saved */
    }
  }
});

describe("status", () => {
  it("says whether a key is set, and what is stored", async () => {
    const res = await local(request(app).get("/api/v1/gemini"));
    expect(res.status).toBe(200);
    expect(res.body.ready).toBe(true); // the fake key this file set up
    expect(res.body.hasKey).toBe(true);
    expect(res.body.model).toBeTruthy();
    expect(res.body.files).toBe(0);
    expect(res.body.bytes).toBe(0);
    expect(res.body.filesPerQuestion).toBeGreaterThan(0);

    // Without a key the tab still opens (files can be dropped in) but not as ready.
    const { config } = await import("../src/config.js");
    const key = config.geminiApiKey;
    config.geminiApiKey = "";
    try {
      const bare = await local(request(app).get("/api/v1/gemini"));
      expect(bare.body.ready).toBe(false);
      expect(bare.body.hasKey).toBe(false);
    } finally {
      config.geminiApiKey = key;
    }
  });

  it("is not available to another site's window", async () => {
    const res = await request(app).get("/api/v1/gemini").set("Host", "127.0.0.1").set("Origin", "https://evil.example");
    expect(res.status).toBe(403);
  });
});

describe("dropping a file in", () => {
  it("reads a text file here and reports what it read", async () => {
    const res = await local(request(app).post("/api/v1/gemini/files").attach("file", Buffer.from("Q3 revenue: 1.2M\nQ4 target: 1.5M\n"), "numbers.csv"));
    expect(res.status).toBe(201);
    expect(res.body.file).toMatchObject({ name: "numbers.csv", kind: "text", mime: "text/csv" });
    expect(res.body.file.size).toMatch(/B$/);
    expect(res.body.file.url).toBe(`/api/v1/gemini/files/${res.body.file.id}`);
    expect(res.body.file.previewable).toBe(false);
  });

  it("reads the text layer out of a PDF", async () => {
    const pdf = makePdf(["Quarterly report", "Revenue grew eighteen percent", "Costs fell by nine percent"]);
    const res = await local(request(app).post("/api/v1/gemini/files").attach("file", pdf, "report.pdf"));
    expect(res.status).toBe(201);
    expect(res.body.file).toMatchObject({ kind: "pdf", mime: "application/pdf" });
    const stored = files.findChatFile(res.body.file.id);
    expect(stored?.chars ?? 0).toBeGreaterThan(20);
    expect(files.chatFileText(res.body.file.id)).toContain("Revenue grew eighteen percent");
  });

  it("keeps a photo for Gemini, with a preview, and never pretends to read it", async () => {
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 3)]);
    const res = await local(request(app).post("/api/v1/gemini/files").attach("file", png, "whiteboard.png"));
    expect(res.status).toBe(201);
    expect(res.body.file).toMatchObject({ kind: "image", previewable: true });
    const raw = await local(request(app).get(`/api/v1/gemini/files/${res.body.file.id}`));
    expect(raw.status).toBe(200);
    expect(raw.headers["content-type"]).toContain("image/png");
  });

  it("serves the file, and forgets it on request", async () => {
    const created = await local(request(app).post("/api/v1/gemini/files").attach("file", Buffer.from("hello"), "hello.txt"));
    const id = created.body.file.id as string;
    const raw = await local(request(app).get(`/api/v1/gemini/files/${id}`));
    expect(raw.status).toBe(200);
    expect(raw.text).toBe("hello");
    expect((await local(request(app).delete(`/api/v1/gemini/files/${id}`))).status).toBe(200);
    expect((await local(request(app).get(`/api/v1/gemini/files/${id}`))).status).toBe(404);
  });

  it("refuses an empty file and an unknown id", async () => {
    expect((await local(request(app).post("/api/v1/gemini/files").attach("file", Buffer.alloc(0), "empty.txt"))).status).toBe(400);
    expect((await local(request(app).get("/api/v1/gemini/files/not-a-file"))).status).toBe(404);
  });
});

describe("asking about a file", () => {
  async function upload(body: Buffer, name: string): Promise<string> {
    const res = await local(request(app).post("/api/v1/gemini/files").attach("file", body, name));
    return res.body.file.id as string;
  }

  it("streams the answer and stores both sides of the conversation", async () => {
    fake.streams.push(sseText(["Revenue ", "**grew 18%**", " in Q3."]));
    const created = await local(request(app).post("/api/v1/gemini/chats").send({}));
    const chatId = created.body.chat.id as string;
    const fileId = await upload(Buffer.from("Q3 revenue grew 18 percent to 1.2M."), "q3.txt");

    const asked = await local(request(app).post(`/api/v1/gemini/chats/${chatId}/ask`).send({ question: "How did Q3 go?", fileIds: [fileId] }));
    expect(asked.status).toBe(200);
    const streamed = events(asked.text);
    expect(streamed[0]?.type).toBe("question");
    expect(streamed.some((e) => e.type === "delta" && e.text === "**grew 18%**")).toBe(true);
    const done = streamed.find((e) => e.type === "done");
    expect((done?.message as { text: string }).text).toBe("Revenue **grew 18%** in Q3.");

    // What was sent to Gemini: the file's text, and the formatting instruction.
    const call = fake.seen.find((s) => s.path.includes(":streamGenerateContent"));
    expect(call).toBeTruthy();
    const requestBody = call!.body as { contents: Array<{ parts: Array<{ text?: string }> }>; systemInstruction: { parts: Array<{ text: string }> } };
    const allText = JSON.stringify(requestBody);
    expect(allText).toContain("Q3 revenue grew 18 percent");
    expect(requestBody.systemInstruction.parts[0]!.text).toContain("Markdown");
    expect(allText).toContain("How did Q3 go?");

    // The chat remembers everything, and titled itself after the question.
    const stored = await local(request(app).get(`/api/v1/gemini/chats/${chatId}`));
    expect(stored.body.chat.title).toBe("How did Q3 go?");
    expect(stored.body.chat.messages.map((m: { role: string }) => m.role)).toEqual(["user", "model"]);
    expect(stored.body.chat.messages[0].files[0]).toMatchObject({ name: "q3.txt", method: "read-here" });
    expect(stored.body.chat.messages[1].model).toBeTruthy();
  });

  it("sends a photo to Gemini's File API and refers to it by URI", async () => {
    fake.streams.push(sseText(["It's a whiteboard."]));
    const chat = await local(request(app).post("/api/v1/gemini/chats").send({}));
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(128, 9)]);
    const fileId = await upload(png, "board.png");

    const asked = await local(request(app).post(`/api/v1/gemini/chats/${chat.body.chat.id}/ask`).send({ question: "What's on this?", fileIds: [fileId] }));
    expect(asked.status).toBe(200);
    expect(fake.geminiUploads).toHaveLength(1);
    expect(fake.geminiUploads[0]).toMatchObject({ displayName: "board.png", mimeType: "image/png" });

    const call = fake.seen.find((s) => s.path.includes(":streamGenerateContent"))!;
    const requestBody = call.body as { contents: Array<{ parts: Array<Record<string, unknown>> }> };
    const parts = requestBody.contents.flatMap((c) => c.parts);
    expect(parts.some((p) => (p.fileData as { fileUri?: string } | undefined)?.fileUri === "https://files.test/fake-1")).toBe(true);

    // A second question re-uses Google's copy instead of uploading again.
    fake.streams.push(sseText(["Still a whiteboard."]));
    await local(request(app).post(`/api/v1/gemini/chats/${chat.body.chat.id}/ask`).send({ question: "And now?", fileIds: [fileId] }));
    expect(fake.geminiUploads).toHaveLength(1);
  });

  it("tells the model when a file could not be read, instead of saying it is empty", async () => {
    fake.streams.push(sseText(["I can't read that one."]));
    // Gemini refuses the bytes and nothing here can read them either: the answer
    // must be able to say that, not guess the file is empty.
    fake.uploadFailure = { status: 400, body: { error: { code: 400, message: "Unsupported MIME type", status: "INVALID_ARGUMENT" } } };
    const chat = await local(request(app).post("/api/v1/gemini/chats").send({}));
    const fileId = await upload(Buffer.alloc(4096, 7), "mystery.bin");
    const asked = await local(request(app).post(`/api/v1/gemini/chats/${chat.body.chat.id}/ask`).send({ question: "What's in it?", fileIds: [fileId] }));
    expect(asked.status).toBe(200);
    const call = fake.seen.find((s) => s.path.includes(":streamGenerateContent"))!;
    const body = JSON.stringify(call.body);
    expect(body).toContain("could not be read");
    expect(body).toContain("mystery.bin");
    // And the chat records how that file was handled.
    const stored = await local(request(app).get(`/api/v1/gemini/chats/${chat.body.chat.id}`));
    expect(stored.body.chat.messages[0].files[0].note).toMatch(/couldn't be sent to Gemini/);
  });

  it("reports a Gemini failure in the stream and keeps the question", async () => {
    fake.gemini.push(() => ({ status: 429, body: { error: { code: 429, message: "Quota exceeded", status: "RESOURCE_EXHAUSTED" } } }));
    const chat = await local(request(app).post("/api/v1/gemini/chats").send({}));
    const asked = await local(request(app).post(`/api/v1/gemini/chats/${chat.body.chat.id}/ask`).send({ question: "Anyone there?" }));
    const streamed = events(asked.text);
    const failure = streamed.find((e) => e.type === "error");
    expect(failure).toBeTruthy();
    expect(String(failure?.message)).toMatch(/quota|limit/i);
    const stored = await local(request(app).get(`/api/v1/gemini/chats/${chat.body.chat.id}`));
    expect(stored.body.chat.messages).toHaveLength(1); // the question remains
    expect(stored.body.chat.messages[0].role).toBe("user");
  });

  it("says what is missing when no key is set", async () => {
    const { config } = await import("../src/config.js");
    const key = config.geminiApiKey;
    config.geminiApiKey = "";
    try {
      const chat = await local(request(app).post("/api/v1/gemini/chats").send({}));
      const res = await local(request(app).post(`/api/v1/gemini/chats/${chat.body.chat.id}/ask`).send({ question: "Hello?" }));
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("NO_KEY");
      expect(res.body.error.message).toMatch(/Settings → Brain/);
    } finally {
      config.geminiApiKey = key;
    }
  });

  it("refuses an empty question and an unknown chat", async () => {
    const chat = await local(request(app).post("/api/v1/gemini/chats").send({}));
    expect((await local(request(app).post(`/api/v1/gemini/chats/${chat.body.chat.id}/ask`).send({ question: "   " }))).status).toBe(400);
    expect((await local(request(app).post("/api/v1/gemini/chats/nope/ask").send({ question: "hi" }))).status).toBe(404);
  });
});

describe("chats", () => {
  it("lists, renames and deletes them", async () => {
    const first = await local(request(app).post("/api/v1/gemini/chats").send({}));
    expect(first.body.chat.title).toBe("New chat");
    const second = await local(request(app).post("/api/v1/gemini/chats").send({ title: "Reading list" }));
    const listRes = await local(request(app).get("/api/v1/gemini/chats"));
    expect(listRes.body.chats).toHaveLength(2);

    const renamed = await local(request(app).patch(`/api/v1/gemini/chats/${first.body.chat.id}`).send({ title: "Q3 numbers" }));
    expect(renamed.body.chat.title).toBe("Q3 numbers");
    expect((await local(request(app).delete(`/api/v1/gemini/chats/${second.body.chat.id}`))).status).toBe(200);
    expect((await local(request(app).get("/api/v1/gemini/chats"))).body.chats).toHaveLength(1);
    expect((await local(request(app).delete("/api/v1/gemini/chats/nope"))).status).toBe(404);
  });

  it("titles a chat from its first question, and only once", async () => {
    fake.streams.push(sseText(["First answer."]));
    fake.streams.push(sseText(["Second answer."]));
    const chat = await local(request(app).post("/api/v1/gemini/chats").send({}));
    await local(request(app).post(`/api/v1/gemini/chats/${chat.body.chat.id}/ask`).send({ question: "**Summarise** the attached contract, please." }));
    const after = await local(request(app).get(`/api/v1/gemini/chats/${chat.body.chat.id}`));
    expect(after.body.chat.title).toBe("Summarise the attached contract, please.");
    await local(request(app).post(`/api/v1/gemini/chats/${chat.body.chat.id}/ask`).send({ question: "And the second page?" }));
    const later = await local(request(app).get(`/api/v1/gemini/chats/${chat.body.chat.id}`));
    expect(later.body.chat.title).toBe("Summarise the attached contract, please.");
    expect(later.body.chat.messages).toHaveLength(4);
  });

  it("sends earlier turns back to the model", async () => {
    fake.streams.push(sseText(["It was 18 percent."]));
    fake.streams.push(sseText(["Costs fell by nine."]));
    const chat = await local(request(app).post("/api/v1/gemini/chats").send({}));
    const id = chat.body.chat.id as string;
    await local(request(app).post(`/api/v1/gemini/chats/${id}/ask`).send({ question: "How much did revenue grow?" }));
    await local(request(app).post(`/api/v1/gemini/chats/${id}/ask`).send({ question: "And costs?" }));
    const calls = fake.seen.filter((s) => s.path.includes(":streamGenerateContent"));
    const last = calls.at(-1)!.body as { contents: Array<{ role: string; parts: Array<{ text?: string }> }> };
    expect(last.contents.map((c) => c.role)).toEqual(["user", "model", "user"]);
    expect(JSON.stringify(last)).toContain("How much did revenue grow?");
  });
});

describe("notebooks", () => {
  it("holds sources and notes, and every question in it sees both", async () => {
    fake.streams.push(sseText(["The target is 1.5M."]));
    const fileRes = await local(request(app).post("/api/v1/gemini/files").attach("file", Buffer.from("Q4 target: 1.5M\n"), "targets.txt"));
    const created = await local(request(app).post("/api/v1/gemini/notebooks").send({ name: "  Q4   planning  " }));
    expect(created.body.notebook.name).toBe("Q4 planning");
    const notebookId = created.body.notebook.id as string;

    const withSource = await local(request(app).post(`/api/v1/gemini/notebooks/${notebookId}/sources`).send({ fileIds: [fileRes.body.file.id] }));
    expect(withSource.status).toBe(201);
    expect(withSource.body.notebook.sources[0]).toMatchObject({ name: "targets.txt", kind: "file" });
    const readLater = await local(request(app).get(`/api/v1/gemini/notebooks/${notebookId}`));
    expect(readLater.body.brief).toMatch(/1 file/);

    const note = await local(request(app).post(`/api/v1/gemini/notebooks/${notebookId}/notes`).send({ text: "We already decided to aim above target." }));
    expect(note.status).toBe(201);
    expect(note.body.notebook.notes).toHaveLength(1);

    // A chat inside the notebook: the source text and the note reach the model.
    const chat = await local(request(app).post("/api/v1/gemini/chats").send({ notebookId }));
    expect(chat.body.chat.notebookId).toBe(notebookId);
    await local(request(app).post(`/api/v1/gemini/chats/${chat.body.chat.id}/ask`).send({ question: "What's the target?" }));
    const call = fake.seen.find((s) => s.path.includes(":streamGenerateContent"))!;
    const body = JSON.stringify(call.body);
    expect(body).toContain("Q4 target: 1.5M");
    expect(body).toContain("aim above target");
    expect(body).toContain("Q4 planning");

    const read = await local(request(app).get(`/api/v1/gemini/notebooks/${notebookId}`));
    expect(read.body.notebook.notes).toHaveLength(1);

    // Removing a note leaves the notebook intact.
    const removed = await local(request(app).delete(`/api/v1/gemini/notebooks/${notebookId}/notes/${read.body.notebook.notes[0].id}`));
    expect(removed.body.notebook.notes).toHaveLength(0);
    expect(removed.body.notebook.sources).toHaveLength(1);
  });

  it("keeps a notebook on disk, so it is there next time", async () => {
    const created = await local(request(app).post("/api/v1/gemini/notebooks").send({ name: "Long reads" }));
    expect(fs.existsSync(path.join(DATA_DIR, "notebooks.json"))).toBe(true);
    notebooks.resetNotebooksForTests();
    const again = await local(request(app).get("/api/v1/gemini/notebooks"));
    expect(again.body.notebooks).toHaveLength(1);
    expect(again.body.notebooks[0]).toMatchObject({ id: created.body.notebook.id, name: "Long reads", sources: 0, notes: 0 });
  });

  it("renames and deletes a notebook, and refuses an unknown one", async () => {
    const created = await local(request(app).post("/api/v1/gemini/notebooks").send({ name: "Old name" }));
    const id = created.body.notebook.id as string;
    expect((await local(request(app).patch(`/api/v1/gemini/notebooks/${id}`).send({ name: "New name" }))).body.notebook.name).toBe("New name");
    expect((await local(request(app).delete(`/api/v1/gemini/notebooks/${id}`))).status).toBe(200);
    expect((await local(request(app).get(`/api/v1/gemini/notebooks/${id}`))).status).toBe(404);
    expect((await local(request(app).post(`/api/v1/gemini/notebooks/${id}/notes`).send({ text: "hi" }))).status).toBe(404);
  });

  it("refuses to add nothing, and refuses an empty note", async () => {
    const created = await local(request(app).post("/api/v1/gemini/notebooks").send({ name: "Empty" }));
    const id = created.body.notebook.id as string;
    const nothing = await local(request(app).post(`/api/v1/gemini/notebooks/${id}/sources`).send({}));
    expect(nothing.status).toBe(400);
    const empty = await local(request(app).post(`/api/v1/gemini/notebooks/${id}/notes`).send({ text: "   \n  " }));
    expect([400, 500]).toContain(empty.status);
  });
});

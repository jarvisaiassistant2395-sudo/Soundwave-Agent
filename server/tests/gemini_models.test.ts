// The pure rules behind the file-chat tab: chat titles, question cleaning,
// what the model is told, how a notebook holds things, and the two pieces of
// wire format the tab depends on (SSE parsing and a multipart upload body).
import { describe, expect, it } from "vitest";
import {
  MAX_MESSAGES_PER_CHAT,
  MAX_QUESTION_CHARS,
  UNTITLED_CHAT,
  appendMessage,
  chatInstruction,
  chatSummary,
  cleanQuestion,
  makeChat,
  methodLabel,
  tidyChatTitle,
  titleAfterQuestion,
  trimMessages,
  type GeminiChat,
} from "../src/lib/brain/core/geminiChats.js";
import {
  MAX_NOTEBOOK_NOTES,
  MAX_NOTEBOOK_SOURCES,
  MAX_NOTE_CHARS,
  addNote,
  addSource,
  cleanNoteText,
  findNotebook,
  makeNotebook,
  notebookBrief,
  notebookContext,
  notebookNativeSources,
  notebookSummary,
  removeNote,
  removeSource,
  renameNotebook,
  tidyNotebookName,
  type Notebook,
  type NotebookSource,
} from "../src/lib/brain/core/notebooks.js";
import { parseSseLine } from "../src/lib/brain/core/gemini.js";
import { multipartFileBody } from "../src/lib/brain/gemini.js";
import { chatSummary as storeSummary } from "../src/lib/geminiChats.js";

const now = "2026-10-06T10:00:00.000Z";
const chat: GeminiChat = makeChat({ id: "c1", now: Date.now() });

const file = (name: string, extra: Partial<NotebookSource> = {}): NotebookSource => ({
  id: `s-${name}`,
  kind: "file",
  name,
  mime: "text/plain",
  bytes: 100,
  addedAt: now,
  ...extra,
});

describe("naming a chat", () => {
  it("takes the first sentence of the question, without the markup", () => {
    expect(tidyChatTitle("**Q3** revenue — what changed?")).toBe("Q3 revenue — what changed?");
    expect(tidyChatTitle("- Summarise [the contract](https://x.test/c). Then list the risks. Extra detail here.")).toBe("Summarise the contract.");
    expect(tidyChatTitle("```\ncode\n```\nWhat does this do?")).toBe("What does this do?");
    expect(tidyChatTitle("")).toBe(UNTITLED_CHAT);
    expect(tidyChatTitle("   \n  ")).toBe(UNTITLED_CHAT);
    expect(tidyChatTitle("x".repeat(120))).toHaveLength(48);
  });

  it("names a new chat once, and never renames one the person is using", () => {
    const fresh = makeChat({ id: "c", now: 1 });
    expect(titleAfterQuestion(fresh, "How did Q3 go?")).toBe("How did Q3 go?");
    const used: GeminiChat = { ...fresh, title: "Q3 numbers", messages: [{ id: "m", role: "user", text: "hi", at: 2 }] };
    expect(titleAfterQuestion(used, "Something else entirely.")).toBe("Q3 numbers");
  });
});

describe("a question and its answer", () => {
  it("cleans a question without eating its shape", () => {
    expect(cleanQuestion("  How\t much?  \n\n\nLine two.\u0000 ")).toBe("How much? \n\nLine two.");
    expect(cleanQuestion("x".repeat(MAX_QUESTION_CHARS + 50))).toHaveLength(MAX_QUESTION_CHARS);
    expect(cleanQuestion("   ")).toBe("");
  });

  it("keeps the tail of a very long chat", () => {
    const messages = Array.from({ length: MAX_MESSAGES_PER_CHAT + 5 }, (_, i) => ({ id: `m${i}`, role: "user" as const, text: `message ${i}`, at: i }));
    const trimmed = trimMessages(messages);
    expect(trimmed).toHaveLength(MAX_MESSAGES_PER_CHAT);
    expect(trimmed.at(-1)!.text).toBe(`message ${MAX_MESSAGES_PER_CHAT + 4}`);
    const grown = appendMessage(chat, { id: "m", role: "user", text: "hi", at: 5 });
    expect(grown.updatedAt).toBe(5);
    expect(grown.messages).toHaveLength(1);
  });

  it("summarises with the last thing said", () => {
    const filled: GeminiChat = { ...chat, messages: [{ id: "m", role: "model", text: "Revenue **grew** 18%.", at: 7 }] };
    expect(chatSummary(filled)).toMatchObject({ id: "c1", title: UNTITLED_CHAT, messages: 1, preview: "Revenue **grew** 18%." });
    expect(storeSummary(filled).preview).toBe("Revenue **grew** 18%.");
  });

  it("insists on a tidy answer, and names the notebook when there is one", () => {
    const plain = chatInstruction();
    expect(plain).toContain("Markdown");
    expect(plain).toContain("**Bold**");
    expect(plain).not.toContain("notebook");
    const withNotebook = chatInstruction({ name: "Q4 planning", brief: "1 file, 2 notes" });
    expect(withNotebook).toContain("Q4 planning");
    expect(withNotebook).toContain("1 file, 2 notes");
    expect(withNotebook).toContain("Prefer what the notebook contains");
  });

  it("describes how a file reached the model", () => {
    expect(methodLabel("read-here")).toBe("read on this PC");
    expect(methodLabel("sent-to-gemini")).toBe("sent to Gemini");
    expect(methodLabel("listened-here")).toBe("listened to on this PC");
  });
});

describe("a notebook", () => {
  it("tidies its name", () => {
    expect(tidyNotebookName("  Q4   planning  ")).toBe("Q4 planning");
    expect(tidyNotebookName("")).toBe("New notebook");
    expect(tidyNotebookName("n".repeat(100))).toHaveLength(60);
    expect(renameNotebook(makeNotebook({ id: "n", name: "a", now }), "  b  ", now).name).toBe("b");
  });

  it("replaces a source dropped in twice, and stays bounded", () => {
    let notebook: Notebook = makeNotebook({ id: "n", now });
    notebook = addSource(notebook, file("report.pdf", { fileId: "f1" }), now);
    notebook = addSource(notebook, file("report.pdf", { fileId: "f1", chars: 500 }), now);
    expect(notebook.sources).toHaveLength(1);
    expect(notebook.sources[0]!.chars).toBe(500);
    notebook = addSource(notebook, file("other.txt", { fileId: "f2" }), now);
    expect(notebook.sources.map((s) => s.name)).toEqual(["other.txt", "report.pdf"]);
    for (let i = 0; i < MAX_NOTEBOOK_SOURCES + 5; i += 1) notebook = addSource(notebook, file(`f${i}.txt`, { fileId: `f${i}` }), now);
    expect(notebook.sources).toHaveLength(MAX_NOTEBOOK_SOURCES);
    expect(removeSource(notebook, notebook.sources[0]!.id, now).sources).toHaveLength(MAX_NOTEBOOK_SOURCES - 1);
  });

  it("keeps notes newest first, shortened rather than refused", () => {
    let notebook: Notebook = makeNotebook({ id: "n", now });
    notebook = addNote(notebook, { id: "a", text: "first", at: now }, now);
    notebook = addNote(notebook, { id: "b", text: "second", at: now }, now);
    expect(notebook.notes.map((n) => n.text)).toEqual(["second", "first"]);
    expect(removeNote(notebook, "a", now).notes.map((n) => n.id)).toEqual(["b"]);
    expect(cleanNoteText("  a\r\n\r\n\r\n\r\nb \u0000 ")).toBe("a\n\nb");
    expect(cleanNoteText("x".repeat(MAX_NOTE_CHARS + 10))).toHaveLength(MAX_NOTE_CHARS);
    for (let i = 0; i < MAX_NOTEBOOK_NOTES + 3; i += 1) notebook = addNote(notebook, { id: `n${i}`, text: `note ${i}`, at: now }, now);
    expect(notebook.notes).toHaveLength(MAX_NOTEBOOK_NOTES);
  });

  it("sends the notes and the readable sources, and not the ones Gemini holds", () => {
    let notebook: Notebook = makeNotebook({ id: "n", name: "Planning", now });
    notebook = addSource(notebook, file("targets.txt", { text: "Q4 target: 1.5M", chars: 15, fileId: "f1" }), now);
    notebook = addSource(notebook, file("scan.pdf", { geminiUri: "https://files.test/1", fileId: "f2" }), now);
    notebook = addNote(notebook, { id: "n1", text: "Aim above target.", at: now }, now);
    const context = notebookContext(notebook);
    expect(context).toContain("Q4 target: 1.5M");
    expect(context).toContain("Aim above target.");
    expect(context).not.toContain("scan.pdf");
    expect(notebookNativeSources(notebook).map((s) => s.name)).toEqual(["scan.pdf"]);
    // A notebook longer than the budget says so instead of silently dropping text.
    const huge = notebookContext(notebook, 40);
    expect(huge).toContain("longer than this");
    expect(notebookSummary(notebook)).toMatchObject({ name: "Planning", sources: 2, notes: 1, sample: "scan.pdf" });
    expect(notebookBrief(notebook)).toBe("2 files, 1 note");
    expect(notebookBrief(makeNotebook({ id: "x", now }))).toBe("nothing yet");
    expect(findNotebook([notebook], "n")?.name).toBe("Planning");
    expect(findNotebook([notebook], "other")).toBeNull();
  });
});

describe("the wire format", () => {
  it("reads one SSE event, and shrugs at anything else", () => {
    expect(parseSseLine('data: {"candidates":[{"content":{"parts":[{"text":"hi"}]}}]}')).toMatchObject({ candidates: [{ content: { parts: [{ text: "hi" }] } }] });
    expect(parseSseLine("data: [DONE]")).toBeNull();
    expect(parseSseLine("event: ping")).toBeNull();
    expect(parseSseLine("data: {not json")).toBeNull();
    expect(parseSseLine("")).toBeNull();
  });

  it("builds a multipart upload body: the metadata part, then the bytes", () => {
    const { body, contentType } = multipartFileBody(Buffer.from("hello bytes"), "text/plain", "greeting.txt");
    const text = body.toString("latin1");
    expect(contentType).toMatch(/^multipart\/related; boundary=/);
    const boundary = contentType.split("boundary=")[1]!;
    expect(text).toContain(`--${boundary}`);
    expect(text).toContain('"displayName":"greeting.txt"');
    expect(text).toContain("Content-Type: text/plain");
    expect(text).toContain("hello bytes");
    expect(text.trimEnd().endsWith(`--${boundary}--`)).toBe(true);
  });
});

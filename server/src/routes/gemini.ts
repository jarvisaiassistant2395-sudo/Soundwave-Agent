// ── The file-chat tab: drop in a file, talk to Gemini ───────────────────────
// Everything the tab needs, in one place:
//
//   GET    /api/v1/gemini                 status: is it usable, which model, what is here
//   POST   /api/v1/gemini/files           upload one file (multipart) → what was read from it
//   GET    /api/v1/gemini/files/:id       the bytes back (image previews, downloads)
//   DELETE /api/v1/gemini/files/:id       forget a file (and Google's copy)
//   GET    /api/v1/gemini/chats           the chat list (newest first)
//   POST   /api/v1/gemini/chats           a new chat, optionally inside a notebook
//   GET    /api/v1/gemini/chats/:id       one chat with its messages
//   PATCH  /api/v1/gemini/chats/:id       rename
//   DELETE /api/v1/gemini/chats/:id       delete, messages and all
//   POST   /api/v1/gemini/chats/:id/ask   ask a question — the answer streams back (SSE)
//   GET    /api/v1/gemini/notebooks       the notebooks, with their counts
//   POST   /api/v1/gemini/notebooks       a new notebook
//   GET    /api/v1/gemini/notebooks/:id   one notebook: sources, notes
//   PATCH  /api/v1/gemini/notebooks/:id   rename
//   DELETE /api/v1/gemini/notebooks/:id   delete
//   POST   /api/v1/gemini/notebooks/:id/sources   add files or a link
//   DELETE /api/v1/gemini/notebooks/:id/sources/:sourceId
//   POST   /api/v1/gemini/notebooks/:id/notes     a note (typed, or pinned from an answer)
//   DELETE /api/v1/gemini/notebooks/:id/notes/:noteId
//
// It is this PC's own feature (the key, the files and the notebooks live here),
// so it is guarded like Settings → Brain: the desktop app's window only.
// The answers stream because that is what makes a chat feel alive; the whole
// answer is stored either way, so history reads the same after a reload.

import { Router } from "express";
import fs from "node:fs";
import multer from "multer";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { ApiError } from "../middleware/error.js";
import { validate } from "../middleware/validate.js";
import { localAppGuard } from "../middleware/localApp.js";
import { uploadLimiter } from "../lib/security.js";
import { config } from "../config.js";
import { defaultEyes } from "../lib/eyes.js";
import {
  MAX_CHAT_FILE_BYTES,
  chatFileText,
  dataPathFor,
  deleteChatFile,
  findChatFile,
  geminiUpload,
  listChatFiles,
  prepareFiles,
  saveChatFile,
} from "../lib/geminiFiles.js";
import {
  appendChatMessage,
  chatSummary,
  createChat,
  deleteChat,
  getChat,
  listChats,
  updateChat,
} from "../lib/geminiChats.js";
import {
  addNotebookNote,
  addNotebookSource,
  createNotebook,
  deleteNotebook,
  loadNotebooks,
  removeNotebookNote,
  removeNotebookSource,
  renameNotebook,
} from "../lib/notebooks.js";
import {
  MAX_FILES_PER_QUESTION,
  appendMessage,
  chatInstruction,
  cleanQuestion,
  methodLabel,
  titleAfterQuestion,
  UNTITLED_CHAT,
  type GeminiAttachment,
  type GeminiMessage,
} from "../lib/brain/core/geminiChats.js";
import {
  MAX_NOTEBOOK_NOTES,
  MAX_NOTEBOOK_SOURCES,
  cleanNoteText,
  notebookBrief,
  notebookContext,
  notebookNativeSources,
  notebookSummary,
  tidyNotebookName,
} from "../lib/brain/core/notebooks.js";
import { activeBrain, noteBrainError, noteBrainOk } from "../lib/brain/settings.js";
import { GeminiError, describeGeminiError, isGemini3, streamContent, type GeminiContent } from "../lib/brain/gemini.js";
import { humanBytes } from "../lib/docText.js";

const router = Router();

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_CHAT_FILE_BYTES } });

const local = localAppGuard(
  () => config.brainSettingsAvailable,
  "The file chat is a desktop app feature — it needs this PC's files and Gemini key.",
);

const gated = [local];

/** ms since epoch, the same field the agent chat uses. */
const now = () => Date.now();

// ── Status ──────────────────────────────────────────────────────────────────

router.get("/", ...gated, (_req, res) => {
  const brain = activeBrain();
  const files = listChatFiles();
  res.json({
    /** Ready to answer: a key is saved. Files can still be dropped in without one. */
    ready: Boolean(brain),
    model: brain?.model ?? "",
    hasKey: Boolean(brain),
    files: files.length,
    /** Bytes the tab keeps on this PC, and how much of that is used. */
    bytes: files.reduce((sum, f) => sum + f.bytes, 0),
    maxBytes: MAX_CHAT_FILE_BYTES,
    filesPerQuestion: MAX_FILES_PER_QUESTION,
    chats: listChats().length,
    notebooks: loadNotebooks().length,
    /** Pages read through the reader service leave the machine — say so once. */
    readerNote: "Links are read on this PC first; a page that refuses is read through an external reader service.",
  });
});

// ── Files ───────────────────────────────────────────────────────────────────

router.post("/files", ...gated, uploadLimiter, upload.single("file"), (req, res, next) => {
  try {
    if (!req.file) throw new ApiError(400, "NO_FILE", "No file was sent.");
    if (!req.file.buffer.length) throw new ApiError(400, "EMPTY_FILE", "That file is empty.");
    const { file } = saveChatFile({ name: req.file.originalname, mime: req.file.mimetype, data: req.file.buffer });
    res.status(201).json({
      file: {
        ...file,
        size: humanBytes(file.bytes),
        /** True when the bytes can be shown (an image) rather than only described. */
        previewable: file.mime.startsWith("image/"),
        url: `/api/v1/gemini/files/${file.id}`,
      },
    });
  } catch (err) {
    next(err);
  }
});

router.get("/files/:id", ...gated, (req, res, next) => {
  try {
    const file = findChatFile(req.params.id ?? "");
    if (!file) throw new ApiError(404, "NOT_FOUND", "That file is not here any more.");
    const dataPath = dataPathFor(file.id);
    if (!fs.existsSync(dataPath)) throw new ApiError(404, "NOT_FOUND", "The stored copy of that file is gone.");
    res.setHeader("Content-Type", file.mime);
    res.setHeader("Content-Disposition", `inline; filename="${file.name.replace(/["\\]/g, "")}"`);
    res.sendFile(dataPath);
  } catch (err) {
    next(err);
  }
});

router.delete("/files/:id", ...gated, (req, res, next) => {
  try {
    const removed = deleteChatFile(req.params.id ?? "");
    if (!removed) throw new ApiError(404, "NOT_FOUND", "That file is not here any more.");
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ── Chats ───────────────────────────────────────────────────────────────────

router.get("/chats", ...gated, (_req, res) => {
  res.json({ chats: listChats().map(chatSummary) });
});

const createChatBody = z.object({ notebookId: z.string().max(80).optional(), title: z.string().max(200).optional() });

router.post("/chats", ...gated, validate({ body: createChatBody }), (req, res, next) => {
  try {
    const body = req.body as z.infer<typeof createChatBody>;
    if (body.notebookId && !loadNotebooks().some((n) => n.id === body.notebookId)) {
      throw new ApiError(404, "NOT_FOUND", "That notebook is gone.");
    }
    const chat = createChat(body.notebookId);
    res.status(201).json({ chat: { ...chat, title: body.title?.trim() ? body.title.trim() : chat.title } });
  } catch (err) {
    next(err);
  }
});

router.get("/chats/:id", ...gated, (req, res, next) => {
  try {
    const chat = getChat(req.params.id ?? "");
    if (!chat) throw new ApiError(404, "NOT_FOUND", "That chat is gone.");
    res.json({ chat });
  } catch (err) {
    next(err);
  }
});

router.patch("/chats/:id", ...gated, validate({ body: z.object({ title: z.string().min(1).max(120), notebookId: z.string().max(80).nullable().optional() }) }), (req, res, next) => {
  try {
    const body = req.body as { title: string; notebookId?: string | null };
    const chat = updateChat(req.params.id ?? "", (current) => ({
      ...current,
      title: body.title.trim() || current.title,
      ...(body.notebookId !== undefined ? { notebookId: body.notebookId } : {}),
      updatedAt: now(),
    }));
    if (!chat) throw new ApiError(404, "NOT_FOUND", "That chat is gone.");
    res.json({ chat });
  } catch (err) {
    next(err);
  }
});

router.delete("/chats/:id", ...gated, (req, res, next) => {
  try {
    if (!deleteChat(req.params.id ?? "")) throw new ApiError(404, "NOT_FOUND", "That chat is gone.");
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ── Asking ──────────────────────────────────────────────────────────────────

const askBody = z.object({
  question: z.string().min(1).max(20_000),
  fileIds: z.array(z.string().max(80)).max(MAX_FILES_PER_QUESTION).optional(),
  notebookId: z.string().max(80).nullable().optional(),
});

/** How many earlier messages go back to the model with a new question. */
const HISTORY_MESSAGES = 12;

function historyFor(messages: GeminiMessage[]): GeminiContent[] {
  return messages
    .filter((m) => m.text.trim() && !m.error)
    .slice(-HISTORY_MESSAGES)
    .map((m) => ({ role: m.role === "model" ? ("model" as const) : ("user" as const), parts: [{ text: m.text }] }));
}

router.post("/chats/:id/ask", ...gated, validate({ body: askBody }), async (req, res, next) => {
  const chat = getChat(req.params.id ?? "");
  if (!chat) return next(new ApiError(404, "NOT_FOUND", "That chat is gone."));
  const body = req.body as z.infer<typeof askBody>;
  const question = cleanQuestion(body.question);
  if (!question) return next(new ApiError(400, "EMPTY_QUESTION", "Ask something about the file."));

  const brain = activeBrain();
  if (!brain) {
    return next(new ApiError(409, "NO_KEY", "Add a Gemini API key in Settings → Brain and I can answer questions about files."));
  }

  // Resolve the notebook (the chat's own, unless this question names another).
  const notebookId = body.notebookId !== undefined ? body.notebookId : (chat.notebookId ?? null);
  const notebook = notebookId ? (loadNotebooks().find((n) => n.id === notebookId) ?? null) : null;

  // What the files turned into: text read here, URIs for Gemini, honest notes.
  let prepared;
  try {
    prepared = await prepareFiles(body.fileIds ?? []);
  } catch (err) {
    return next(err);
  }

  // The question is recorded before the answer, so a failure mid-answer still
  // leaves the conversation as it happened.
  const askedAt = now();
  const userMessage: GeminiMessage = {
    id: randomUUID(),
    role: "user",
    text: question,
    at: askedAt,
    ...(prepared.attachments.length ? { files: prepared.attachments } : {}),
  };
  const title = titleAfterQuestion(chat, question);
  updateChat(chat.id, (current) => ({
    ...appendMessage(current, userMessage),
    title,
    ...(notebookId ? { notebookId } : {}),
  }));

  // Server-sent events: the answer is written as it arrives.
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();
  const send = (payload: Record<string, unknown>) => {
    if (!res.writableEnded) res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };
  send({ type: "question", message: userMessage, title });

  const controller = new AbortController();
  req.on("close", () => controller.abort());
  let stopped = false;
  res.on("close", () => {
    stopped = true;
  });

  const blocks = [...prepared.contextBlocks];
  if (notebook) {
    const context = notebookContext(notebook);
    if (context) blocks.push(context);
  }
  if (blocks.length) {
    send({ type: "context", chars: blocks.reduce((sum, b) => sum + b.length, 0), files: prepared.attachments.map((a) => ({ name: a.name, method: a.method })) });
  }

  const contents: GeminiContent[] = [
    ...historyFor(chat.messages.filter((m) => m.id !== userMessage.id)),
    {
      role: "user",
      parts: [
        // Files Gemini reads itself go first, then the question. Anything that
        // reached neither is named here, so the answer can say so instead of
        // pretending the file was empty.
        ...prepared.fileParts.map((part) => ({ fileData: { fileUri: part.fileUri, mimeType: part.mimeType } })),
        ...(blocks.length ? [{ text: `What I have from the attached material:\n\n${blocks.join("\n\n")}` }] : []),
        { text: question },
      ],
    },
  ];

  // Tell the model about anything it cannot see, so "the file is empty" is never
  // said about a file that simply could not be read. A file Gemini reads itself
  // is visible through its URI; anything with no text and no URI is not.
  const readable = new Set(prepared.fileParts.map((part) => part.name));
  const unreachable = prepared.attachments.filter((a) => !a.chars && !readable.has(a.name));
  const extraNotes = unreachable.length
    ? ["", `These attachments could not be read and have no text: ${unreachable.map((a) => `${a.name} (${a.note ?? "unreadable"})`).join("; ")}. Say so if the question is about them.`]
    : [];
  const nativeNames = notebook ? notebookNativeSources(notebook).map((s) => s.name) : [];

  const startedAt = now();
  let answer = "";
  let failure: GeminiError | null = null;
  try {
    const response = await streamContent({
      apiKey: brain.apiKey,
      model: brain.model,
      purpose: "chat",
      signal: controller.signal,
      shouldStop: () => stopped,
      request: {
        contents,
        systemInstruction: {
          role: "user",
          parts: [
            { text: chatInstruction(notebook ? { name: notebook.name, brief: notebookBrief(notebook) } : null) },
            ...(extraNotes.length ? [{ text: extraNotes.join("\n") }] : []),
            ...(nativeNames.length ? [{ text: `The notebook's own files are attached to every question: ${nativeNames.join(", ")}.` }] : []),
          ],
        },
        generationConfig: {
          maxOutputTokens: 8192,
          ...(isGemini3(brain.model) ? { thinkingConfig: { thinkingLevel: "LOW" as const } } : {}),
        },
      },
      onText: (delta, full) => {
        answer = full;
        send({ type: "delta", text: delta });
      },
    });
    if (!answer.trim()) {
      const visible = response.candidates?.[0]?.content?.parts?.map((p) => (typeof p.text === "string" ? p.text : "")).join("") ?? "";
      answer = visible.trim();
      if (answer) send({ type: "delta", text: answer });
    }
    noteBrainOk(brain.model, now() - startedAt);
  } catch (err) {
    failure = err instanceof GeminiError ? err : new GeminiError("unknown", (err as Error).message);
    noteBrainError(failure, brain.model);
  }

  // A stopped answer is not a lost one: whatever arrived before the person
  // pressed Stop is kept, marked, so the transcript matches what they read.
  const stoppedEarly = (stopped || failure?.kind === "aborted") && answer.trim().length > 0;
  if (failure && !stoppedEarly) {
    const message = describeGeminiError(failure, brain.model, { device: "pc" });
    send({ type: "error", error: failure.kind, message });
    if (!res.writableEnded) res.end();
    return;
  }

  const answered: GeminiMessage = {
    id: randomUUID(),
    role: "model",
    text: stoppedEarly ? `${answer.trimEnd()}\n\n_[Stopped.]_` : answer,
    at: now(),
    model: brain.model,
    elapsedMs: now() - startedAt,
  };
  appendChatMessage(chat.id, answered);
  send({ type: "done", message: answered });
  if (!res.writableEnded) res.end();
});

// ── Notebooks ───────────────────────────────────────────────────────────────

router.get("/notebooks", ...gated, (_req, res) => {
  res.json({ notebooks: loadNotebooks().map(notebookSummary) });
});

router.post("/notebooks", ...gated, validate({ body: z.object({ name: z.string().max(200).optional() }) }), (req, res, next) => {
  try {
    const notebook = createNotebook(tidyNotebookName((req.body as { name?: string }).name));
    res.status(201).json({ notebook, summary: notebookSummary(notebook) });
  } catch (err) {
    next(new ApiError(400, "NOTEBOOK_LIMIT", (err as Error).message));
  }
});

router.get("/notebooks/:id", ...gated, (req, res, next) => {
  try {
    const notebook = loadNotebooks().find((n) => n.id === req.params.id);
    if (!notebook) throw new ApiError(404, "NOT_FOUND", "That notebook is gone.");
    res.json({ notebook, summary: notebookSummary(notebook), brief: notebookBrief(notebook) });
  } catch (err) {
    next(err);
  }
});

router.patch("/notebooks/:id", ...gated, validate({ body: z.object({ name: z.string().min(1).max(120) }) }), (req, res, next) => {
  try {
    const notebook = renameNotebook(req.params.id ?? "", (req.body as { name: string }).name);
    if (!notebook) throw new ApiError(404, "NOT_FOUND", "That notebook is gone.");
    res.json({ notebook, summary: notebookSummary(notebook) });
  } catch (err) {
    next(err);
  }
});

router.delete("/notebooks/:id", ...gated, (req, res, next) => {
  try {
    if (!deleteNotebook(req.params.id ?? "")) throw new ApiError(404, "NOT_FOUND", "That notebook is gone.");
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

const sourceBody = z.object({
  fileIds: z.array(z.string().max(80)).max(MAX_NOTEBOOK_SOURCES).optional(),
  url: z.string().max(2_000).optional(),
  /** What the person calls it, for a source they described by hand. */
  name: z.string().max(200).optional(),
});

router.post("/notebooks/:id/sources", ...gated, validate({ body: sourceBody }), async (req, res, next) => {
  try {
    const notebookId = req.params.id ?? "";
    if (!loadNotebooks().some((n) => n.id === notebookId)) throw new ApiError(404, "NOT_FOUND", "That notebook is gone.");
    const body = req.body as z.infer<typeof sourceBody>;
    const added: string[] = [];

    for (const fileId of body.fileIds ?? []) {
      const file = findChatFile(fileId);
      if (!file) continue;
      const text = chatFileText(fileId);
      let geminiUri = file.geminiUri ?? "";
      let geminiName = file.geminiName ?? "";
      // A file the notebook keeps and this PC cannot read goes to Gemini once,
      // now — not every time a question is asked.
      if (!text.trim() && !geminiUri) {
        try {
          const uploaded = await geminiUpload(file);
          geminiUri = uploaded.geminiUri ?? "";
          geminiName = uploaded.geminiName ?? "";
        } catch {
          /* no key, or Gemini refused: the source is still listed, with a note */
        }
      }
      const source = {
        id: randomUUID(),
        kind: "file" as const,
        name: file.name,
        mime: file.mime,
        bytes: file.bytes,
        addedAt: new Date().toISOString(),
        fileId: file.id,
        ...(text.trim() ? { text, chars: text.length } : {}),
        ...(geminiUri ? { geminiUri, geminiName } : {}),
        note: text.trim() ? `read on this PC (${humanBytes(file.bytes)})` : geminiUri ? "Gemini reads this one itself" : (file.note ?? "no text could be read from this file"),
      };
      addNotebookSource(notebookId, source);
      added.push(source.id);
    }

    if (body.url) {
      const url = body.url.trim();
      const read = await defaultEyes.readPage(url);
      const source = {
        id: randomUUID(),
        kind: "link" as const,
        name: body.name?.trim() || read.title || url,
        mime: "text/markdown",
        bytes: Buffer.byteLength(read.text, "utf8"),
        addedAt: new Date().toISOString(),
        url,
        text: read.text,
        chars: read.text.length,
        note: read.truncated ? "read from the web, up to the size limit" : `read from the web (${read.via})`,
      };
      addNotebookSource(notebookId, source);
      added.push(source.id);
    }

    if (!added.length) throw new ApiError(400, "NOTHING_ADDED", "Give me a file or a link to add.");
    const notebook = loadNotebooks().find((n) => n.id === notebookId)!;
    res.status(201).json({ notebook, summary: notebookSummary(notebook), added });
  } catch (err) {
    if (err instanceof ApiError) return next(err);
    next(new ApiError(400, "SOURCE_FAILED", (err as Error).message));
  }
});

router.delete("/notebooks/:id/sources/:sourceId", ...gated, (req, res, next) => {
  try {
    const notebook = removeNotebookSource(req.params.id ?? "", req.params.sourceId ?? "");
    if (!notebook) throw new ApiError(404, "NOT_FOUND", "That notebook is gone.");
    res.json({ notebook, summary: notebookSummary(notebook) });
  } catch (err) {
    next(err);
  }
});

router.post("/notebooks/:id/notes", ...gated, validate({ body: z.object({ text: z.string().min(1).max(40_000), from: z.object({ chatId: z.string(), messageId: z.string(), question: z.string().optional() }).optional() }) }), (req, res, next) => {
  try {
    const body = req.body as { text: string; from?: { chatId: string; messageId: string; question?: string } };
    const notebook = loadNotebooks().find((n) => n.id === req.params.id);
    if (!notebook) throw new ApiError(404, "NOT_FOUND", "That notebook is gone.");
    if (notebook.notes.length >= MAX_NOTEBOOK_NOTES) throw new ApiError(400, "NOTE_LIMIT", `A notebook holds ${MAX_NOTEBOOK_NOTES} notes — delete one first.`);
    const text = cleanNoteText(body.text);
    if (!text) throw new ApiError(400, "EMPTY_NOTE", "That note is empty.");
    const saved = addNotebookNote(notebook.id, { id: randomUUID(), text, at: new Date().toISOString(), ...(body.from ? { from: body.from } : {}) });
    res.status(201).json({ notebook: saved, summary: saved ? notebookSummary(saved) : null });
  } catch (err) {
    next(err);
  }
});

router.delete("/notebooks/:id/notes/:noteId", ...gated, (req, res, next) => {
  try {
    const notebook = removeNotebookNote(req.params.id ?? "", req.params.noteId ?? "");
    if (!notebook) throw new ApiError(404, "NOT_FOUND", "That notebook is gone.");
    res.json({ notebook, summary: notebookSummary(notebook) });
  } catch (err) {
    next(err);
  }
});

// The tab shows which model answered and how the files were read; nothing here
// needs the raw store, so the exports end at the router.
export default router;
export { UNTITLED_CHAT, methodLabel, type GeminiAttachment };

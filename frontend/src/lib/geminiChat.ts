// ── The file-chat tab's client ──────────────────────────────────────────────
// Everything the page needs to talk to the server: files, chats, notebooks, and
// the ask that streams back. The shapes mirror server/src/lib/brain/core/
// geminiChats.ts and brain/core/notebooks.ts — the server is the source of
// truth and this file only describes what comes back.
//
// The ask is a POST whose body is a stream of server-sent events, read here with
// fetch + a reader (not EventSource, which cannot POST). A half-answer arrives as
// a series of `delta` events and is rendered as it comes; `done` carries the
// message as the server stored it, so the client never has to build one.

export type FileKind = "text" | "document" | "pdf" | "image" | "audio" | "video" | "other";

export interface StoredFile {
  id: string;
  name: string;
  mime: string;
  bytes: number;
  kind: FileKind;
  addedAt: string;
  chars?: number;
  note?: string;
  size: string;
  previewable: boolean;
  url: string;
}

export interface Attachment {
  id: string;
  name: string;
  mime: string;
  bytes: number;
  kind: FileKind;
  method: "read-here" | "sent-to-gemini" | "listened-here";
  chars?: number;
  note?: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "model";
  text: string;
  at: number;
  files?: Attachment[];
  model?: string;
  elapsedMs?: number;
  error?: string;
}

export interface ChatSummary {
  id: string;
  title: string;
  updatedAt: number;
  createdAt: number;
  messages: number;
  notebookId: string | null;
  preview: string;
}

export interface Chat {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
  notebookId?: string | null;
}

export interface NotebookSummary {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  sources: number;
  notes: number;
  sample: string;
}

export interface NotebookSource {
  id: string;
  kind: "file" | "link";
  name: string;
  mime: string;
  bytes: number;
  addedAt: string;
  fileId?: string;
  text?: string;
  chars?: number;
  geminiUri?: string;
  url?: string;
  note?: string;
}

export interface NotebookNote {
  id: string;
  text: string;
  at: string;
  from?: { chatId: string; messageId: string; question?: string };
}

export interface Notebook {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  sources: NotebookSource[];
  notes: NotebookNote[];
}

export interface ChatStatus {
  ready: boolean;
  model: string;
  hasKey: boolean;
  files: number;
  bytes: number;
  maxBytes: number;
  filesPerQuestion: number;
  chats: number;
  notebooks: number;
  readerNote: string;
}

/** The text of an error response, or a plain sentence about the status. */
async function failure(res: Response, what: string): Promise<Error> {
  let message = "";
  try {
    const body = (await res.json()) as { error?: { message?: string } };
    message = body?.error?.message ?? "";
  } catch {
    /* not JSON */
  }
  return new Error(message || `${what} (HTTP ${res.status}).`);
}

const get = async <T>(path: string, what: string): Promise<T> => {
  const res = await fetch(`/api/v1/gemini${path}`);
  if (!res.ok) throw await failure(res, what);
  return (await res.json()) as T;
};

const send = async <T>(path: string, method: "POST" | "PATCH" | "DELETE", body: unknown, what: string): Promise<T> => {
  const res = await fetch(`/api/v1/gemini${path}`, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw await failure(res, what);
  return (await res.json()) as T;
};

// ── Status, files ───────────────────────────────────────────────────────────

export const fetchStatus = (): Promise<ChatStatus> => get<ChatStatus>("", "The file chat is not available");

/** Upload one file and get back what the server made of it. */
export async function uploadFile(file: File, signal?: AbortSignal): Promise<StoredFile> {
  const body = new FormData();
  body.append("file", file, file.name);
  const res = await fetch("/api/v1/gemini/files", { method: "POST", body, signal });
  if (!res.ok) throw await failure(res, `“${file.name}” couldn't be added`);
  const data = (await res.json()) as { file: StoredFile };
  return data.file;
}

export const deleteFile = (id: string): Promise<unknown> => send(`/files/${id}`, "DELETE", undefined, "That file couldn't be removed");

// ── Chats ───────────────────────────────────────────────────────────────────

export const listChats = (): Promise<{ chats: ChatSummary[] }> => get("/chats", "The chat list is not available");
export const createChat = (notebookId?: string | null): Promise<{ chat: Chat }> => send("/chats", "POST", notebookId ? { notebookId } : {}, "A new chat couldn't be started");
export const readChat = (id: string): Promise<{ chat: Chat }> => get(`/chats/${id}`, "That chat couldn't be opened");
export const renameChat = (id: string, title: string): Promise<{ chat: Chat }> => send(`/chats/${id}`, "PATCH", { title }, "That chat couldn't be renamed");
export const deleteChat = (id: string): Promise<unknown> => send(`/chats/${id}`, "DELETE", undefined, "That chat couldn't be deleted");

// ── Notebooks ───────────────────────────────────────────────────────────────

export const listNotebooks = (): Promise<{ notebooks: NotebookSummary[] }> => get("/notebooks", "The notebooks are not available");
export const createNotebook = (name: string): Promise<{ notebook: Notebook; summary: NotebookSummary }> => send("/notebooks", "POST", { name }, "A new notebook couldn't be created");
export const readNotebook = (id: string): Promise<{ notebook: Notebook; summary: NotebookSummary; brief: string }> => get(`/notebooks/${id}`, "That notebook couldn't be opened");
export const renameNotebook = (id: string, name: string): Promise<{ notebook: Notebook }> => send(`/notebooks/${id}`, "PATCH", { name }, "That notebook couldn't be renamed");
export const deleteNotebook = (id: string): Promise<unknown> => send(`/notebooks/${id}`, "DELETE", undefined, "That notebook couldn't be deleted");
export const addNotebookSources = (id: string, body: { fileIds?: string[]; url?: string }): Promise<{ notebook: Notebook; summary: NotebookSummary }> =>
  send(`/notebooks/${id}/sources`, "POST", body, "That source couldn't be added");
export const removeNotebookSource = (id: string, sourceId: string): Promise<{ notebook: Notebook; summary: NotebookSummary }> =>
  send(`/notebooks/${id}/sources/${sourceId}`, "DELETE", undefined, "That source couldn't be removed");
export const addNotebookNote = (id: string, text: string, from?: { chatId: string; messageId: string; question?: string }): Promise<{ notebook: Notebook; summary: NotebookSummary }> =>
  send(`/notebooks/${id}/notes`, "POST", { text, ...(from ? { from } : {}) }, "That note couldn't be saved");
export const removeNotebookNote = (id: string, noteId: string): Promise<{ notebook: Notebook; summary: NotebookSummary }> =>
  send(`/notebooks/${id}/notes/${noteId}`, "DELETE", undefined, "That note couldn't be removed");

// ── Asking ──────────────────────────────────────────────────────────────────

export type AskEvent =
  | { type: "question"; message: ChatMessage; title: string }
  | { type: "context"; chars: number; files: Array<{ name: string; method: Attachment["method"] }> }
  | { type: "delta"; text: string }
  | { type: "done"; message: ChatMessage }
  | { type: "error"; error: string; message: string };

/**
 * Ask one question and stream the answer. `onEvent` is called for every event as
 * it arrives; the promise resolves when the server is done (or the person
 * pressed Stop, which aborts the request).
 */
export async function ask(
  chatId: string,
  body: { question: string; fileIds?: string[]; notebookId?: string | null },
  onEvent: (event: AskEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(`/api/v1/gemini/chats/${chatId}/ask`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question: body.question, ...(body.fileIds?.length ? { fileIds: body.fileIds } : {}), ...(body.notebookId !== undefined ? { notebookId: body.notebookId } : {}) }),
    signal,
  });
  if (!res.ok) throw await failure(res, "The question couldn't be asked");
  if (!res.body) throw new Error("The answer stream couldn't be read.");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index = buffer.indexOf("\n\n");
    while (index >= 0) {
      const event = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      const line = event.split("\n").find((l) => l.startsWith("data:"));
      if (line) {
        try {
          onEvent(JSON.parse(line.slice(5).trim()) as AskEvent);
        } catch {
          /* a half-written event: the next chunk finishes it */
        }
      }
      index = buffer.indexOf("\n\n");
    }
  }
}

// ── Notebooks: sources you keep asking about, and what you learned ──────────
// A notebook is the answer to "I keep coming back to these files". Instead of
// re-attaching the same PDF to every question, the files (and links, and notes)
// live in the notebook, and every question asked inside it is answered against
// all of them at once. Alongside the sources sits the notebook's own record:
// answers worth keeping, pinned from a chat, and notes typed by the person.
//
// Pure rules only — ids and timestamps are passed in, nothing is read or written
// here. The store is lib/notebooks.ts; this file is what makes the shapes
// consistent, and it is what the tests exercise.

export const MAX_NOTEBOOKS = 40;
/** Sources in one notebook. Beyond this the model's context is the limit anyway. */
export const MAX_NOTEBOOK_SOURCES = 40;
export const MAX_NOTEBOOK_NOTES = 300;
/** Characters kept from a single note (a note is a thought, not a document). */
export const MAX_NOTE_CHARS = 8_000;
/** Longest notebook name. */
export const MAX_NOTEBOOK_NAME = 60;
/** Total characters of source text sent to the model for one question. */
export const NOTEBOOK_CONTEXT_MAX_CHARS = 400_000;

export type NotebookSourceKind = "file" | "link";

export interface NotebookSource {
  id: string;
  kind: NotebookSourceKind;
  /** What the person calls it: "Q3 report.pdf", "the pricing page". */
  name: string;
  mime: string;
  bytes: number;
  addedAt: string;
  /** The stored copy on this PC (files only) — see lib/gptFiles.ts. */
  fileId?: string;
  /** The text read from it here, when it could be read here. */
  text?: string;
  chars?: number;
  /** Gemini's own copy of the bytes, when only Gemini could read them. */
  geminiUri?: string;
  geminiName?: string;
  /** For a link: where it came from. */
  url?: string;
  /** A sentence about what was read, or why nothing was. */
  note?: string;
}

export interface NotebookNote {
  id: string;
  text: string;
  at: string;
  /** Where it came from, when it was pinned from an answer. */
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

/**
 * A notebook name: one tidy line, never blank. "  q3   report  " → "q3 report";
 * an empty name becomes "New notebook" (the person can rename it later).
 */
export function tidyNotebookName(raw: unknown): string {
  const text = String(raw ?? "")
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "New notebook";
  return text.length > MAX_NOTEBOOK_NAME ? `${text.slice(0, MAX_NOTEBOOK_NAME - 1).trimEnd()}…` : text;
}

export function makeNotebook(args: { id: string; name?: string; now: string }): Notebook {
  return { id: args.id, name: tidyNotebookName(args.name), createdAt: args.now, updatedAt: args.now, sources: [], notes: [] };
}

export function renameNotebook(notebook: Notebook, name: string, now: string): Notebook {
  return { ...notebook, name: tidyNotebookName(name), updatedAt: now };
}

/**
 * Add a source (or replace the one with the same name — dropping the same file
 * in twice updates it rather than listing it twice). Newest first, capped.
 */
export function addSource(notebook: Notebook, source: NotebookSource, now: string): Notebook {
  const sameFile = (a: NotebookSource) => a.kind === source.kind && (a.fileId && source.fileId ? a.fileId === source.fileId : a.name.toLowerCase() === source.name.toLowerCase());
  const sources = [source, ...notebook.sources.filter((s) => !sameFile(s))].slice(0, MAX_NOTEBOOK_SOURCES);
  return { ...notebook, sources, updatedAt: now };
}

export function removeSource(notebook: Notebook, sourceId: string, now: string): Notebook {
  return { ...notebook, sources: notebook.sources.filter((s) => s.id !== sourceId), updatedAt: now };
}

/** Notes are newest first, and a note is shortened rather than refused. */
export function cleanNoteText(raw: unknown): string {
  const text = String(raw ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text.length > MAX_NOTE_CHARS ? text.slice(0, MAX_NOTE_CHARS) : text;
}

export function addNote(notebook: Notebook, note: NotebookNote, now: string): Notebook {
  const notes = [note, ...notebook.notes].slice(0, MAX_NOTEBOOK_NOTES);
  return { ...notebook, notes, updatedAt: now };
}

export function removeNote(notebook: Notebook, noteId: string, now: string): Notebook {
  return { ...notebook, notes: notebook.notes.filter((n) => n.id !== noteId), updatedAt: now };
}

export function findNotebook(notebooks: Notebook[], id: string): Notebook | null {
  return notebooks.find((n) => n.id === id) ?? null;
}

/** What the sidebar shows for one notebook. */
export function notebookSummary(notebook: Notebook) {
  return {
    id: notebook.id,
    name: notebook.name,
    createdAt: notebook.createdAt,
    updatedAt: notebook.updatedAt,
    sources: notebook.sources.length,
    notes: notebook.notes.length,
    /** The first source's name, for the sub-line. */
    sample: notebook.sources[0]?.name ?? notebook.notes[0]?.text.split("\n")[0]?.slice(0, 60) ?? "",
  };
}

/**
 * The part of a notebook that goes into the model's instructions: its notes
 * and the text of every source that was read here. Sources that live on
 * Google's side are *not* inlined — they are attached to the request as file
 * parts, so the text is not sent twice. Long notebooks are cut at the end, and
 * the cut is admitted in the text so the model knows it is reading a part.
 */
export function notebookContext(notebook: Notebook, maxChars = NOTEBOOK_CONTEXT_MAX_CHARS): string {
  const blocks: string[] = [];
  if (notebook.notes.length) {
    const notes = notebook.notes
      .filter((note) => note.text.trim())
      .map((note) => `- ${note.text.trim()}`)
      .join("\n");
    if (notes) blocks.push(`# Notes in this notebook (written by the person, newest first)\n${notes}`);
  }
  const readable = notebook.sources.filter((source) => source.text && source.text.trim().length > 0);
  if (readable.length) {
    const sheets = readable.map((source) => `# Source: ${source.name}\n${source.text!.trim()}`).join("\n\n");
    blocks.push(sheets);
  }
  let out = blocks.join("\n\n");
  if (out.length > maxChars) out = `${out.slice(0, maxChars)}\n\n[The notebook is longer than this; only the beginning of it is shown here.]`;
  return out;
}

/** The names of the sources that are attached to the request as files instead. */
export function notebookNativeSources(notebook: Notebook): NotebookSource[] {
  return notebook.sources.filter((source) => Boolean(source.geminiUri) && (!source.text || !source.text.trim()));
}

/** Which sources a question actually reaches: nothing, or the whole notebook. */
export function notebookBrief(notebook: Notebook): string {
  const files = notebook.sources.filter((s) => s.kind === "file").length;
  const links = notebook.sources.filter((s) => s.kind === "link").length;
  const parts = [
    files ? `${files} file${files === 1 ? "" : "s"}` : "",
    links ? `${links} link${links === 1 ? "" : "s"}` : "",
    notebook.notes.length ? `${notebook.notes.length} note${notebook.notes.length === 1 ? "" : "s"}` : "",
  ].filter(Boolean);
  return parts.length ? parts.join(", ") : "nothing yet";
}

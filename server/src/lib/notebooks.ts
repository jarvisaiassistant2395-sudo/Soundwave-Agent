// ── Notebooks, saved on this PC ─────────────────────────────────────────────
// DATA_DIR/notebooks.json, the same way brain.json, persona.json and niches.json
// are saved: one machine, one assistant, no account needed, and the file can be
// copied to another PC. Written atomically (a temp file and a rename), so a
// crash mid-save leaves the previous version intact rather than half a file.
//
// The store holds the notebooks; the rules live in brain/core/notebooks.ts.

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "../config.js";
import {
  MAX_NOTEBOOKS,
  addNote as addNoteTo,
  addSource as addSourceTo,
  makeNotebook,
  removeNote as removeNoteFrom,
  removeSource as removeSourceFrom,
  renameNotebook as renameIn,
  type Notebook,
  type NotebookNote,
  type NotebookSource,
} from "./brain/core/notebooks.js";

interface NotebookFile {
  version: number;
  notebooks: Notebook[];
}

export const NOTEBOOKS_VERSION = 1;

/** Kept in step with the file the way the mode and niche stores are. */
let cache: { file: string; mtimeMs: number; notebooks: Notebook[] } | null = null;

function fileFor(): string {
  return path.join(config.dataDir, "notebooks.json");
}

/** One source, cleaned up: only the fields we actually store survive. */
function cleanSource(raw: unknown): NotebookSource | null {
  if (!raw || typeof raw !== "object") return null;
  const source = raw as Record<string, unknown>;
  const id = typeof source.id === "string" && source.id ? source.id : "";
  const name = typeof source.name === "string" ? source.name.slice(0, 200) : "";
  if (!id || !name) return null;
  const kind: NotebookSource["kind"] = source.kind === "link" ? "link" : "file";
  return {
    id,
    kind,
    name,
    mime: typeof source.mime === "string" ? source.mime : "application/octet-stream",
    bytes: Number.isFinite(Number(source.bytes)) ? Number(source.bytes) : 0,
    addedAt: typeof source.addedAt === "string" ? source.addedAt : new Date().toISOString(),
    ...(typeof source.fileId === "string" ? { fileId: source.fileId } : {}),
    ...(typeof source.text === "string" ? { text: source.text } : {}),
    ...(Number.isFinite(Number(source.chars)) ? { chars: Number(source.chars) } : {}),
    ...(typeof source.geminiUri === "string" ? { geminiUri: source.geminiUri } : {}),
    ...(typeof source.geminiName === "string" ? { geminiName: source.geminiName } : {}),
    ...(typeof source.url === "string" ? { url: source.url } : {}),
    ...(typeof source.note === "string" ? { note: source.note } : {}),
  };
}

function cleanNotebook(raw: unknown): Notebook | null {
  if (!raw || typeof raw !== "object") return null;
  const notebook = raw as Record<string, unknown>;
  if (typeof notebook.id !== "string" || !notebook.id) return null;
  const now = new Date().toISOString();
  const sources = Array.isArray(notebook.sources) ? notebook.sources.map(cleanSource).filter((s): s is NotebookSource => Boolean(s)) : [];
  const notes: NotebookNote[] = Array.isArray(notebook.notes)
    ? notebook.notes
        .map((entry): NotebookNote | null => {
          if (!entry || typeof entry !== "object") return null;
          const note = entry as Record<string, unknown>;
          if (typeof note.text !== "string" || !note.text.trim()) return null;
          return {
            id: typeof note.id === "string" && note.id ? note.id : randomUUID(),
            text: note.text.slice(0, 60_000),
            at: typeof note.at === "string" ? note.at : now,
            ...(note.from && typeof note.from === "object" ? { from: note.from as NotebookNote["from"] } : {}),
          };
        })
        .filter((n): n is NotebookNote => Boolean(n))
    : [];
  return {
    id: notebook.id,
    name: typeof notebook.name === "string" && notebook.name.trim() ? notebook.name.slice(0, 200) : "New notebook",
    createdAt: typeof notebook.createdAt === "string" ? notebook.createdAt : now,
    updatedAt: typeof notebook.updatedAt === "string" ? notebook.updatedAt : now,
    sources,
    notes,
  };
}

export function loadNotebooks(): Notebook[] {
  const file = fileFor();
  let mtimeMs = 0;
  try {
    mtimeMs = fs.statSync(file).mtimeMs;
  } catch {
    mtimeMs = 0;
  }
  if (cache?.file === file && cache.mtimeMs === mtimeMs) return cache.notebooks;
  let notebooks: Notebook[] = [];
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as NotebookFile;
    notebooks = Array.isArray(raw?.notebooks) ? raw.notebooks.map(cleanNotebook).filter((n): n is Notebook => Boolean(n)) : [];
  } catch {
    /* first run, or an unreadable file: no notebooks yet */
  }
  cache = { file, mtimeMs, notebooks };
  return notebooks;
}

function save(notebooks: Notebook[]): Notebook[] {
  const file = fileFor();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ version: NOTEBOOKS_VERSION, notebooks } satisfies NotebookFile, null, 2), { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmp, file);
  let mtimeMs = 0;
  try {
    mtimeMs = fs.statSync(file).mtimeMs;
  } catch {
    /* just written */
  }
  cache = { file, mtimeMs, notebooks };
  return notebooks;
}

export const MAX_NOTEBOOKS_PER_PC = MAX_NOTEBOOKS;

export function createNotebook(name: string): Notebook {
  const notebooks = loadNotebooks();
  if (notebooks.length >= MAX_NOTEBOOKS) throw new Error(`There are already ${MAX_NOTEBOOKS} notebooks — delete one first.`);
  const notebook = makeNotebook({ id: randomUUID(), name, now: new Date().toISOString() });
  save([notebook, ...notebooks]);
  return notebook;
}

export function updateNotebook(id: string, change: (notebook: Notebook, now: string) => Notebook): Notebook | null {
  const notebooks = loadNotebooks();
  const found = notebooks.find((n) => n.id === id);
  if (!found) return null;
  const next = change(found, new Date().toISOString());
  save(notebooks.map((n) => (n.id === id ? next : n)));
  return next;
}

export const renameNotebook = (id: string, name: string) => updateNotebook(id, (notebook, now) => renameIn(notebook, name, now));
export const addNotebookSource = (id: string, source: NotebookSource) => updateNotebook(id, (notebook, now) => addSourceTo(notebook, source, now));
export const removeNotebookSource = (id: string, sourceId: string) => updateNotebook(id, (notebook, now) => removeSourceFrom(notebook, sourceId, now));
export const addNotebookNote = (id: string, note: NotebookNote) => updateNotebook(id, (notebook, now) => addNoteTo(notebook, note, now));
export const removeNotebookNote = (id: string, noteId: string) => updateNotebook(id, (notebook, now) => removeNoteFrom(notebook, noteId, now));

export function deleteNotebook(id: string): boolean {
  const notebooks = loadNotebooks();
  if (!notebooks.some((n) => n.id === id)) return false;
  save(notebooks.filter((n) => n.id !== id));
  return true;
}

/** Tests only: forget what is in memory so the next read comes from disk. */
export function resetNotebooksForTests(): void {
  cache = null;
}

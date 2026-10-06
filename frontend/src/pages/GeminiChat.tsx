// ── Chat & files: drop in a file, talk to Gemini ────────────────────────────
// One tab, three things that belong together:
//
//   • a chat: ask about a file and watch the answer being written, formatted the
//     way the Gemini app formats one (headings, bold, tables, code — lib/markdown
//     plus components/gemini/Markdown.tsx);
//   • many of them: the list on the left, each named after its first question,
//     renamed or deleted in place;
//   • notebooks: the files and links you keep coming back to, plus the notes you
//     keep. Every question asked inside one is answered against all of it.
//
// What happens to a dropped file is decided by its kind and the server's
// abilities, and the chip under the question says which: "read on this PC",
// "sent to Gemini", "listened to on this PC". The tab never implies it read
// something it could not.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BookOpen,
  Check,
  FileText,
  Image as ImageIcon,
  Link2,
  Loader2,
  Mic,
  Paperclip,
  Pencil,
  Pin,
  Plus,
  RotateCcw,
  Send,
  Sparkles,
  Square,
  Trash2,
  X,
} from "lucide-react";
import { Markdown, plainTextOf } from "../components/gemini/Markdown";
import { IconButton } from "../components/ui/IconButton";
import { Modal } from "../components/ui/Modal";
import { toast } from "../store/toast";
import { cn } from "../lib/cn";
import {
  addNotebookNote,
  addNotebookSources,
  ask,
  createChat,
  createNotebook,
  deleteChat,
  deleteNotebook,
  listChats,
  listNotebooks,
  readChat,
  readNotebook,
  renameChat,
  renameNotebook,
  removeNotebookNote,
  removeNotebookSource,
  uploadFile,
  type Attachment,
  type Chat,
  type ChatMessage,
  type ChatStatus,
  type ChatSummary,
  type Notebook,
  type NotebookSummary,
  type StoredFile,
} from "../lib/geminiChat";
import { fetchStatus } from "../lib/geminiChat";

const KIND_ICON: Record<string, JSX.Element> = {
  image: <ImageIcon className="h-3.5 w-3.5" />,
  audio: <Mic className="h-3.5 w-3.5" />,
  video: <Paperclip className="h-3.5 w-3.5" />,
  pdf: <FileText className="h-3.5 w-3.5" />,
  document: <FileText className="h-3.5 w-3.5" />,
  text: <FileText className="h-3.5 w-3.5" />,
  other: <Paperclip className="h-3.5 w-3.5" />,
};

/** The icon for a notebook source: a link, a picture, or a document. */
function sourceIcon(source: { kind: "file" | "link"; mime: string }) {
  if (source.kind === "link") return <Link2 className="h-3.5 w-3.5" />;
  if (source.mime.startsWith("image/")) return <ImageIcon className="h-3.5 w-3.5" />;
  if (source.mime.startsWith("audio/")) return <Mic className="h-3.5 w-3.5" />;
  if (source.mime.startsWith("video/")) return <Paperclip className="h-3.5 w-3.5" />;
  return <FileText className="h-3.5 w-3.5" />;
}

const METHOD_LABEL: Record<Attachment["method"], string> = {
  "read-here": "read on this PC",
  "sent-to-gemini": "sent to Gemini",
  "listened-here": "listened to on this PC",
};

function dayLabel(at: number): string {
  const date = new Date(at);
  const today = new Date();
  const yesterday = new Date(today.getTime() - 86_400_000);
  if (date.toDateString() === today.toDateString()) return "Today";
  if (date.toDateString() === yesterday.toDateString()) return "Yesterday";
  return date.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: date.getFullYear() === today.getFullYear() ? undefined : "numeric" });
}

/** A name for a small button that only appears on hover. */
function RowAction({ label, onClick, children, danger = false }: { label: string; onClick: () => void; children: JSX.Element; danger?: boolean }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      className={cn(
        "rounded p-1 text-gray-500 transition-colors hover:bg-white/5",
        danger ? "hover:text-red-400" : "hover:text-gray-200",
      )}
    >
      {children}
    </button>
  );
}

/** A chip: one file, and how it reached the model. */
function FileChip({ file, onRemove }: { file: Attachment | StoredFile; onRemove?: () => void }) {
  const attachment = "method" in file ? file : null;
  const size = "size" in file ? file.size : `${Math.max(1, Math.round(file.bytes / 1024))} KB`;
  const isImage = file.kind === "image";
  return (
    <div className="flex items-center gap-2 rounded-lg border border-white/10 bg-white/[0.03] px-2 py-1.5" title={attachment?.note ?? file.name}>
      {/* A dropped photo shows itself: the point of dropping a photo is looking
          at it with the person, not reading its filename. */}
      {isImage ? (
        <a href={`/api/v1/gemini/files/${file.id}`} target="_blank" rel="noopener noreferrer" className="shrink-0">
          <img src={`/api/v1/gemini/files/${file.id}`} alt={file.name} className="h-9 w-9 rounded object-cover" />
        </a>
      ) : (
        <span className="text-cyan-300">{KIND_ICON[file.kind] ?? KIND_ICON.other}</span>
      )}
      <div className="min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-[12px] text-gray-200">{file.name}</span>
          <span className="shrink-0 text-[10px] text-gray-500">{size}</span>
        </div>
        {attachment && (
          <div className="text-[10px] text-gray-500">
            {METHOD_LABEL[attachment.method]}
            {attachment.chars ? ` · ${attachment.chars.toLocaleString()} characters` : ""}
            {attachment.note ? ` · ${attachment.note}` : ""}
          </div>
        )}
      </div>
      {onRemove && (
        <button type="button" onClick={onRemove} title="Remove" className="ml-1 rounded p-0.5 text-gray-500 hover:text-red-400">
          <X className="h-3 w-3" />
        </button>
      )}
    </div>
  );
}

function MessageView({
  message,
  streaming,
  canPin,
  onPin,
  onRetry,
}: {
  message: ChatMessage;
  streaming: boolean;
  canPin: boolean;
  onPin: () => void;
  onRetry?: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard?.writeText(message.role === "model" ? plainTextOf(message.text) : message.text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  if (message.role === "user") {
    return (
      <div className="flex flex-col items-end gap-1.5">
        {message.files?.length ? (
          <div className="flex max-w-full flex-wrap justify-end gap-1.5">
            {message.files.map((file) => (
              <FileChip key={file.id + file.name} file={file} />
            ))}
          </div>
        ) : null}
        <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-sm border border-white/10 bg-white/[0.06] px-3.5 py-2.5 text-[14.5px] leading-6 text-gray-100">{message.text}</div>
      </div>
    );
  }

  return (
    <div className="group/message">
      <div className="mb-1 flex items-center gap-2 text-[11px] text-gray-500">
        <Sparkles className="h-3.5 w-3.5 text-cyan-400" />
        <span>Gemini</span>
        {message.error ? <span className="text-amber-400">· didn&apos;t answer</span> : null}
        {message.model && !message.error ? <span className="text-gray-600">· {message.model}</span> : null}
      </div>
      {message.error ? (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/[0.06] p-3">
          <p className="text-[13.5px] leading-6 text-amber-100">{message.text}</p>
          {onRetry && (
            <button type="button" onClick={onRetry} className="mt-2 flex items-center gap-1.5 rounded-md border border-amber-500/30 px-2 py-1 text-[11px] text-amber-200 hover:bg-amber-500/10">
              <RotateCcw className="h-3 w-3" /> Try again
            </button>
          )}
        </div>
      ) : (
        <Markdown source={message.text} streaming={streaming} />
      )}
      {!streaming && !message.error && (
        <div className="mt-1 flex items-center gap-1 opacity-0 transition-opacity group-hover/message:opacity-100">
          <button type="button" onClick={copy} className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-gray-500 hover:bg-white/5 hover:text-gray-300">
            {copied ? <Check className="h-3 w-3 text-emerald-400" /> : <FileText className="h-3 w-3" />}
            {copied ? "Copied" : "Copy"}
          </button>
          {canPin && (
            <button type="button" onClick={onPin} className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-gray-500 hover:bg-white/5 hover:text-gray-300" title="Keep this answer in the notebook">
              <Pin className="h-3 w-3" /> Pin to notebook
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export function GeminiChat() {
  const [status, setStatus] = useState<ChatStatus | null>(null);
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [notebooks, setNotebooks] = useState<NotebookSummary[]>([]);
  const [chat, setChat] = useState<Chat | null>(null);
  const [notebook, setNotebook] = useState<Notebook | null>(null);
  const [question, setQuestion] = useState("");
  const [pending, setPending] = useState<StoredFile[]>([]);
  const [uploading, setUploading] = useState(0);
  const [answering, setAnswering] = useState(false);
  const [partial, setPartial] = useState("");
  const [busy, setBusy] = useState(false);
  const [renaming, setRenaming] = useState<{ kind: "chat" | "notebook"; id: string; name: string } | null>(null);
  const [linkFor, setLinkFor] = useState<string | null>(null);
  const [linkUrl, setLinkUrl] = useState("");
  const [noteDraft, setNoteDraft] = useState("");
  const [dragging, setDragging] = useState(false);

  const abort = useRef<AbortController | null>(null);
  const bottom = useRef<HTMLDivElement | null>(null);
  const composing = useRef(false);
  const textarea = useRef<HTMLTextAreaElement | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [state, chatList, notebookList] = await Promise.all([fetchStatus(), listChats(), listNotebooks()]);
      setStatus(state);
      setChats(chatList.chats);
      setNotebooks(notebookList.notebooks);
    } catch (err) {
      toast.error((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Open the newest chat on arrival, so the tab is never an empty shell.
  useEffect(() => {
    if (chat || notebooks.length || !chats.length) return;
    void openChat(chats[0]!.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chats]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: answering ? "auto" : "smooth", block: "end" });
  }, [chat?.messages.length, partial, answering]);

  const openChat = useCallback(async (id: string) => {
    try {
      const { chat: loaded } = await readChat(id);
      setChat(loaded);
      setPartial("");
      if (loaded.notebookId) {
        const { notebook: loadedNotebook } = await readNotebook(loaded.notebookId);
        setNotebook(loadedNotebook);
      } else setNotebook(null);
    } catch (err) {
      toast.error((err as Error).message);
    }
  }, []);

  const openNotebook = useCallback(async (id: string) => {
    try {
      const { notebook: loaded } = await readNotebook(id);
      setNotebook(loaded);
      setChat(null);
      // The notebook's newest chat, if it has one, opens with it.
      const first = chats.find((c) => c.notebookId === id);
      if (first) await openChat(first.id);
    } catch (err) {
      toast.error((err as Error).message);
    }
  }, [chats, openChat]);

  const newChat = useCallback(
    async (intoNotebook?: string | null) => {
      try {
        const { chat: created } = await createChat(intoNotebook ?? null);
        setChat(created);
        setPartial("");
        setChats((current) => [
          { id: created.id, title: created.title, updatedAt: created.updatedAt, createdAt: created.createdAt, messages: 0, notebookId: created.notebookId ?? null, preview: "" },
          ...current,
        ]);
        textarea.current?.focus();
      } catch (err) {
        toast.error((err as Error).message);
      }
    },
    [],
  );

  const dropFiles = useCallback(
    async (files: File[]) => {
      if (!files.length) return;
      setUploading((n) => n + files.length);
      setBusy(true);
      for (const file of files) {
        try {
          const stored = await uploadFile(file);
          if (notebook) {
            // Inside a notebook a dropped file becomes a source, not a one-off:
            // that is the difference between the two halves of the tab.
            const { notebook: updated } = await addNotebookSources(notebook.id, { fileIds: [stored.id] });
            setNotebook(updated);
            await refresh();
            toast.success(`“${stored.name}” added to ${updated.name}`);
          } else {
            setPending((current) => [...current, stored]);
          }
        } catch (err) {
          toast.error((err as Error).message);
        } finally {
          setUploading((n) => Math.max(0, n - 1));
        }
      }
      setBusy(false);
    },
    [notebook, refresh],
  );

  const sendQuestion = useCallback(
    async (text: string, retryOf?: { fileIds: string[] }) => {
      if (!text.trim() || answering) return;
      let target = chat;
      if (!target) {
        try {
          target = (await createChat(notebook?.id ?? null)).chat;
          setChat(target);
        } catch (err) {
          toast.error((err as Error).message);
          return;
        }
      }
      const chatId = target.id;
      const fileIds = retryOf?.fileIds ?? pending.map((file) => file.id);
      setQuestion("");
      setPending([]);
      setPartial("");
      setAnswering(true);
      const controller = new AbortController();
      abort.current = controller;
      let streamed = "";
      try {
        await ask(
          chatId,
          { question: text, fileIds, notebookId: notebook?.id ?? null },
          (event) => {
            if (event.type === "question") {
              setChat((current) => (current && current.id === chatId ? { ...current, title: event.title, messages: [...current.messages, event.message] } : current));
            } else if (event.type === "delta") {
              streamed += event.text;
              setPartial(streamed);
            } else if (event.type === "done") {
              setChat((current) => (current && current.id === chatId ? { ...current, messages: [...current.messages, event.message] } : current));
              setPartial("");
            } else if (event.type === "error") {
              setChat((current) =>
                current && current.id === chatId
                  ? { ...current, messages: [...current.messages, { id: `error-${Date.now()}`, role: "model", text: event.message, at: Date.now(), error: event.error }] }
                  : current,
              );
              setPartial("");
            }
          },
          controller.signal,
        );
      } catch (err) {
        if ((err as Error).name !== "AbortError") toast.error((err as Error).message);
        setPartial("");
      } finally {
        setAnswering(false);
        abort.current = null;
        void refresh();
      }
    },
    [answering, chat, notebook, pending, refresh],
  );

  const stop = () => {
    abort.current?.abort();
    setAnswering(false);
    // Whatever arrived is worth keeping on screen until the next question.
    if (partial.trim()) {
      setChat((current) => (current ? { ...current, messages: [...current.messages, { id: `stopped-${Date.now()}`, role: "model", text: partial, at: Date.now() }] } : current));
    }
    setPartial("");
  };

  const pinAnswer = async (message: ChatMessage) => {
    if (!notebook || !chat) return;
    try {
      const { notebook: updated } = await addNotebookNote(notebook.id, message.text, { chatId: chat.id, messageId: message.id });
      setNotebook(updated);
      await refresh();
      toast.success("Pinned to the notebook");
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  const writeNote = async () => {
    if (!notebook || !noteDraft.trim()) return;
    const text = noteDraft;
    setNoteDraft("");
    try {
      const { notebook: updated } = await addNotebookNote(notebook.id, text);
      setNotebook(updated);
      await refresh();
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  const deleteSource = async (sourceId: string) => {
    if (!notebook) return;
    try {
      const { notebook: updated } = await removeNotebookSource(notebook.id, sourceId);
      setNotebook(updated);
      await refresh();
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  const deleteNote = async (noteId: string) => {
    if (!notebook) return;
    try {
      const { notebook: updated } = await removeNotebookNote(notebook.id, noteId);
      setNotebook(updated);
      await refresh();
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  const chatsForNotebook = useMemo(() => (notebook ? chats.filter((c) => c.notebookId === notebook.id) : []), [chats, notebook]);
  const looseChats = useMemo(() => chats.filter((c) => !c.notebookId), [chats]);
  const grouped = useMemo(() => {
    const groups = new Map<string, ChatSummary[]>();
    for (const item of looseChats) {
      const label = dayLabel(item.updatedAt);
      groups.set(label, [...(groups.get(label) ?? []), item]);
    }
    return [...groups.entries()];
  }, [looseChats]);

  if (!status) {
    return (
      <div className="flex h-full items-center justify-center text-[13px] text-gray-500">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Opening the file chat…
      </div>
    );
  }

  return (
    <div
      className="flex h-full min-h-0 bg-[#05060a]"
      onDragOver={(event) => {
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        void dropFiles([...event.dataTransfer.files]);
      }}
    >
      {/* ── The left column: chats, then notebooks ─────────────────────────── */}
      <aside className="flex w-[260px] shrink-0 flex-col border-r border-[#1A1B21] bg-[#08090c]">
        <div className="flex items-center justify-between gap-2 border-b border-[#1A1B21] p-3">
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 text-[13px] font-semibold text-gray-100">
              <Sparkles className="h-3.5 w-3.5 text-cyan-400" /> Chat &amp; files
            </div>
            <div className="truncate text-[10px] text-gray-500" title={status.model}>
              {status.hasKey ? `Gemini · ${status.model}` : "No Gemini key yet"}
            </div>
          </div>
          <IconButton label="New chat" onClick={() => void newChat(notebook?.id)} tone="cyan">
            <Plus />
          </IconButton>
        </div>

        {!status.hasKey && (
          <div className="border-b border-[#1A1B21] bg-amber-500/[0.06] p-3 text-[11px] leading-5 text-amber-200">
            Files can be dropped in and read on this PC, but answering needs a Gemini key — add one in <span className="font-semibold">Settings → Brain</span>.
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {grouped.map(([label, items]) => (
            <div key={label} className="mb-2">
              <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-gray-600">{label}</div>
              {items.map((item) => (
                <div
                  key={item.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => void openChat(item.id)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") void openChat(item.id);
                  }}
                  className={cn(
                    "group flex cursor-pointer items-center gap-1.5 rounded-lg px-2 py-1.5 text-left transition-colors",
                    chat?.id === item.id ? "bg-white/[0.07] text-gray-100" : "text-gray-400 hover:bg-white/[0.03] hover:text-gray-200",
                  )}
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[12.5px]">{item.title}</div>
                    {item.preview ? <div className="truncate text-[10px] text-gray-600">{item.preview}</div> : null}
                  </div>
                  <div className="flex shrink-0 opacity-0 transition-opacity group-hover:opacity-100">
                    <RowAction label="Rename" onClick={() => setRenaming({ kind: "chat", id: item.id, name: item.title })}>
                      <Pencil className="h-3 w-3" />
                    </RowAction>
                    <RowAction
                      label="Delete"
                      danger
                      onClick={() => {
                        void deleteChat(item.id).then(() => {
                          if (chat?.id === item.id) setChat(null);
                          void refresh();
                        });
                      }}
                    >
                      <Trash2 className="h-3 w-3" />
                    </RowAction>
                  </div>
                </div>
              ))}
            </div>
          ))}

          {!looseChats.length && (
            <div className="px-2 py-3 text-[11px] leading-5 text-gray-600">
              Drop a file in, or ask a question — the chat names itself after what you ask.
            </div>
          )}
        </div>

        <div className="border-t border-[#1A1B21] p-2">
          <div className="flex items-center justify-between px-2 py-1">
            <span className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-gray-500">
              <BookOpen className="h-3 w-3" /> Notebooks
            </span>
            <RowAction label="New notebook" onClick={() => void createNotebook("New notebook").then(({ notebook: made }) => { void refresh(); void openNotebook(made.id); })}>
              <Plus className="h-3.5 w-3.5" />
            </RowAction>
          </div>
          {notebooks.map((item) => (
            <div
              key={item.id}
              role="button"
              tabIndex={0}
              onClick={() => void openNotebook(item.id)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void openNotebook(item.id);
              }}
              className={cn(
                "group flex cursor-pointer items-center gap-1.5 rounded-lg px-2 py-1.5 text-left transition-colors",
                notebook?.id === item.id ? "bg-cyan-500/10 text-cyan-100" : "text-gray-400 hover:bg-white/[0.03] hover:text-gray-200",
              )}
            >
              <BookOpen className="h-3.5 w-3.5 shrink-0 text-cyan-400/80" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[12.5px]">{item.name}</div>
                <div className="text-[10px] text-gray-600">
                  {item.sources} source{item.sources === 1 ? "" : "s"} · {item.notes} note{item.notes === 1 ? "" : "s"}
                </div>
              </div>
              <div className="flex shrink-0 opacity-0 transition-opacity group-hover:opacity-100">
                <RowAction label="Rename" onClick={() => setRenaming({ kind: "notebook", id: item.id, name: item.name })}>
                  <Pencil className="h-3 w-3" />
                </RowAction>
                <RowAction
                  label="Delete notebook"
                  danger
                  onClick={() => {
                    void deleteNotebook(item.id).then(() => {
                      if (notebook?.id === item.id) setNotebook(null);
                      void refresh();
                    });
                  }}
                >
                  <Trash2 className="h-3 w-3" />
                </RowAction>
              </div>
            </div>
          ))}
          {!notebooks.length && <div className="px-2 py-2 text-[10px] leading-4 text-gray-600">Keep the files you come back to in one place.</div>}
        </div>
      </aside>

      {/* ── The conversation ──────────────────────────────────────────────── */}
      <section className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between gap-3 border-b border-[#1A1B21] px-4 py-2.5">
          <div className="flex min-w-0 items-center gap-2">
            {notebook && (
              <span className="flex items-center gap-1.5 rounded-full border border-cyan-500/30 bg-cyan-500/10 px-2 py-0.5 text-[11px] text-cyan-200">
                <BookOpen className="h-3 w-3" /> {notebook.name}
                <button type="button" onClick={() => setNotebook(null)} title="Leave the notebook" className="text-cyan-300/70 hover:text-cyan-100">
                  <X className="h-3 w-3" />
                </button>
              </span>
            )}
            <h1 className="truncate text-[14px] font-semibold text-gray-100">{chat?.title ?? (notebook ? "New chat in this notebook" : "New chat")}</h1>
          </div>
          <div className="flex items-center gap-2 text-[10px] text-gray-500">
            {status.bytes > 0 && <span title="Files this tab keeps on this PC">{Math.round(status.bytes / 1024 / 1024)} MB stored</span>}
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5">
          <div className="mx-auto flex w-full max-w-[760px] flex-col gap-5">
            {/* Inside a notebook, its sources and notes are always in play. */}
            {notebook && (
              <div className="rounded-xl border border-cyan-500/20 bg-cyan-500/[0.04] p-3">
                <div className="mb-2 flex items-center justify-between">
                  <span className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-cyan-200">
                    <BookOpen className="h-3.5 w-3.5" /> {notebook.name}
                  </span>
                  <div className="flex items-center gap-2">
                    <button type="button" className="text-[10px] text-cyan-300 hover:text-cyan-100" onClick={() => void newChat(notebook.id)}>
                      New chat here
                    </button>
                    <button type="button" className="text-[10px] text-cyan-300 hover:text-cyan-100" onClick={() => setLinkFor(notebook.id)}>
                      Add a link
                    </button>
                  </div>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {notebook.sources.map((source) => (
                    <span key={source.id} className="group flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.03] px-2 py-1" title={source.note ?? source.name}>
                      {sourceIcon(source)}
                      <span className="max-w-[220px] truncate text-[11.5px] text-gray-200">{source.name}</span>
                      <span className="text-[10px] text-gray-500">{source.chars ? `${Math.round(source.chars / 1000)}k chars` : source.geminiUri ? "Gemini" : "—"}</span>
                      <button type="button" onClick={() => void deleteSource(source.id)} className="text-gray-600 hover:text-red-400" title="Remove">
                        <X className="h-3 w-3" />
                      </button>
                    </span>
                  ))}
                  {!notebook.sources.length && <span className="text-[11px] text-gray-500">Drop a file in anywhere on this page, or add a link — everything here is available to every question.</span>}
                </div>
                <div className="mt-2 flex items-center gap-1.5 border-t border-cyan-500/10 pt-2">
                  <Pin className="h-3 w-3 shrink-0 text-cyan-400/70" />
                  <input
                    value={noteDraft}
                    onChange={(event) => setNoteDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        void writeNote();
                      }
                    }}
                    placeholder="Write a note — what you know, decided, or must remember…"
                    className="min-w-0 flex-1 bg-transparent text-[11.5px] text-gray-200 outline-none placeholder:text-gray-600"
                  />
                  {noteDraft.trim() && (
                    <button type="button" onClick={() => void writeNote()} className="rounded px-1.5 py-0.5 text-[10px] text-cyan-300 hover:bg-white/5">
                      Add note
                    </button>
                  )}
                </div>
                {notebook.notes.length > 0 && (
                  <div className="mt-1 space-y-1">
                    {notebook.notes.map((note) => (
                      <div key={note.id} className="group flex items-start gap-2 text-[11.5px] leading-5 text-gray-300">
                        <Pin className="mt-0.5 h-3 w-3 shrink-0 text-cyan-400/70" />
                        <span className="min-w-0 flex-1 line-clamp-3">{note.text}</span>
                        <button type="button" onClick={() => void deleteNote(note.id)} className="text-gray-600 opacity-0 transition-opacity hover:text-red-400 group-hover:opacity-100" title="Remove note">
                          <X className="h-3 w-3" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                {chatsForNotebook.length > 1 && (
                  <div className="mt-2 flex flex-wrap gap-1.5 border-t border-cyan-500/10 pt-2">
                    {chatsForNotebook.map((item) => (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => void openChat(item.id)}
                        className={cn("max-w-[220px] truncate rounded-full border px-2 py-0.5 text-[10.5px]", chat?.id === item.id ? "border-cyan-400/40 bg-cyan-500/10 text-cyan-100" : "border-white/10 text-gray-400 hover:text-gray-200")}
                      >
                        {item.title}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}

            {!chat?.messages.length && !answering && (
              <div className="rounded-2xl border border-dashed border-white/10 bg-white/[0.015] p-8 text-center">
                <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-full border border-cyan-500/30 bg-cyan-500/10">
                  <Sparkles className="h-5 w-5 text-cyan-300" />
                </div>
                <h2 className="text-[15px] font-semibold text-gray-100">Drop in a file, or ask anything</h2>
                <p className="mx-auto mt-1 max-w-[440px] text-[12.5px] leading-6 text-gray-500">
                  Text, code, Word, Excel, PowerPoint, EPUB and PDFs are read on this PC. Photos, recordings, videos and scans go to Gemini — each file says which happened.
                </p>
                <div className="mt-4 flex flex-wrap justify-center gap-1.5">
                  {["Summarise this in five bullet points.", "What are the key numbers?", "Turn this into a table.", "What should I do next?"].map((suggestion) => (
                    <button
                      key={suggestion}
                      type="button"
                      onClick={() => void sendQuestion(suggestion)}
                      className="rounded-full border border-white/10 bg-white/[0.03] px-3 py-1 text-[11.5px] text-gray-400 transition-colors hover:border-cyan-500/30 hover:text-cyan-200"
                    >
                      {suggestion}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {chat?.messages.map((message, index) => (
              <MessageView
                key={message.id}
                message={message}
                streaming={false}
                canPin={Boolean(notebook) && message.role === "model" && !message.error}
                onPin={() => void pinAnswer(message)}
                onRetry={
                  message.error && chat.messages[index - 1]?.role === "user"
                    ? () => void sendQuestion(chat.messages[index - 1]!.text, { fileIds: (chat.messages[index - 1]!.files ?? []).map((f) => f.id) })
                    : undefined
                }
              />
            ))}

            {answering && (
              <div className="group/message">
                <div className="mb-1 flex items-center gap-2 text-[11px] text-gray-500">
                  <Sparkles className="h-3.5 w-3.5 text-cyan-400" />
                  <span>Gemini</span>
                  {status.model ? <span className="text-gray-600">· {status.model}</span> : null}
                </div>
                {partial ? <Markdown source={partial} streaming /> : <div className="text-[13px] text-gray-500">Thinking…</div>}
              </div>
            )}
            <div ref={bottom} />
          </div>
        </div>

        {/* ── The composer ──────────────────────────────────────────────── */}
        <div className="border-t border-[#1A1B21] bg-[#08090c] px-4 py-3">
          <div className="mx-auto w-full max-w-[760px]">
            {(pending.length > 0 || uploading > 0) && (
              <div className="mb-2 flex flex-wrap gap-1.5">
                {pending.map((file) => (
                  <FileChip key={file.id} file={file} onRemove={() => setPending((current) => current.filter((f) => f.id !== file.id))} />
                ))}
                {uploading > 0 && (
                  <div className="flex items-center gap-2 rounded-lg border border-white/10 bg-white/[0.03] px-2 py-1.5 text-[12px] text-gray-400">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" /> Adding {uploading} file{uploading === 1 ? "" : "s"}…
                  </div>
                )}
              </div>
            )}
            <div
              className={cn(
                "flex items-end gap-2 rounded-2xl border bg-[#0b0d13] p-2 transition-colors",
                dragging ? "border-cyan-400/60 bg-cyan-500/[0.06]" : "border-white/10 focus-within:border-white/20",
              )}
            >
              <label className="cursor-pointer rounded-lg p-2 text-gray-500 transition-colors hover:bg-white/5 hover:text-gray-300" title={notebook ? "Add a file to the notebook" : "Attach a file"}>
                <Paperclip className="h-4 w-4" />
                <input
                  type="file"
                  multiple
                  className="hidden"
                  onChange={(event) => {
                    void dropFiles([...(event.target.files ?? [])]);
                    event.target.value = "";
                  }}
                />
              </label>
              <textarea
                ref={textarea}
                value={question}
                rows={1}
                placeholder={notebook ? `Ask about ${notebook.name}…` : "Ask about a file, or anything else…"}
                onChange={(event) => {
                  setQuestion(event.target.value);
                  const el = event.target;
                  el.style.height = "auto";
                  el.style.height = `${Math.min(200, el.scrollHeight)}px`;
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey && !composing.current) {
                    event.preventDefault();
                    void sendQuestion(question);
                  }
                }}
                onCompositionStart={() => (composing.current = true)}
                onCompositionEnd={() => (composing.current = false)}
                onPaste={(event) => {
                  const files = [...event.clipboardData.files];
                  if (files.length) {
                    event.preventDefault();
                    void dropFiles(files);
                  }
                }}
                className="max-h-[200px] min-h-[38px] flex-1 resize-none bg-transparent py-2 text-[14px] leading-6 text-gray-100 outline-none placeholder:text-gray-600"
              />
              {answering ? (
                <button type="button" onClick={stop} title="Stop" className="rounded-xl bg-white/10 p-2.5 text-gray-200 hover:bg-white/15">
                  <Square className="h-4 w-4" />
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => void sendQuestion(question)}
                  disabled={!question.trim() || !status.hasKey}
                  title={status.hasKey ? "Send" : "Add a Gemini key in Settings → Brain"}
                  className="rounded-xl bg-cyan-500/90 p-2.5 text-[#04121a] transition-colors hover:bg-cyan-400 disabled:cursor-not-allowed disabled:bg-white/5 disabled:text-gray-600"
                >
                  <Send className="h-4 w-4" />
                </button>
              )}
            </div>
            <div className="mt-1.5 flex items-center justify-between gap-3 text-[10px] text-gray-600">
              <span>Enter to send · Shift+Enter for a new line · drop or paste a file anywhere on this page</span>
              <span className="truncate" title={status.readerNote}>
                {notebook ? `Answers use “${notebook.name}”` : `Read on this PC where possible · ${status.files} file${status.files === 1 ? "" : "s"} stored`}
              </span>
            </div>
          </div>
        </div>
      </section>

      {/* Rename, for both kinds of row. */}
      {renaming && (
        <Modal open onClose={() => setRenaming(null)} title={renaming.kind === "chat" ? "Rename chat" : "Rename notebook"}>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const target = renaming;
              setRenaming(null);
              void (target.kind === "chat" ? renameChat(target.id, target.name) : renameNotebook(target.id, target.name))
                .then(() => refresh())
                .catch((err: Error) => toast.error(err.message));
            }}
            className="space-y-3"
          >
            <input
              autoFocus
              value={renaming.name}
              onChange={(event) => setRenaming({ ...renaming, name: event.target.value })}
              className="w-full rounded-lg border border-white/10 bg-[#0b0d13] px-3 py-2 text-[14px] text-gray-100 outline-none focus:border-cyan-500/40"
            />
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setRenaming(null)} className="rounded-lg px-3 py-1.5 text-[12px] text-gray-400 hover:text-gray-200">
                Cancel
              </button>
              <button type="submit" className="rounded-lg bg-cyan-500/90 px-3 py-1.5 text-[12px] font-medium text-[#04121a] hover:bg-cyan-400">
                Save
              </button>
            </div>
          </form>
        </Modal>
      )}

      {/* A link as a notebook source. */}
      {linkFor && (
        <Modal open onClose={() => setLinkFor(null)} title="Add a link to the notebook">
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const url = linkUrl.trim();
              setLinkFor(null);
              setLinkUrl("");
              if (!url) return;
              setBusy(true);
              void addNotebookSources(linkFor, { url })
                .then(({ notebook: updated }) => {
                  setNotebook(updated);
                  return refresh();
                })
                .catch((err: Error) => toast.error(err.message))
                .finally(() => setBusy(false));
            }}
            className="space-y-3"
          >
            <p className="text-[12px] leading-5 text-gray-500">
              The page is read on this PC first; one that refuses to be read is fetched through the external reader service the agent already uses.
            </p>
            <input
              autoFocus
              value={linkUrl}
              onChange={(event) => setLinkUrl(event.target.value)}
              placeholder="https://…"
              className="w-full rounded-lg border border-white/10 bg-[#0b0d13] px-3 py-2 text-[14px] text-gray-100 outline-none focus:border-cyan-500/40"
            />
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setLinkFor(null)} className="rounded-lg px-3 py-1.5 text-[12px] text-gray-400 hover:text-gray-200">
                Cancel
              </button>
              <button type="submit" disabled={busy} className="flex items-center gap-1.5 rounded-lg bg-cyan-500/90 px-3 py-1.5 text-[12px] font-medium text-[#04121a] hover:bg-cyan-400 disabled:opacity-60">
                {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />} Add
              </button>
            </div>
          </form>
        </Modal>
      )}

      {dragging && (
        <div className="pointer-events-none fixed inset-0 z-40 flex items-center justify-center bg-[#05060a]/70">
          <div className="rounded-2xl border-2 border-dashed border-cyan-400/60 bg-[#0b0d13] px-8 py-6 text-center">
            <Paperclip className="mx-auto mb-2 h-6 w-6 text-cyan-300" />
            <div className="text-[14px] font-medium text-gray-100">{notebook ? `Add to “${notebook.name}”` : "Drop a file in"}</div>
            <div className="mt-1 text-[11.5px] text-gray-500">Text and documents are read here; photos, audio and video go to Gemini.</div>
          </div>
        </div>
      )}
    </div>
  );
}

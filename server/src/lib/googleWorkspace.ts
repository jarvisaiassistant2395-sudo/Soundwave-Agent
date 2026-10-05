// ── The rest of the Google account, read-only (contacts, calendar, drive) ────
// Connecting Gmail also offers contacts, calendar and Drive read access on
// Google's own screen. They are optional: each reader below says "reconnect to
// allow it" when the person didn't grant that one, and nothing else breaks.
//
// These exist so the agent can do what a person means:
//   • "email John that…"     → find_contact("John") resolves the address
//   • "what's on tomorrow?"  → list_calendar shows the day, with times and places
//   • "find the invoice PDF" → search_drive returns the file and its link
//
// All three are reads: no Google API here changes anything. Typed, bounded, and
// formatted for a person to read (not raw JSON). The token and error handling
// come from lib/gmail.ts — same OAuth connection, same refresh.

import { config } from "../config.js";
import { gmailService, GmailError, WORKSPACE_SCOPES } from "./gmail.js";

export const MAX_CONTACTS = 5;
export const MAX_EVENTS = 10;
export const MAX_DRIVE_FILES = 8;

export interface ContactHit {
  name: string;
  email: string;
  /** "Work", "Home"… when Google has one. */
  group?: string;
}

export interface CalendarEvent {
  title: string;
  /** Local time the person would read it in: "Mon 6 Oct, 14:00". */
  when: string;
  /** ISO start, for the model to do date math with. */
  startsAt: string;
  allDay: boolean;
  location?: string;
  /** How many people are invited, the person included. */
  attendees?: number;
}

export interface DriveFile {
  id: string;
  name: string;
  kind: string;
  modified: string;
  link: string;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** "Mon 6 Oct, 14:00" — a time someone reads out loud, in this PC's timezone. */
export function friendlyWhen(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  const time = `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
  return `${DAYS[at.getDay()]} ${at.getDate()} ${MONTHS[at.getMonth()]}, ${time}`;
}

function clean(value: unknown, max = 300): string {
  return String(value ?? "").replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim().slice(0, max);
}

/** Google's own file kinds, in words: "spreadsheet", "PDF", "document"… */
export function driveKind(mimeType: string): string {
  const type = String(mimeType ?? "").toLowerCase();
  if (!type) return "file";
  if (type.includes("spreadsheet")) return "spreadsheet";
  if (type.includes("presentation")) return "presentation";
  if (type.includes("document")) return "document";
  if (type.includes("pdf")) return "PDF";
  if (type.startsWith("image/")) return "image";
  if (type.startsWith("video/")) return "video";
  if (type.startsWith("audio/")) return "audio";
  if (type.includes("folder")) return "folder";
  if (type.includes("zip") || type.includes("archive")) return "archive";
  return "file";
}

/** The best name Google has for a person (display name, then given+family). */
export function contactName(person: unknown): string {
  const p = person as { names?: Array<{ displayName?: string; givenName?: string; familyName?: string }> };
  const first = Array.isArray(p?.names) ? p.names[0] : undefined;
  if (!first) return "";
  return clean(first.displayName || [first.givenName, first.familyName].filter(Boolean).join(" "), 120);
}

/** Contacts matching a name, most likely first, each with its best email. */
export function mapContacts(payload: unknown): ContactHit[] {
  const results = (payload as { results?: Array<{ person?: unknown }> })?.results;
  const out: ContactHit[] = [];
  for (const entry of Array.isArray(results) ? results : []) {
    const person = entry?.person as { emailAddresses?: Array<{ value?: string; type?: string }> } | undefined;
    const emails = Array.isArray(person?.emailAddresses) ? person.emailAddresses : [];
    const best = emails.find((mail) => typeof mail?.value === "string" && mail.value.includes("@"));
    if (!best?.value) continue;
    const name = contactName(person) || clean(best.value.split("@")[0], 120);
    const group = clean(best.type ?? "", 40);
    out.push({ name, email: clean(best.value, 320), ...(group ? { group } : {}) });
    if (out.length >= MAX_CONTACTS) break;
  }
  return out;
}

/** Calendar items → what the agent says out loud ("standup, Mon 6 Oct, 09:30, Zoom"). */
export function mapEvents(payload: unknown, max = MAX_EVENTS): CalendarEvent[] {
  const items = (payload as { items?: unknown[] })?.items;
  const out: CalendarEvent[] = [];
  for (const raw of Array.isArray(items) ? items : []) {
    const item = raw as {
      summary?: string;
      location?: string;
      start?: { dateTime?: string; date?: string };
      attendees?: unknown[];
      status?: string;
    };
    if (item?.status === "cancelled") continue;
    const startIso = item?.start?.dateTime ?? item?.start?.date ?? "";
    if (!startIso) continue;
    const allDay = !item?.start?.dateTime;
    out.push({
      title: clean(item?.summary, 200) || "(no title)",
      when: allDay ? friendlyWhen(`${startIso}T00:00:00`) : friendlyWhen(startIso),
      startsAt: startIso,
      allDay,
      ...(clean(item?.location, 200) ? { location: clean(item?.location, 200) } : {}),
      ...(Array.isArray(item?.attendees) && item.attendees.length ? { attendees: item.attendees.length } : {}),
    });
    if (out.length >= max) break;
  }
  return out;
}

export function mapDriveFiles(payload: unknown, max = MAX_DRIVE_FILES): DriveFile[] {
  const files = (payload as { files?: unknown[] })?.files;
  const out: DriveFile[] = [];
  for (const raw of Array.isArray(files) ? files : []) {
    const file = raw as { id?: string; name?: string; mimeType?: string; modifiedTime?: string; webViewLink?: string };
    if (!file?.name) continue;
    out.push({
      id: clean(file.id, 200),
      name: clean(file.name, 240),
      kind: driveKind(String(file.mimeType ?? "")),
      modified: clean(file.modifiedTime, 60),
      link: clean(file.webViewLink, 600),
    });
    if (out.length >= max) break;
  }
  return out;
}

/** The three readers. Each checks its own permission and returns plain data. */
export const workspaceService = {
  /** People API: search the person's contacts by name, nickname or address. */
  async findContacts(query: string): Promise<ContactHit[]> {
    const wanted = clean(query, 120);
    if (!wanted) throw new GmailError("Tell me the name to look up in your contacts.", 422, "NO_QUERY");
    await gmailService.requireScope(WORKSPACE_SCOPES[0], "read your contacts");
    const params = new URLSearchParams({ query: wanted, readMask: "names,emailAddresses", pageSize: "10" });
    const payload = await gmailService.googleJson(`${config.peopleApiBase}/v1/people:searchContacts?${params.toString()}`);
    return mapContacts(payload);
  },

  /** Calendar API: the person's next events from their main calendar. */
  async listCalendar(opts: { days?: number; query?: string; now?: Date } = {}): Promise<CalendarEvent[]> {
    const days = Math.min(60, Math.max(1, Math.round(Number(opts.days) || 7)));
    await gmailService.requireScope(WORKSPACE_SCOPES[1], "read your calendar");
    const now = opts.now ?? new Date();
    const from = new Date(now);
    const to = new Date(now.getTime() + days * 86_400_000);
    const params = new URLSearchParams({
      timeMin: from.toISOString(),
      timeMax: to.toISOString(),
      singleEvents: "true",
      orderBy: "startTime",
      maxResults: String(MAX_EVENTS),
    });
    const search = clean(opts.query ?? "", 120);
    if (search) params.set("q", search);
    const payload = await gmailService.googleJson(`${config.calendarApiBase}/calendar/v3/calendars/primary/events?${params.toString()}`);
    return mapEvents(payload);
  },

  /** Drive API: files by name or content type, never trashed. */
  async searchDrive(query: string, limit = MAX_DRIVE_FILES): Promise<DriveFile[]> {
    const wanted = clean(query, 200);
    if (!wanted) throw new GmailError("Tell me what to look for on your Drive.", 422, "NO_QUERY");
    await gmailService.requireScope(WORKSPACE_SCOPES[2], "search your Drive");
    // Only the name and the file's own text are searched: a Drive-wide
    // fullText search is what a person means by "find the…".
    const escaped = wanted.replace(/['\\]/g, " ").replace(/\s+/g, " ");
    const max = Math.min(MAX_DRIVE_FILES, Math.max(1, Math.round(Number(limit) || MAX_DRIVE_FILES)));
    const params = new URLSearchParams({
      q: `(name contains '${escaped}' or fullText contains '${escaped}') and trashed = false`,
      fields: "files(id,name,mimeType,modifiedTime,webViewLink)",
      pageSize: String(max),
      orderBy: "modifiedTime desc",
    });
    const payload = await gmailService.googleJson(`${config.driveApiBase}/drive/v3/files?${params.toString()}`);
    return mapDriveFiles(payload, max);
  },
};

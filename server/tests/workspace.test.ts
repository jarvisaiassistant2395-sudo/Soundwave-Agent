// The rest of the Google account: contacts, Calendar and Drive, read-only.
// These are what make "email John that…" or "find the invoice PDF" work — the
// agent resolves a name to an address, reads the next days of the calendar and
// searches Drive by name or content. All three ride the same OAuth connection
// as Gmail, and each one says so plainly when the person didn't grant it.
// No internet: a fake Google on loopback.
import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.DESKTOP_APP = "1";
  process.env.DATA_DIR = "/tmp/soundwave-workspace-tests";
});

const { config } = await import("../src/config.js");
const { gmailService, GMAIL_SCOPES, WORKSPACE_SCOPES, finishGmailConnect, resetGmailForTests, startGmailConnect } = await import("../src/lib/gmail.js");
const { workspaceService, driveKind, mapContacts, mapEvents } = await import("../src/lib/googleWorkspace.js");
const { youtubeService } = await import("../src/lib/youtube.js");
const { toolsFor } = await import("../src/lib/brain/tools.js");

const seen: string[] = [];
let grantExtras = true;
let contactsAnswer: unknown = { results: [] };
let calendarAnswer: unknown = { items: [] };
let driveAnswer: unknown = { files: [] };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

/** The fake Google: OAuth, the Gmail profile, and the three readers. */
function installFetchStub() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      seen.push(url);
      if (url === config.googleOAuthTokenUrl) {
        return json({
          access_token: "workspace-access",
          refresh_token: "workspace-refresh",
          expires_in: 3600,
          scope: [...GMAIL_SCOPES, ...(grantExtras ? WORKSPACE_SCOPES : []), "openid", "email"].join(" "),
        });
      }
      if (url.includes("/users/me/profile")) return json({ emailAddress: "owner@example.com" });
      if (url.includes("/people/v1/people:searchContacts")) return json(contactsAnswer);
      if (url.includes("/calendar/v3/calendars/primary/events")) return json(calendarAnswer);
      if (url.includes("/drive/v3/files")) return json(driveAnswer);
      return json({ error: { message: `Unhandled fake request ${url}` } }, 404);
    }),
  );
}

beforeEach(() => {
  installFetchStub();
  seen.length = 0;
  grantExtras = true;
  contactsAnswer = { results: [] };
  calendarAnswer = { items: [] };
  driveAnswer = { files: [] };
  fs.rmSync(config.dataDir, { recursive: true, force: true });
  fs.mkdirSync(config.dataDir, { recursive: true });
  youtubeService.saveConfig({ clientId: "workspace-test.apps.googleusercontent.com", clientSecret: "GOCSPX-workspace-test", refreshToken: "" });
  resetGmailForTests();
});

async function connect(grant = true) {
  grantExtras = grant;
  const started = startGmailConnect(47832);
  const state = new URL(started.url).searchParams.get("state")!;
  const result = await finishGmailConnect({ state, code: "authorization-code" });
  expect(result.ok).toBe(true);
}

const contacts = [
  { person: { names: [{ displayName: "John Carter" }], emailAddresses: [{ value: "john.carter@example.com", type: "work" }] } },
  { person: { names: [{ givenName: "Jonathan", familyName: "Carter" }], emailAddresses: [{ value: "jon@example.com" }] } },
  { person: { names: [{ displayName: "No Email" }], emailAddresses: [] } },
];

describe("the Google account beyond Gmail", () => {
  it("finds a contact by name and asks Google only for names and addresses", async () => {
    await connect();
    contactsAnswer = { results: contacts };
    const found = await workspaceService.findContacts("Carter");
    expect(found).toEqual([
      { name: "John Carter", email: "john.carter@example.com", group: "work" },
      { name: "Jonathan Carter", email: "jon@example.com" },
    ]);
    const url = new URL(seen.find((one) => one.includes("searchContacts"))!);
    expect(url.searchParams.get("query")).toBe("Carter");
    expect(url.searchParams.get("readMask")).toBe("names,emailAddresses");
  });

  it("tells the agent to ask for an address when a name isn't found", async () => {
    await connect();
    contactsAnswer = { results: [] };
    const context = { userId: "local-user", desktop: true, platform: "win32", effects: { log: [] as string[] } };
    const tool = toolsFor(context as never).find((item) => item.declaration.name === "find_contact")!;
    const result = await tool.run({ name: "Nobody" }, context as never);
    expect(result).toMatchObject({ found: 0 });
    expect(String(result.reason)).toMatch(/ask the person for the email address/i);
  });

  it("reads the calendar for the next days, with local times", async () => {
    await connect();
    calendarAnswer = {
      items: [
        { summary: "Standup", start: { dateTime: "2026-10-06T09:30:00Z" }, location: "Zoom", attendees: [{}, {}] },
        { summary: "Holiday", start: { date: "2026-10-08" } },
        { status: "cancelled", summary: "Cancelled thing", start: { dateTime: "2026-10-07T10:00:00Z" } },
      ],
    };
    const events = await workspaceService.listCalendar({ days: 3, now: new Date("2026-10-06T08:00:00Z") });
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ title: "Standup", startsAt: "2026-10-06T09:30:00Z", location: "Zoom", attendees: 2, allDay: false });
    expect(events[0]!.when).toMatch(/^[A-Z][a-z]{2} 6 Oct, \d{2}:\d{2}$/);
    expect(events[1]).toMatchObject({ title: "Holiday", allDay: true });
    const url = new URL(seen.find((one) => one.includes("/calendar/v3/"))!);
    expect(url.searchParams.get("singleEvents")).toBe("true");
    expect(url.searchParams.get("orderBy")).toBe("startTime");
    expect(new Date(url.searchParams.get("timeMin")!).toISOString()).toBe("2026-10-06T08:00:00.000Z");
  });

  it("searches Drive by name or content, never trashed, and describes the file kind", async () => {
    await connect();
    driveAnswer = {
      files: [
        { id: "file-1", name: "Invoice March.pdf", mimeType: "application/pdf", modifiedTime: "2026-10-01T10:00:00Z", webViewLink: "https://drive.google.com/file/d/file-1/view" },
        { id: "file-2", name: "March budget", mimeType: "application/vnd.google-apps.spreadsheet", modifiedTime: "2026-09-30T10:00:00Z" },
      ],
    };
    const files = await workspaceService.searchDrive("March");
    expect(files).toMatchObject([
      { id: "file-1", name: "Invoice March.pdf", kind: "PDF" },
      { id: "file-2", name: "March budget", kind: "spreadsheet" },
    ]);
    const url = new URL(seen.find((one) => one.includes("/drive/v3/files"))!);
    expect(url.searchParams.get("q")).toBe("(name contains 'March' or fullText contains 'March') and trashed = false");
    expect(url.searchParams.get("orderBy")).toBe("modifiedTime desc");
    expect(driveKind("application/vnd.google-apps.presentation")).toBe("presentation");
  });

  it("says which permission is missing instead of failing silently", async () => {
    await connect(false); // email allowed, contacts/calendar/drive refused
    expect(gmailService.status().scopes).toEqual({ gmail: true, contacts: false, calendar: false, drive: false });
    await expect(workspaceService.findContacts("Ann")).rejects.toThrow(/permission to read your contacts/i);
    await expect(workspaceService.listCalendar({})).rejects.toThrow(/permission to read your calendar/i);
    await expect(workspaceService.searchDrive("report")).rejects.toThrow(/permission to search your Drive/i);
    // And the tools that need those permissions aren't even offered.
    const names = toolsFor({ userId: "local-user", desktop: true, platform: "win32", effects: { log: [] as string[] } } as never).map((tool) => tool.declaration.name);
    expect(names).not.toContain("find_contact");
    expect(names).not.toContain("list_calendar");
    expect(names).not.toContain("search_drive");
  });

  it("learns the granted permissions from the token refresh, so an old connection needs no reconnect", async () => {
    await connect(false);
    expect(gmailService.status().scopes).toEqual({ gmail: true, contacts: false, calendar: false, drive: false });

    // The person re-consented inside Google (or the project changed): the next
    // refresh says so, and the app picks it up without another sign-in.
    fs.rmSync(`${config.dataDir}/gmail/gmail_config.json`, { force: true });
    await connect(false);
    const file = `${config.dataDir}/gmail/gmail_config.json`;
    const saved = JSON.parse(fs.readFileSync(file, "utf8")) as { accessToken?: string; tokenExpiry?: number; scopes: string[] };
    expect(saved.scopes).toEqual(expect.arrayContaining([...GMAIL_SCOPES]));
    // Expire the token so the service must refresh, with Google now granting extras.
    grantExtras = true;
    fs.writeFileSync(file, JSON.stringify({ ...saved, accessToken: "", tokenExpiry: 0 }), "utf8");
    contactsAnswer = { results: [{ person: { names: [{ displayName: "John Carter" }], emailAddresses: [{ value: "john.carter@example.com" }] } }] };

    expect(await workspaceService.findContacts("Carter")).toHaveLength(1);
    expect(gmailService.status().scopes).toEqual({ gmail: true, contacts: true, calendar: true, drive: true });
  });

  it("reads plain data out of Google's shapes (pure mapping)", () => {
    expect(mapContacts({ results: [] })).toEqual([]);
    expect(mapContacts({ results: [{ person: {} }] })).toEqual([]);
    expect(mapEvents({ items: [{ summary: "A", start: { dateTime: "2026-10-06T09:00:00Z" } }, { summary: "no start" }] })).toHaveLength(1);
  });
});

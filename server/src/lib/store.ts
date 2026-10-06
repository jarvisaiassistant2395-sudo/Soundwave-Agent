import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { config } from "../config.js";
import type { Plan } from "./plans.js";
import { dailyBackup, listBackups, readJsonFile, writeJsonFile } from "./jsonFile.js";

// ── Repository interface ────────────────────────────────────────────────────
// The production deployment implements this with PostgreSQL via Prisma
// (see prisma/schema.prisma + lib/prismaStore.ts). The development/demo build
// uses JsonStore — a file-persisted in-memory store — so the entire stack
// runs without external services. Both implement the exact same contract.

export interface StoredUser {
  id: string;
  /** The Google account's address — the only way in (lib/googleSignIn.ts). */
  email: string;
  name: string;
  avatarUrl: string | null;
  plan: Plan;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  /** When a Founder lifetime was bought. Its presence is what makes it a lifetime. */
  lifetimeSince?: string | null;
  /**
   * When the current subscription began. Absent on subscriptions that predate
   * this field — which is exactly what makes them grandfathered (see
   * routes/billing.ts `grandfatheredPlan`).
   */
  subscriptionStartedAt?: string | null;
  charactersUsedThisMonth: number;
  /** Video processed this month (meters/plans): source length for a clipping
   *  run, finished length for a script-to-short. */
  videoSecondsUsedThisMonth?: number;
  /** Clips finished this month. */
  clipsUsedThisMonth?: number;
  characterResetDate: string;
  totalAudioDurationSeconds: number;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface StoredSession {
  id: string;
  userId: string;
  refreshTokenHash: string;
  deviceInfo: string;
  ipAddress: string;
  lastActiveAt: string;
  /** null = permanent (a signed-in Google account on this PC). */
  expiresAt: string | null;
  createdAt: string;
}

export interface StoredProject {
  id: string;
  userId: string;
  title: string;
  type: "TTS" | "SUBTITLE" | "VIDEO";
  textContent: string;
  voiceId: string;
  voiceSettings: Record<string, unknown>;
  characterCount: number;
  subtitleData: unknown | null;
  subtitleStyle: unknown | null;
  videoBackgroundUrl: string | null;
  audioUrl: string | null;
  exportedVideoUrl: string | null;
  duration: number | null;
  status: "DRAFT" | "PROCESSING" | "COMPLETED" | "FAILED";
  storageType: "LOCAL" | "CLOUD";
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface StoredUsageLog {
  id: string;
  userId: string;
  characterCount: number;
  voiceId: string;
  audioDurationSeconds: number;
  generatedAt: string;
  createdAt: string;
}

export type JobStatus = "QUEUED" | "PROCESSING" | "COMPLETED" | "FAILED";

export interface StoredExportJob {
  id: string;
  projectId: string | null;
  userId: string;
  status: JobStatus;
  progress: number;
  settings: Record<string, unknown>;
  outputUrl: string | null;
  errorMessage: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

export interface StoredApiKey {
  id: string;
  userId: string;
  name: string;
  keyHash: string;
  prefix: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
  revokedAt: string | null;
}

export interface StoredInvoice {
  id: string;
  userId: string;
  stripeInvoiceId: string;
  amount: number;
  currency: string;
  status: string;
  pdfUrl: string | null;
  createdAt: string;
}

export interface DataStore {
  readonly kind: string;
  /**
   * Write anything still in memory to disk now, instead of waiting for the
   * debounce (JsonStore) or the connection pool to get round to it. Called on
   * the way out of the process (lib/../index.ts `shutdown`) — an app that is
   * quit, stopped or restarted must not lose the last thing that happened.
   */
  flush?(): Promise<void> | void;
  // users
  findUserByEmail(email: string): Promise<StoredUser | null>;
  findUserById(id: string): Promise<StoredUser | null>;
  /** The account a Stripe customer belongs to (webhooks carry the customer). */
  findUserByStripeCustomerId(customerId: string): Promise<StoredUser | null>;
  createUser(u: Partial<StoredUser> & { email: string; name: string }): Promise<StoredUser>;
  /** How many accounts already hold a Founder lifetime (the seat cap). */
  countLifetimeUsers(): Promise<number>;
  updateUser(id: string, patch: Partial<StoredUser>): Promise<StoredUser | null>;
  /** Every live account. Used by the expiry sweep and by anything that has to
   *  reason about the whole install (not by request paths). */
  listUsers(): Promise<StoredUser[]>;
  deleteUserSoft(id: string): Promise<void>;
  countUsers(): Promise<number>;
  // sessions
  createSession(s: Omit<StoredSession, "createdAt">): Promise<StoredSession>;
  findSessionByTokenHash(hash: string): Promise<StoredSession | null>;
  findSessionById(id: string): Promise<StoredSession | null>;
  deleteSession(id: string): Promise<void>;
  deleteAllSessionsForUser(userId: string): Promise<void>;
  deleteOtherSessions(userId: string, keepSessionId: string): Promise<void>;
  touchSession(id: string): Promise<void>;
  listSessionsForUser(userId: string): Promise<StoredSession[]>;
  // projects
  createProject(p: Omit<StoredProject, "id" | "createdAt" | "updatedAt" | "deletedAt">): Promise<StoredProject>;
  getProject(id: string, userId: string): Promise<StoredProject | null>;
  listProjects(userId: string): Promise<StoredProject[]>;
  updateProject(id: string, userId: string, patch: Partial<StoredProject>): Promise<StoredProject | null>;
  deleteProject(id: string, userId: string): Promise<void>;
  countCloudProjects(userId: string): Promise<number>;
  // usage
  addUsageLog(log: Omit<StoredUsageLog, "id" | "createdAt">): Promise<StoredUsageLog>;
  listUsageLogs(userId: string, limit?: number): Promise<StoredUsageLog[]>;
  // export jobs
  createJob(j: Omit<StoredExportJob, "id" | "createdAt">): Promise<StoredExportJob>;
  getJob(id: string, userId: string): Promise<StoredExportJob | null>;
  getJobById(id: string): Promise<StoredExportJob | null>;
  updateJob(id: string, patch: Partial<StoredExportJob>): Promise<StoredExportJob | null>;
  listJobs(userId: string): Promise<StoredExportJob[]>;
  countJobsSince(userId: string, since: number): Promise<number>;
  // api keys
  createApiKey(k: Omit<StoredApiKey, "id" | "createdAt" | "revokedAt">): Promise<StoredApiKey>;
  listApiKeys(userId: string): Promise<StoredApiKey[]>;
  findApiKeyByHash(hash: string): Promise<StoredApiKey | null>;
  updateApiKey(id: string, patch: Partial<StoredApiKey>): Promise<void>;
  // invoices
  createInvoice(i: Omit<StoredInvoice, "id" | "createdAt">): Promise<StoredInvoice>;
  listInvoices(userId: string): Promise<StoredInvoice[]>;
}

interface DbShape {
  /**
   * The shape of the file itself, so a future change to the fields has
   * somewhere to hang a migration. `emptyDb()` starts at 1; a reader that finds
   * a lower number can upgrade it, and one that finds a higher number knows the
   * file was written by a newer app than this one.
   */
  version: number;
  users: StoredUser[];
  sessions: StoredSession[];
  projects: StoredProject[];
  usageLogs: StoredUsageLog[];
  exportJobs: StoredExportJob[];
  apiKeys: StoredApiKey[];
  invoices: StoredInvoice[];
}

const DB_VERSION = 1;

function emptyDb(): DbShape {
  return {
    version: DB_VERSION,
    users: [],
    sessions: [],
    projects: [],
    usageLogs: [],
    exportJobs: [],
    apiKeys: [],
    invoices: [],
  };
}

/** What a JsonStore found when it opened its file — surfaced by health/status. */
export interface JsonStoreHealth {
  /**
   *   ok         the file was read as it was written
   *   fresh      there was no file yet — a first run, which is not a problem
   *   recovered  the file could not be read; the data came back from a backup
   *   lost       the file could not be read and no backup was usable. The app
   *              runs on an empty store and the unreadable file was kept
   *              (`quarantine`), but something is genuinely wrong here and
   *              `/api/ready` says so.
   */
  status: "ok" | "fresh" | "recovered" | "lost";
  /** The broken file that was set aside, if any. */
  quarantine: string | null;
  /** The backup the data came back from, if any. */
  recoveredFrom: string | null;
  /** The last write failure, if the disk is refusing writes. */
  lastWriteError: string | null;
}

const uuid = () => crypto.randomUUID();
const now = () => new Date().toISOString();

/** File-persisted in-memory store (development / demo, and every desktop install). */
export class JsonStore implements DataStore {
  readonly kind = "json";
  private db: DbShape = emptyDb();
  private file: string;
  private saveTimer: NodeJS.Timeout | null = null;
  private dirty = false;
  private health: JsonStoreHealth = { status: "ok", quarantine: null, recoveredFrom: null, lastWriteError: null };

  constructor() {
    this.file = path.join(config.dataDir, "store.json");
  }

  async init(): Promise<void> {
    fs.mkdirSync(config.dataDir, { recursive: true });
    const read = readJsonFile<Partial<DbShape>>(this.file, () => emptyDb());

    if (read.status === "corrupt") {
      // The file was there and could not be read. It is already moved aside
      // (jsonFile.readJsonFile never deletes it), so nothing below can write
      // over it — and before falling back to "a brand new install", walk the
      // daily backups: the person's account, projects and keys are in there.
      console.error(
        `[soundwave] ⚠ store.json could not be read (${read.quarantine ?? "and it could not be moved aside — check permissions"})`,
      );
      const backup = this.loadNewestBackup();
      this.health = {
        status: backup ? "recovered" : "lost",
        quarantine: read.quarantine,
        recoveredFrom: backup,
        lastWriteError: null,
      };
      if (backup) {
        console.warn(`[soundwave] store.json recovered from ${path.basename(backup)} — changes made after that backup are gone.`);
      } else {
        console.error("[soundwave] ⚠ no usable store backup: running on an empty store. The unreadable file was kept.");
      }
    } else {
      this.db = this.normalise(read.value);
      this.health = {
        status: read.status === "missing" ? "fresh" : "ok",
        quarantine: null,
        recoveredFrom: null,
        lastWriteError: null,
      };
    }

    this.writeNow();
    // A good copy for tomorrow, and a floor under the next crash: taken from the
    // file we just wrote, and only when what we read was sound — a broken state
    // must never become a "backup" of itself.
    if (this.health.status === "ok" || this.health.status === "fresh") dailyBackup(this.file);
  }

  /** Fill in anything a file written by an older build does not have yet. */
  private normalise(parsed: Partial<DbShape>): DbShape {
    const merged = { ...emptyDb(), ...parsed, version: DB_VERSION };
    // A hand-edited or truncated file must not crash a request later; the
    // collections are always arrays here, once, at the door.
    for (const key of ["users", "sessions", "projects", "usageLogs", "exportJobs", "apiKeys", "invoices"] as const) {
      if (!Array.isArray(merged[key])) merged[key] = [];
    }
    return merged;
  }

  private loadNewestBackup(): string | null {
    for (const backup of listBackups(this.file)) {
      const read = readJsonFile<Partial<DbShape>>(backup, () => emptyDb());
      if (read.status === "ok") {
        this.db = this.normalise(read.value);
        return backup;
      }
    }
    return null;
  }

  /** What this store found on disk (store health in `/api/health`). */
  describe(): JsonStoreHealth {
    return { ...this.health };
  }

  /** Debounced save: many mutations in one turn become one write. */
  private persist(): void {
    this.dirty = true;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.writeNow(), 150);
    this.saveTimer.unref?.();
  }

  /**
   * Write now, atomically (jsonFile.writeJsonFile: tmp → fsync → rename), and
   * report a failure instead of swallowing it — a disk that refuses writes is
   * the user's data about to be lost, which is exactly the sort of thing the
   * old `catch { /* non-fatal *\/ }` here hid.
   */
  private writeNow(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    try {
      writeJsonFile(this.file, this.db, { mode: 0o600 });
      this.dirty = false;
      if (this.health.lastWriteError) this.health.lastWriteError = null;
    } catch (err) {
      this.health.lastWriteError = (err as Error).message;
      console.error(`[soundwave] ⚠ could not save store.json: ${(err as Error).message}`);
    }
  }

  /** Flush on shutdown (`index.ts`): the debounce is not a data-loss window. */
  async flush(): Promise<void> {
    if (this.dirty) {
      console.log(`[soundwave] flushing store (${this.db.users.length} user(s)) …`);
      this.writeNow();
    }
    // Today's backup should hold the last state we know to be good — refreshed
    // here, at the end of a session, rather than only at the start of one.
    // Deliberately not for a store that just failed to read ("lost": the copy
    // already there is better than the empty one we are running on) or to write.
    const sound = this.health.status === "ok" || this.health.status === "fresh" || this.health.status === "recovered";
    if (sound && !this.health.lastWriteError) dailyBackup(this.file, 7, { refresh: true });
  }

  // ── users ────────────────────────────────────────────────────────────────
  async findUserByEmail(email: string): Promise<StoredUser | null> {
    const e = email.toLowerCase().trim();
    return this.db.users.find((u) => u.email.toLowerCase() === e && !u.deletedAt) ?? null;
  }
  async findUserById(id: string): Promise<StoredUser | null> {
    return this.db.users.find((u) => u.id === id && !u.deletedAt) ?? null;
  }
  async findUserByStripeCustomerId(customerId: string): Promise<StoredUser | null> {
    const id = customerId.trim();
    if (!id) return null;
    return this.db.users.find((u) => u.stripeCustomerId === id && !u.deletedAt) ?? null;
  }
  async createUser(u: Partial<StoredUser> & { email: string; name: string }): Promise<StoredUser> {
    const { email, name, id: givenId, ...rest } = u;
    const user: StoredUser = {
      id: givenId ?? uuid(),
      email: email.toLowerCase().trim(),
      name,
      avatarUrl: null,
      plan: config.defaultSignupPlan,
      stripeCustomerId: null,
      stripeSubscriptionId: null,
      charactersUsedThisMonth: 0,
      characterResetDate: nextResetIso(),
      totalAudioDurationSeconds: 0,
      createdAt: now(),
      updatedAt: now(),
      deletedAt: null,
      ...rest,
    };
    this.db.users.push(user);
    this.persist();
    return user;
  }
  async updateUser(id: string, patch: Partial<StoredUser>): Promise<StoredUser | null> {
    const u = this.db.users.find((x) => x.id === id && !x.deletedAt);
    if (!u) return null;
    Object.assign(u, patch, { updatedAt: now() });
    this.persist();
    return u;
  }
  async deleteUserSoft(id: string): Promise<void> {
    const u = this.db.users.find((x) => x.id === id);
    if (u) {
      u.deletedAt = now();
      u.email = `${u.email}#deleted-${Date.now()}`;
    }
    this.db.sessions = this.db.sessions.filter((s) => s.userId !== id);
    this.persist();
  }
  async countUsers(): Promise<number> {
    return this.db.users.filter((u) => !u.deletedAt).length;
  }
  async listUsers(): Promise<StoredUser[]> {
    // The same objects the store mutates — callers must not write to them.
    return this.db.users.filter((u) => !u.deletedAt);
  }
  async countLifetimeUsers(): Promise<number> {
    return this.db.users.filter((u) => !u.deletedAt && Boolean(u.lifetimeSince)).length;
  }

  // ── sessions ─────────────────────────────────────────────────────────────
  async createSession(s: Omit<StoredSession, "createdAt">): Promise<StoredSession> {
    const session: StoredSession = { ...s, id: s.id ?? uuid(), createdAt: now() };
    this.db.sessions.push(session);
    this.persist();
    return session;
  }
  async findSessionByTokenHash(hash: string): Promise<StoredSession | null> {
    return this.db.sessions.find((s) => s.refreshTokenHash === hash) ?? null;
  }
  async findSessionById(id: string): Promise<StoredSession | null> {
    return this.db.sessions.find((s) => s.id === id) ?? null;
  }
  async deleteSession(id: string): Promise<void> {
    this.db.sessions = this.db.sessions.filter((s) => s.id !== id);
    this.persist();
  }
  async deleteAllSessionsForUser(userId: string): Promise<void> {
    this.db.sessions = this.db.sessions.filter((s) => s.userId !== userId);
    this.persist();
  }
  async deleteOtherSessions(userId: string, keepSessionId: string): Promise<void> {
    this.db.sessions = this.db.sessions.filter((s) => s.userId !== userId || s.id === keepSessionId);
    this.persist();
  }
  async touchSession(id: string): Promise<void> {
    const s = this.db.sessions.find((x) => x.id === id);
    if (s) s.lastActiveAt = now();
    this.persist();
  }
  async listSessionsForUser(userId: string): Promise<StoredSession[]> {
    return this.db.sessions.filter((s) => s.userId === userId);
  }

  // ── projects ─────────────────────────────────────────────────────────────
  async createProject(p: Omit<StoredProject, "id" | "createdAt" | "updatedAt" | "deletedAt">): Promise<StoredProject> {
    const project: StoredProject = { ...p, id: uuid(), createdAt: now(), updatedAt: now(), deletedAt: null };
    this.db.projects.push(project);
    this.persist();
    return project;
  }
  async getProject(id: string, userId: string): Promise<StoredProject | null> {
    return this.db.projects.find((p) => p.id === id && p.userId === userId && !p.deletedAt) ?? null;
  }
  async listProjects(userId: string): Promise<StoredProject[]> {
    return this.db.projects.filter((p) => p.userId === userId && !p.deletedAt).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  async updateProject(id: string, userId: string, patch: Partial<StoredProject>): Promise<StoredProject | null> {
    const p = this.db.projects.find((x) => x.id === id && x.userId === userId && !x.deletedAt);
    if (!p) return null;
    Object.assign(p, patch, { updatedAt: now() });
    this.persist();
    return p;
  }
  async deleteProject(id: string, userId: string): Promise<void> {
    const p = this.db.projects.find((x) => x.id === id && x.userId === userId);
    if (p) p.deletedAt = now();
    this.persist();
  }
  async countCloudProjects(userId: string): Promise<number> {
    return this.db.projects.filter((p) => p.userId === userId && !p.deletedAt && p.storageType === "CLOUD").length;
  }

  // ── usage ────────────────────────────────────────────────────────────────
  async addUsageLog(log: Omit<StoredUsageLog, "id" | "createdAt">): Promise<StoredUsageLog> {
    const l: StoredUsageLog = { ...log, id: uuid(), createdAt: now() };
    this.db.usageLogs.push(l);
    this.persist();
    return l;
  }
  async listUsageLogs(userId: string, limit = 100): Promise<StoredUsageLog[]> {
    return this.db.usageLogs
      .filter((l) => l.userId === userId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
  }

  // ── export jobs ──────────────────────────────────────────────────────────
  async createJob(j: Omit<StoredExportJob, "id" | "createdAt">): Promise<StoredExportJob> {
    const job: StoredExportJob = { ...j, id: uuid(), createdAt: now() };
    this.db.exportJobs.push(job);
    this.persist();
    return job;
  }
  async getJob(id: string, userId: string): Promise<StoredExportJob | null> {
    return this.db.exportJobs.find((j) => j.id === id && j.userId === userId) ?? null;
  }
  async getJobById(id: string): Promise<StoredExportJob | null> {
    return this.db.exportJobs.find((j) => j.id === id) ?? null;
  }
  async updateJob(id: string, patch: Partial<StoredExportJob>): Promise<StoredExportJob | null> {
    const j = this.db.exportJobs.find((x) => x.id === id);
    if (!j) return null;
    Object.assign(j, patch);
    this.persist();
    return j;
  }
  async listJobs(userId: string): Promise<StoredExportJob[]> {
    return this.db.exportJobs.filter((j) => j.userId === userId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async countJobsSince(userId: string, since: number): Promise<number> {
    return this.db.exportJobs.filter((j) => j.userId === userId && new Date(j.createdAt).getTime() >= since).length;
  }

  // ── api keys ─────────────────────────────────────────────────────────────
  async createApiKey(k: Omit<StoredApiKey, "id" | "createdAt" | "revokedAt">): Promise<StoredApiKey> {
    const key: StoredApiKey = { ...k, revokedAt: null, id: uuid(), createdAt: now() };
    this.db.apiKeys.push(key);
    this.persist();
    return key;
  }
  async listApiKeys(userId: string): Promise<StoredApiKey[]> {
    return this.db.apiKeys.filter((k) => k.userId === userId && !k.revokedAt);
  }
  async findApiKeyByHash(hash: string): Promise<StoredApiKey | null> {
    return this.db.apiKeys.find((k) => k.keyHash === hash && !k.revokedAt) ?? null;
  }
  async updateApiKey(id: string, patch: Partial<StoredApiKey>): Promise<void> {
    const k = this.db.apiKeys.find((x) => x.id === id);
    if (k) Object.assign(k, patch);
    this.persist();
  }

  // ── invoices ─────────────────────────────────────────────────────────────
  async createInvoice(i: Omit<StoredInvoice, "id" | "createdAt">): Promise<StoredInvoice> {
    const inv: StoredInvoice = { ...i, id: uuid(), createdAt: now() };
    this.db.invoices.push(inv);
    this.persist();
    return inv;
  }
  async listInvoices(userId: string): Promise<StoredInvoice[]> {
    return this.db.invoices.filter((i) => i.userId === userId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
}

function nextResetIso(): string {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth() + 1, 1, 0, 0, 0, 0).toISOString();
}

// ── Singleton + factory ─────────────────────────────────────────────────────
let store: DataStore | null = null;

export async function getStore(): Promise<DataStore> {
  if (store) return store;
  // Use Prisma when a Postgres DSN is configured (production path).
  if (config.databaseUrl.startsWith("postgres")) {
    try {
      const { PrismaStore } = await import("./prismaStore.js");
      const p = new PrismaStore();
      // Test the database connection with a fast query
      await (p as any).prisma.$queryRaw`SELECT 1`;
      store = p;
    } catch (err) {
      // A hosted deployment whose database is unreachable must NOT come up on an
      // empty local file: the app would answer sign-ins against nothing, every
      // existing account would look deleted, and a health check would call a
      // broken deploy "up". Refuse to boot instead — unless someone set
      // ALLOW_JSON_FALLBACK=1 on purpose (the demo/self-host path).
      const message = `[soundwave] PostgreSQL at "${redactDsn(config.databaseUrl)}" is unreachable: ${(err as Error).message}`;
      if (config.isProd && !config.allowJsonFallback) {
        console.error(message);
        throw new Error(
          `${message}. Refusing to start on the local JSON store in production: existing accounts would appear to be gone. ` +
            "Fix DATABASE_URL, or set ALLOW_JSON_FALLBACK=1 to accept an empty local store on purpose.",
          { cause: err },
        );
      }
      console.warn(`${message}. Falling back to the local JSON store.`);
      const s = new JsonStore();
      await s.init();
      store = s;
    }
  } else {
    const s = new JsonStore();
    await s.init();
    store = s;
  }
  return store;
}

/** A DSN with its password removed — for logs. */
function redactDsn(dsn: string): string {
  try {
    const url = new URL(dsn);
    if (url.password) url.password = "***";
    return url.toString();
  } catch {
    return "postgres (unparseable DSN)";
  }
}

/**
 * What the active store can say about itself, for `/api/health` and for the
 * log line at boot: which kind it is, and (the JSON one) whether it had to
 * recover. A deployment that quietly degraded to a fallback store is a
 * deployment to look at, so this is visible without reading the console.
 */
export function describeStore(): { kind: string; recovery?: JsonStoreHealth } {
  if (!store) return { kind: "uninitialized" };
  if (store instanceof JsonStore) return { kind: store.kind, recovery: store.describe() };
  return { kind: store.kind };
}

/**
 * Write everything to disk now. Called by the shutdown path in index.ts so a
 * quit, a `docker compose stop` or a SIGTERM cannot lose the last mutation.
 */
export async function flushStore(): Promise<void> {
  if (!store) return;
  try {
    await store.flush?.();
  } catch (err) {
    console.error(`[soundwave] store flush failed: ${(err as Error).message}`);
  }
}

export function setStoreForTests(s: DataStore): void {
  store = s;
}

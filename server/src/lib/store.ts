import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { config } from "../config.js";
import type { Plan } from "./plans.js";

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
  charactersUsedThisMonth: number;
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
  // users
  findUserByEmail(email: string): Promise<StoredUser | null>;
  findUserById(id: string): Promise<StoredUser | null>;
  /** The account a Stripe customer belongs to (webhooks carry the customer). */
  findUserByStripeCustomerId(customerId: string): Promise<StoredUser | null>;
  createUser(u: Partial<StoredUser> & { email: string; name: string }): Promise<StoredUser>;
  updateUser(id: string, patch: Partial<StoredUser>): Promise<StoredUser | null>;
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
  users: StoredUser[];
  sessions: StoredSession[];
  projects: StoredProject[];
  usageLogs: StoredUsageLog[];
  exportJobs: StoredExportJob[];
  apiKeys: StoredApiKey[];
  invoices: StoredInvoice[];
}

function emptyDb(): DbShape {
  return {
    users: [],
    sessions: [],
    projects: [],
    usageLogs: [],
    exportJobs: [],
    apiKeys: [],
    invoices: [],
  };
}

const uuid = () => crypto.randomUUID();
const now = () => new Date().toISOString();

/** File-persisted in-memory store (development / demo). */
export class JsonStore implements DataStore {
  readonly kind = "json";
  private db: DbShape = emptyDb();
  private file: string;
  private saveTimer: NodeJS.Timeout | null = null;

  constructor() {
    this.file = path.join(config.dataDir, "store.json");
  }

  async init(): Promise<void> {
    fs.mkdirSync(config.dataDir, { recursive: true });
    try {
      const raw = fs.readFileSync(this.file, "utf8");
      const parsed = JSON.parse(raw) as Partial<DbShape>;
      this.db = { ...emptyDb(), ...parsed };
    } catch {
      this.db = emptyDb();
    }
    this.persist();
  }

  private persist(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      try {
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        fs.writeFileSync(this.file, JSON.stringify(this.db), "utf8");
      } catch {
        /* non-fatal */
      }
    }, 150);
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
    return this.db.projects
      .filter((p) => p.userId === userId && !p.deletedAt)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
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
      console.warn(`[soundwave] PostgreSQL at "${config.databaseUrl}" is unreachable. Falling back to local JSON store.`);
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

export function setStoreForTests(s: DataStore): void {
  store = s;
}

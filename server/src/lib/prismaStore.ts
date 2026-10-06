import { Prisma, PrismaClient } from "@prisma/client";
import { config } from "../config.js";
import type {
  DataStore,
  StoredApiKey,
  StoredExportJob,
  StoredInvoice,
  StoredProject,
  StoredSession,
  StoredUsageLog,
  StoredUser,
} from "./store.js";

// ── PostgreSQL-backed store (production) ────────────────────────────────────
// Mirrors prisma/schema.prisma. Dates are converted to ISO strings at the
// repository boundary so the rest of the app is storage-agnostic.

const d2s = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);
const s2d = (s: string | null | undefined): Date | null => (s ? new Date(s) : null);

export class PrismaStore implements DataStore {
  readonly kind = "prisma";
  private prisma: PrismaClient;

  constructor() {
    this.prisma = new PrismaClient();
  }

  // users ────────────────────────────────────────────────────────────────────
  async findUserByEmail(email: string): Promise<StoredUser | null> {
    const u = await this.prisma.user.findUnique({ where: { email: email.toLowerCase().trim() } });
    if (!u || u.deletedAt) return null;
    return mapUser(u);
  }
  async findUserById(id: string): Promise<StoredUser | null> {
    const u = await this.prisma.user.findUnique({ where: { id } });
    if (!u || u.deletedAt) return null;
    return mapUser(u);
  }
  async findUserByStripeCustomerId(customerId: string): Promise<StoredUser | null> {
    const id = customerId.trim();
    if (!id) return null;
    const u = await this.prisma.user.findFirst({ where: { stripeCustomerId: id } });
    if (!u || u.deletedAt) return null;
    return mapUser(u);
  }
  async createUser(input: Partial<StoredUser> & { email: string; name: string }): Promise<StoredUser> {
    const u = await this.prisma.user.create({
      data: {
        email: input.email.toLowerCase().trim(),
        name: input.name,
        characterResetDate: new Date(),
        plan: input.plan ?? config.defaultSignupPlan,
      },
    });
    return mapUser(u);
  }
  async updateUser(id: string, patch: Partial<StoredUser>): Promise<StoredUser | null> {
    const u = await this.prisma.user.update({
      where: { id },
      data: {
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.email !== undefined ? { email: patch.email } : {}),
        ...(patch.avatarUrl !== undefined ? { avatarUrl: patch.avatarUrl } : {}),
        ...(patch.plan !== undefined ? { plan: patch.plan } : {}),
        ...(patch.stripeCustomerId !== undefined ? { stripeCustomerId: patch.stripeCustomerId } : {}),
        ...(patch.stripeSubscriptionId !== undefined ? { stripeSubscriptionId: patch.stripeSubscriptionId } : {}),
        ...(patch.charactersUsedThisMonth !== undefined ? { charactersUsedThisMonth: patch.charactersUsedThisMonth } : {}),
        ...(patch.characterResetDate !== undefined ? { characterResetDate: s2d(patch.characterResetDate)! } : {}),
        ...(patch.totalAudioDurationSeconds !== undefined ? { totalAudioDurationSeconds: patch.totalAudioDurationSeconds } : {}),
      },
    });
    return mapUser(u);
  }
  async deleteUserSoft(id: string): Promise<void> {
    await this.prisma.user.update({ where: { id }, data: { deletedAt: new Date() } });
    await this.prisma.session.deleteMany({ where: { userId: id } });
  }
  async countUsers(): Promise<number> {
    return this.prisma.user.count({ where: { deletedAt: null } });
  }

  // sessions ─────────────────────────────────────────────────────────────────
  async createSession(s: Omit<StoredSession, "createdAt">): Promise<StoredSession> {
    const row = await this.prisma.session.create({
      data: {
        id: s.id,
        userId: s.userId,
        refreshToken: s.refreshTokenHash,
        deviceInfo: s.deviceInfo,
        ipAddress: s.ipAddress,
        lastActiveAt: new Date(s.lastActiveAt),
        // A permanent session (Google sign-in on this PC) has no expiry.
        expiresAt: s.expiresAt ? new Date(s.expiresAt) : null,
      },
    });
    return mapSession(row);
  }
  async findSessionByTokenHash(hash: string): Promise<StoredSession | null> {
    const s = await this.prisma.session.findFirst({ where: { refreshToken: hash } });
    return s ? mapSession(s) : null;
  }
  async findSessionById(id: string): Promise<StoredSession | null> {
    const s = await this.prisma.session.findUnique({ where: { id } });
    return s ? mapSession(s) : null;
  }
  async deleteSession(id: string): Promise<void> {
    await this.prisma.session.deleteMany({ where: { id } });
  }
  async deleteAllSessionsForUser(userId: string): Promise<void> {
    await this.prisma.session.deleteMany({ where: { userId } });
  }
  async deleteOtherSessions(userId: string, keepSessionId: string): Promise<void> {
    await this.prisma.session.deleteMany({ where: { userId, NOT: { id: keepSessionId } } });
  }
  async touchSession(id: string): Promise<void> {
    await this.prisma.session.updateMany({ where: { id }, data: { lastActiveAt: new Date() } });
  }
  async listSessionsForUser(userId: string): Promise<StoredSession[]> {
    const rows = await this.prisma.session.findMany({ where: { userId } });
    return rows.map(mapSession);
  }

  // projects ─────────────────────────────────────────────────────────────────
  async createProject(p: Omit<StoredProject, "id" | "createdAt" | "updatedAt" | "deletedAt">): Promise<StoredProject> {
    const row = await this.prisma.project.create({
      data: {
        userId: p.userId,
        title: p.title,
        type: p.type,
        textContent: p.textContent,
        voiceId: p.voiceId,
        voiceSettings: p.voiceSettings as object,
        characterCount: p.characterCount,
        subtitleData: p.subtitleData == null ? undefined : (p.subtitleData as any),
        subtitleStyle: p.subtitleStyle == null ? undefined : (p.subtitleStyle as any),
        videoBackgroundUrl: p.videoBackgroundUrl,
        audioUrl: p.audioUrl,
        exportedVideoUrl: p.exportedVideoUrl,
        duration: p.duration,
        status: p.status,
        storageType: p.storageType,
      },
    });
    return mapProject(row);
  }
  async getProject(id: string, userId: string): Promise<StoredProject | null> {
    const p = await this.prisma.project.findFirst({ where: { id, userId, deletedAt: null } });
    return p ? mapProject(p) : null;
  }
  async listProjects(userId: string): Promise<StoredProject[]> {
    const rows = await this.prisma.project.findMany({
      where: { userId, deletedAt: null },
      orderBy: { updatedAt: "desc" },
    });
    return rows.map(mapProject);
  }
  async updateProject(id: string, userId: string, patch: Partial<StoredProject>): Promise<StoredProject | null> {
    const p = await this.prisma.project.updateMany({
      where: { id, userId, deletedAt: null },
      data: {
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.textContent !== undefined ? { textContent: patch.textContent } : {}),
        ...(patch.voiceId !== undefined ? { voiceId: patch.voiceId } : {}),
        ...(patch.voiceSettings !== undefined ? { voiceSettings: patch.voiceSettings as object } : {}),
        ...(patch.subtitleData !== undefined
          ? { subtitleData: patch.subtitleData === null ? null : (patch.subtitleData as any) }
          : {}),
        ...(patch.subtitleStyle !== undefined
          ? { subtitleStyle: patch.subtitleStyle === null ? null : (patch.subtitleStyle as any) }
          : {}),
        ...(patch.videoBackgroundUrl !== undefined ? { videoBackgroundUrl: patch.videoBackgroundUrl } : {}),
        ...(patch.audioUrl !== undefined ? { audioUrl: patch.audioUrl } : {}),
        ...(patch.exportedVideoUrl !== undefined ? { exportedVideoUrl: patch.exportedVideoUrl } : {}),
        ...(patch.duration !== undefined ? { duration: patch.duration } : {}),
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.storageType !== undefined ? { storageType: patch.storageType } : {}),
      },
    });
    if (p.count === 0) return null;
    return this.getProject(id, userId);
  }
  async deleteProject(id: string, userId: string): Promise<void> {
    await this.prisma.project.updateMany({ where: { id, userId }, data: { deletedAt: new Date() } });
  }
  async countCloudProjects(userId: string): Promise<number> {
    return this.prisma.project.count({ where: { userId, deletedAt: null, storageType: "CLOUD" } });
  }

  // usage ────────────────────────────────────────────────────────────────────
  async addUsageLog(log: Omit<StoredUsageLog, "id" | "createdAt">): Promise<StoredUsageLog> {
    const row = await this.prisma.tTSUsageLog.create({
      data: {
        userId: log.userId,
        characterCount: log.characterCount,
        voiceId: log.voiceId,
        audioDurationSeconds: log.audioDurationSeconds,
        generatedAt: new Date(log.generatedAt),
      },
    });
    return {
      id: row.id,
      userId: row.userId,
      characterCount: row.characterCount,
      voiceId: row.voiceId,
      audioDurationSeconds: row.audioDurationSeconds,
      generatedAt: row.generatedAt.toISOString(),
      createdAt: row.createdAt.toISOString(),
    };
  }
  async listUsageLogs(userId: string, limit = 100): Promise<StoredUsageLog[]> {
    const rows = await this.prisma.tTSUsageLog.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: limit,
    });
    return rows.map((r: any) => ({
      id: r.id,
      userId: r.userId,
      characterCount: r.characterCount,
      voiceId: r.voiceId,
      audioDurationSeconds: r.audioDurationSeconds,
      generatedAt: r.generatedAt.toISOString(),
      createdAt: r.createdAt.toISOString(),
    }));
  }

  // export jobs ──────────────────────────────────────────────────────────────
  async createJob(j: Omit<StoredExportJob, "id" | "createdAt">): Promise<StoredExportJob> {
    const row = await this.prisma.exportJob.create({
      data: {
        projectId: j.projectId,
        userId: j.userId,
        status: j.status,
        progress: j.progress,
        settings: j.settings as object,
        outputUrl: j.outputUrl,
        errorMessage: j.errorMessage,
        startedAt: s2d(j.startedAt),
        completedAt: s2d(j.completedAt),
      },
    });
    return mapJob(row);
  }
  async getJob(id: string, userId: string): Promise<StoredExportJob | null> {
    const j = await this.prisma.exportJob.findFirst({ where: { id, userId } });
    return j ? mapJob(j) : null;
  }
  async getJobById(id: string): Promise<StoredExportJob | null> {
    const j = await this.prisma.exportJob.findUnique({ where: { id } });
    return j ? mapJob(j) : null;
  }
  async updateJob(id: string, patch: Partial<StoredExportJob>): Promise<StoredExportJob | null> {
    const j = await this.prisma.exportJob.update({
      where: { id },
      data: {
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.progress !== undefined ? { progress: patch.progress } : {}),
        ...(patch.outputUrl !== undefined ? { outputUrl: patch.outputUrl } : {}),
        ...(patch.errorMessage !== undefined ? { errorMessage: patch.errorMessage } : {}),
        ...(patch.startedAt !== undefined ? { startedAt: s2d(patch.startedAt) } : {}),
        ...(patch.completedAt !== undefined ? { completedAt: s2d(patch.completedAt) } : {}),
      },
    });
    return mapJob(j);
  }
  async listJobs(userId: string): Promise<StoredExportJob[]> {
    const rows = await this.prisma.exportJob.findMany({ where: { userId }, orderBy: { createdAt: "desc" } });
    return rows.map(mapJob);
  }
  async countJobsSince(userId: string, since: number): Promise<number> {
    return this.prisma.exportJob.count({
      where: { userId, createdAt: { gte: new Date(since) } },
    });
  }

  // api keys ─────────────────────────────────────────────────────────────────
  async createApiKey(k: Omit<StoredApiKey, "id" | "createdAt">): Promise<StoredApiKey> {
    const row = await this.prisma.apiKey.create({
      data: {
        userId: k.userId,
        name: k.name,
        keyHash: k.keyHash,
        lastUsedAt: s2d(k.lastUsedAt),
        expiresAt: s2d(k.expiresAt),
      },
    });
    return { ...mapApiKey(row), prefix: k.prefix };
  }
  async listApiKeys(userId: string): Promise<StoredApiKey[]> {
    const rows = await this.prisma.apiKey.findMany({ where: { userId, revokedAt: null } });
    return rows.map((r: any) => ({ ...mapApiKey(r), prefix: r.keyHash.slice(0, 8) }));
  }
  async findApiKeyByHash(hash: string): Promise<StoredApiKey | null> {
    const k = await this.prisma.apiKey.findFirst({ where: { keyHash: hash, revokedAt: null } });
    return k ? { ...mapApiKey(k), prefix: k.keyHash.slice(0, 8) } : null;
  }
  async updateApiKey(id: string, patch: Partial<StoredApiKey>): Promise<void> {
    await this.prisma.apiKey.update({
      where: { id },
      data: {
        ...(patch.lastUsedAt !== undefined ? { lastUsedAt: s2d(patch.lastUsedAt) } : {}),
        ...(patch.revokedAt !== undefined ? { revokedAt: s2d(patch.revokedAt) } : {}),
      },
    });
  }

  // invoices ─────────────────────────────────────────────────────────────────
  async createInvoice(i: Omit<StoredInvoice, "id" | "createdAt">): Promise<StoredInvoice> {
    const row = await this.prisma.invoice.create({
      data: {
        userId: i.userId,
        stripeInvoiceId: i.stripeInvoiceId,
        amount: i.amount,
        currency: i.currency,
        status: i.status,
        pdfUrl: i.pdfUrl,
      },
    });
    return mapInvoice(row);
  }
  async listInvoices(userId: string): Promise<StoredInvoice[]> {
    const rows = await this.prisma.invoice.findMany({ where: { userId }, orderBy: { createdAt: "desc" } });
    return rows.map(mapInvoice);
  }
}

// ── mappers ─────────────────────────────────────────────────────────────────
/* eslint-disable @typescript-eslint/no-explicit-any */
function mapUser(u: any): StoredUser {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    avatarUrl: u.avatarUrl,
    plan: u.plan,
    stripeCustomerId: u.stripeCustomerId,
    stripeSubscriptionId: u.stripeSubscriptionId,
    charactersUsedThisMonth: u.charactersUsedThisMonth,
    characterResetDate: d2s(u.characterResetDate) ?? new Date().toISOString(),
    totalAudioDurationSeconds: u.totalAudioDurationSeconds,
    createdAt: d2s(u.createdAt)!,
    updatedAt: d2s(u.updatedAt)!,
    deletedAt: d2s(u.deletedAt),
  };
}
function mapSession(s: any): StoredSession {
  return {
    id: s.id,
    userId: s.userId,
    refreshTokenHash: s.refreshToken,
    deviceInfo: s.deviceInfo,
    ipAddress: s.ipAddress,
    lastActiveAt: d2s(s.lastActiveAt)!,
    // null = permanent (the signed-in Google account on this PC).
    expiresAt: d2s(s.expiresAt),
    createdAt: d2s(s.createdAt)!,
  };
}
function mapProject(p: any): StoredProject {
  return {
    id: p.id,
    userId: p.userId,
    title: p.title,
    type: p.type,
    textContent: p.textContent,
    voiceId: p.voiceId,
    voiceSettings: p.voiceSettings,
    characterCount: p.characterCount,
    subtitleData: p.subtitleData,
    subtitleStyle: p.subtitleStyle,
    videoBackgroundUrl: p.videoBackgroundUrl,
    audioUrl: p.audioUrl,
    exportedVideoUrl: p.exportedVideoUrl,
    duration: p.duration,
    status: p.status,
    storageType: p.storageType,
    createdAt: d2s(p.createdAt)!,
    updatedAt: d2s(p.updatedAt)!,
    deletedAt: d2s(p.deletedAt),
  };
}
function mapJob(j: any): StoredExportJob {
  return {
    id: j.id,
    projectId: j.projectId,
    userId: j.userId,
    status: j.status,
    progress: j.progress,
    settings: j.settings,
    outputUrl: j.outputUrl,
    errorMessage: j.errorMessage,
    startedAt: d2s(j.startedAt),
    completedAt: d2s(j.completedAt),
    createdAt: d2s(j.createdAt)!,
  };
}
function mapApiKey(k: any): Omit<StoredApiKey, "prefix"> {
  return {
    id: k.id,
    userId: k.userId,
    name: k.name,
    keyHash: k.keyHash,
    lastUsedAt: d2s(k.lastUsedAt),
    expiresAt: d2s(k.expiresAt),
    createdAt: d2s(k.createdAt)!,
    revokedAt: d2s(k.revokedAt),
  };
}
function mapInvoice(i: any): StoredInvoice {
  return {
    id: i.id,
    userId: i.userId,
    stripeInvoiceId: i.stripeInvoiceId,
    amount: i.amount,
    currency: i.currency,
    status: i.status,
    pdfUrl: i.pdfUrl,
    createdAt: d2s(i.createdAt)!,
  };
}

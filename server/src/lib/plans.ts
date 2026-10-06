export type Plan = "FREE" | "PRO" | "ENTERPRISE";

export interface PlanDefinition {
  id: Plan;
  name: string;
  monthlyPrice: number; // USD
  annualPricePerMonth: number;
  /** Minutes of video processed per calendar month — the number on the pricing page. */
  videoMinutesPerMonth: number;
  /** Clips made per month; null = no ceiling (Pro and up). */
  clipsPerMonth: number | null;
  /** Days a finished clip is kept; null = kept for as long as the app is installed. */
  clipRetentionDays: number | null;
  /**
   * A fair-use guard, not the product: it stops one account from being a whole
   * agency on someone else's Gemini key. Deliberately generous — nobody should
   * ever hit it while doing what their plan says they can do.
   */
  characterLimit: number;
  maxVideoMb: number;
  exportsPerHour: number;
  maxResolution: "720p" | "1080p" | "4K";
  watermark: boolean;
  cloudSave: boolean;
  maxProjects: number;
  subtitleFonts: 3 | 20;
  fullStyling: boolean;
  apiAccess: boolean;
}

export const PLANS: Record<Plan, PlanDefinition> = {
  FREE: {
    id: "FREE",
    name: "Free",
    monthlyPrice: 0,
    annualPricePerMonth: 0,
    // The same shape as the category: an hour a month, a watermark, and clips
    // that go away after a week.
    videoMinutesPerMonth: 60,
    clipsPerMonth: 30,
    clipRetentionDays: 7,
    characterLimit: 150_000,
    maxVideoMb: 100,
    exportsPerHour: 2,
    maxResolution: "720p",
    watermark: true,
    cloudSave: false,
    maxProjects: 3,
    subtitleFonts: 3,
    fullStyling: false,
    apiAccess: false,
  },
  PRO: {
    id: "PRO",
    name: "Pro",
    monthlyPrice: 15,
    annualPricePerMonth: 12,
    // 300 minutes is exactly Opus Clip's $29 tier — at half the price, with
    // the assistant, the voice studio and the PC agent included.
    videoMinutesPerMonth: 300,
    clipsPerMonth: null,
    clipRetentionDays: null,
    characterLimit: 1_000_000,
    maxVideoMb: 500,
    exportsPerHour: 20,
    maxResolution: "1080p",
    watermark: false,
    cloudSave: true,
    maxProjects: 50,
    subtitleFonts: 20,
    fullStyling: true,
    apiAccess: false,
  },
  ENTERPRISE: {
    id: "ENTERPRISE",
    name: "Enterprise",
    monthlyPrice: 39,
    annualPricePerMonth: 31.2,
    videoMinutesPerMonth: 1_200,
    clipsPerMonth: null,
    clipRetentionDays: null,
    characterLimit: 5_000_000,
    maxVideoMb: 2048,
    exportsPerHour: 100,
    maxResolution: "4K",
    watermark: false,
    cloudSave: true,
    maxProjects: Infinity,
    subtitleFonts: 20,
    fullStyling: true,
    apiAccess: true,
  },
};

export function getPlan(plan: Plan): PlanDefinition {
  return PLANS[plan] ?? PLANS.FREE;
}

export const RESOLUTIONS = {
  "720p": { width: 1280, height: 720 },
  "1080p": { width: 1920, height: 1080 },
  "1440p": { width: 2560, height: 1440 },
  "4K": { width: 3840, height: 2160 },
} as const;

export type ResolutionKey = keyof typeof RESOLUTIONS;
export type AspectRatio = "16:9" | "9:16";

export function dimensionsFor(res: ResolutionKey, aspect: AspectRatio = "16:9"): { width: number; height: number } {
  const { width, height } = RESOLUTIONS[res];
  return aspect === "9:16" ? { width: height, height: width } : { width, height };
}

export function resolutionAllowed(plan: Plan, res: ResolutionKey): boolean {
  const allowed = {
    FREE: ["720p"],
    PRO: ["720p", "1080p"],
    ENTERPRISE: ["720p", "1080p", "1440p", "4K"],
  }[plan] ?? ["720p"];
  return allowed.includes(res);
}

export function nextMonthlyReset(): Date {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth() + 1, 1, 0, 0, 0, 0);
}

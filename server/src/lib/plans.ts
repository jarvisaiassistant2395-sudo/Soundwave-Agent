export type Plan = "FREE" | "PRO" | "ENTERPRISE";

export interface PlanDefinition {
  id: Plan;
  name: string;
  monthlyPrice: number; // USD
  annualPricePerMonth: number;
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
    characterLimit: 10_000,
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
    monthlyPrice: 12,
    annualPricePerMonth: 9.6,
    characterLimit: 200_000,
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
    characterLimit: 2_000_000,
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

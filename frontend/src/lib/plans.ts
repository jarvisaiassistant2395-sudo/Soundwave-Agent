export type Plan = "FREE" | "PRO" | "ENTERPRISE";

export interface PlanDefinition {
  id: Plan;
  name: string;
  monthlyPrice: number;
  annualPricePerMonth: number;
  /** Minutes of video processed per calendar month — the headline number. */
  videoMinutesPerMonth: number;
  /** Clips per month; null = no ceiling. */
  clipsPerMonth: number | null;
  /** Days a finished clip is kept; null = kept. */
  clipRetentionDays: number | null;
  /** The fair-use guard (server side), not the thing being sold. */
  characterLimit: number;
  maxVideoMb: number;
  exportsPerHour: number;
  maxResolution: "720p" | "1080p" | "4K";
  watermark: boolean;
  cloudSave: boolean;
  apiAccess: boolean;
}

export const PLANS: Record<Plan, PlanDefinition> = {
  FREE: {
    id: "FREE",
    name: "Free",
    monthlyPrice: 0,
    annualPricePerMonth: 0,
    videoMinutesPerMonth: 60,
    clipsPerMonth: 30,
    clipRetentionDays: 7,
    characterLimit: 150_000,
    maxVideoMb: 100,
    exportsPerHour: 2,
    maxResolution: "720p",
    watermark: true,
    cloudSave: false,
    apiAccess: false,
  },
  PRO: {
    id: "PRO",
    name: "Pro",
    monthlyPrice: 15,
    annualPricePerMonth: 12,
    videoMinutesPerMonth: 300,
    clipsPerMonth: null,
    clipRetentionDays: null,
    characterLimit: 1_000_000,
    maxVideoMb: 500,
    exportsPerHour: 20,
    maxResolution: "1080p",
    watermark: false,
    cloudSave: true,
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
    apiAccess: true,
  },
};

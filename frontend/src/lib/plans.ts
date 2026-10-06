export type Plan = "FREE" | "PRO" | "ENTERPRISE";

export interface PlanDefinition {
  id: Plan;
  name: string;
  monthlyPrice: number;
  annualPricePerMonth: number;
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
    characterLimit: 10_000,
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
    monthlyPrice: 12,
    annualPricePerMonth: 9.6,
    characterLimit: 200_000,
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
    characterLimit: 2_000_000,
    maxVideoMb: 2048,
    exportsPerHour: 100,
    maxResolution: "4K",
    watermark: false,
    cloudSave: true,
    apiAccess: true,
  },
};

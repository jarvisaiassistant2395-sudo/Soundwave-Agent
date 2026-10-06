// ── The brand kit, from the app's side ───────────────────────────────────────
// The server owns what a "style" means (server/src/lib/brand.ts) — this only
// carries it across. That is deliberate: the Settings preview, and the clip the
// renderer draws, read the same `applied` object, so they cannot disagree.

export type CaptionStyleId = "house" | "bold" | "boxed" | "karaoke" | "minimal";

export interface BrandKit {
  name: string;
  captionStyle: CaptionStyleId;
  captionColor: string;
  accentColor: string;
  updatedAt?: string;
}

/** What ffmpeg will actually be handed — the preset merged with the colours. */
export interface AppliedCaptionStyle {
  fontSize?: number;
  fontWeight?: number;
  color?: string;
  strokeEnabled?: boolean;
  strokeColor?: string;
  strokeWidth?: number;
  bgOpacity?: number;
  shadowEnabled?: boolean;
  vAlign?: "top" | "middle" | "bottom";
  hAlign?: "left" | "center" | "right";
}

export interface CaptionStylePreset {
  id: CaptionStyleId;
  label: string;
  description: string;
  overrides: AppliedCaptionStyle;
}

export interface BrandPayload {
  brand: BrandKit;
  defaults: BrandKit;
  styles: CaptionStylePreset[];
  applied: AppliedCaptionStyle;
}

async function call<T>(method: "GET" | "PUT" | "DELETE", body?: unknown): Promise<T> {
  const res = await fetch("/api/v1/brand", {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: { message?: string } };
  if (!res.ok) {
    const err = new Error(data.error?.message || `HTTP ${res.status}`) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  return data;
}

export const brandApi = {
  get: () => call<BrandPayload>("GET"),
  save: (patch: Partial<Pick<BrandKit, "name" | "captionStyle" | "captionColor" | "accentColor">>) =>
    call<{ ok: boolean; brand: BrandKit; applied: AppliedCaptionStyle }>("PUT", patch),
  reset: () => call<{ ok: boolean; brand: BrandKit; applied: AppliedCaptionStyle }>("DELETE"),
};

/** The brand colours a channel post should carry, for menus that want a dot. */
export function brandAccent(payload: BrandPayload | null): string {
  return payload?.brand.accentColor ?? "#22D3EE";
}

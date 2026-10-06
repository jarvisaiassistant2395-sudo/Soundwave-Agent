// ── Fetching the briefing's news feeds on the phone ─────────────────────────
// GitHub, Hacker News and Google News (the backup when Google Search isn't
// available — see server/src/lib/brain/core/research.ts). In the Android app
// they're fetched natively (CapacitorHttp), so feeds that don't allow web
// pages (Google News RSS) work too; in a desktop browser, plain fetch.

import { Capacitor, CapacitorHttp } from "@capacitor/core";
import type { FetchText } from "../../../server/src/lib/brain/core/research";

export const phoneFetchText: FetchText = async (url, opts = {}) => {
  try {
    if (Capacitor.isNativePlatform()) {
      const r = await CapacitorHttp.get({ url, responseType: "text", connectTimeout: 10_000, readTimeout: 10_000, headers: { Accept: "application/json, application/rss+xml, text/xml;q=0.9, */*;q=0.5" } });
      if (r.status < 200 || r.status >= 300) return null;
      return typeof r.data === "string" ? r.data : JSON.stringify(r.data);
    }
    const res = await fetch(url, { signal: opts.signal });
    return res.ok ? await res.text() : null;
  } catch {
    return null;
  }
};

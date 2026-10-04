import { useEffect, useState } from "react";
import { http } from "../lib/api";

// Which OAuth providers are actually configured on the server. The auth pages
// use this to hide buttons that would otherwise dead-end at a
// "not available in this deployment" page (e.g. local dev with no Google
// credentials set). `null` = still loading; failures degrade to "hidden".
export function useOAuthProviders(): { google: boolean } | null {
  const [providers, setProviders] = useState<{ google: boolean } | null>(null);

  useEffect(() => {
    let alive = true;
    http
      .get<{ providers: { google: boolean } }>("/auth/providers", { skipAuth: true })
      .then((r) => {
        if (alive) setProviders(r.providers);
      })
      .catch(() => {
        if (alive) setProviders({ google: false });
      });
    return () => {
      alive = false;
    };
  }, []);

  return providers;
}

import { useEffect, useState } from "react";
import { http } from "../lib/api";

/**
 * What the welcome screen needs to know before anyone presses a button: is
 * there a Google app to sign in with, and (a development build with none) may
 * this PC be opened without one. `null` = still asking; failures degrade to
 * "no Google app", which is the honest answer when the server can't be reached.
 */
export interface SignInAvailability {
  google: boolean;
  /** Development builds only — never set on a packaged build. */
  devSignIn: boolean;
}

export function useOAuthProviders(): SignInAvailability | null {
  const [providers, setProviders] = useState<SignInAvailability | null>(null);

  useEffect(() => {
    let alive = true;
    http
      .get<{ providers: { google: boolean }; devSignIn?: boolean }>("/auth/providers", { skipAuth: true })
      .then((r) => {
        if (alive) setProviders({ google: Boolean(r.providers?.google), devSignIn: Boolean(r.devSignIn) });
      })
      .catch(() => {
        if (alive) setProviders({ google: false, devSignIn: false });
      });
    return () => {
      alive = false;
    };
  }, []);

  return providers;
}

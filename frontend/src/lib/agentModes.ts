import { useCallback, useEffect, useState } from "react";
import { api } from "./api";

// ── The agent's modes (GET/PUT /api/v1/agent/modes) ─────────────────────────
// The catalog lives on the server (server/src/lib/brain/core/persona.ts) so the
// PC, the phone and the API can never drift: the app only renders what it is
// told, and the mode it saves is the one the next reply is written in.

export type AgentModeId = "professional" | "friendly" | "coach" | "analyst" | "calm";

export interface AgentMode {
  id: AgentModeId;
  name: string;
  tagline: string;
  description: string;
  /** Lucide icon name — see modeIcon(). */
  icon: string;
  /** A taste of the voice, in the mode's own words. */
  sample: string;
  /** True when the mode addresses the person by a title (the field is offered). */
  addresses: boolean;
  defaultAddress?: string;
}

export interface ModesState {
  personas: AgentMode[];
  current: {
    persona: AgentModeId;
    name: string;
    tagline: string;
    address: string | null;
    addressSet: boolean;
    addresses: boolean;
  };
  defaultPersona: AgentModeId;
  updatedAt: string | null;
}

/** The last mode the app saw, so the header never flashes empty on a reload. */
const CACHE_KEY = "soundwave_agent_mode";
export const MODES_CHANGED_EVENT = "soundwave:modes";

export interface ModesChangedDetail {
  persona: AgentModeId;
  address: string | null;
}

function cached(): ModesState["current"] | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ModesState["current"];
    return parsed?.persona ? parsed : null;
  } catch {
    return null;
  }
}

function remember(current: ModesState["current"]): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(current));
  } catch {
    /* private mode: the header just shows the default until the server answers */
  }
}

export async function fetchModes(): Promise<ModesState> {
  const state = await api<ModesState>("/agent/modes");
  remember(state.current);
  return state;
}

export async function saveMode(patch: { persona?: AgentModeId; address?: string | null }): Promise<ModesState> {
  const state = await api<ModesState>("/agent/modes", { method: "PUT", body: patch });
  remember(state.current);
  window.dispatchEvent(new CustomEvent<ModesChangedDetail>(MODES_CHANGED_EVENT, { detail: { persona: state.current.persona, address: state.current.address } }));
  return state;
}

/** The mode in use, refreshed whenever it is changed anywhere in the app. */
export function useAgentModes(): {
  modes: AgentMode[];
  current: ModesState["current"] | null;
  loading: boolean;
  error: string | null;
  setMode: (persona: AgentModeId, address?: string | null) => Promise<ModesState | null>;
  refresh: () => Promise<void>;
} {
  const [modes, setModes] = useState<AgentMode[]>([]);
  const [current, setCurrent] = useState<ModesState["current"] | null>(() => cached());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const state = await fetchModes();
      setModes(state.personas);
      setCurrent(state.current);
      setError(null);
    } catch (err) {
      setError((err as Error).message || "Could not read the assistant's modes.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const onChanged = (e: Event) => {
      const detail = (e as CustomEvent<ModesChangedDetail>).detail;
      if (detail?.persona) {
        setCurrent((was) => ({
          persona: detail.persona,
          name: was?.persona === detail.persona ? was.name : (was?.name ?? "Assistant"),
          tagline: was?.tagline ?? "",
          address: detail.address ?? null,
          addressSet: Boolean(detail.address),
          addresses: was?.persona === detail.persona ? (was.addresses ?? false) : false,
        }));
      }
      void refresh();
    };
    window.addEventListener(MODES_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(MODES_CHANGED_EVENT, onChanged);
  }, [refresh]);

  // The agent switches its own mode mid-conversation (the set_mode tool): the
  // header has to follow without the person touching anything.
  useEffect(() => {
    const timer = window.setInterval(() => {
      void fetchModes()
        .then((state) => {
          setModes(state.personas);
          setCurrent((was) => (was?.persona === state.current.persona && was?.address === state.current.address ? was : state.current));
        })
        .catch(() => {
          /* offline: keep what the header is showing */
        });
    }, 20_000);
    return () => window.clearInterval(timer);
  }, []);

  const setMode = useCallback(
    async (persona: AgentModeId, address?: string | null) => {
      try {
        const state = await saveMode({ persona, ...(address === undefined ? {} : { address }) });
        setModes(state.personas);
        setCurrent(state.current);
        setError(null);
        return state;
      } catch (err) {
        setError((err as Error).message || "Could not change the mode.");
        return null;
      }
    },
    [],
  );

  return { modes, current, loading, error, setMode, refresh };
}

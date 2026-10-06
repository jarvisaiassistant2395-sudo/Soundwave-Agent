import { useCallback, useEffect, useState } from "react";
import { toast } from "../store/toast";

/** GET /api/v1/email/policy — the switch and cap behind "the agent can send". */
export interface GmailSendPolicyView {
  enabled: boolean;
  dailyLimit: number;
  sentToday: number;
  remaining: number;
  connected: boolean;
  scopes: { gmail: boolean; contacts: boolean; calendar: boolean; drive: boolean };
  sent: Array<{ at: number; to: string; subject: string; source: "agent" | "app" }>;
}

/** GET /api/v1/email/scheduled — email written now that goes out at a set time. */
export interface GmailScheduledView {
  id: string;
  at: number;
  /** The words the person used: "at 17:00", "tomorrow at 09:00". */
  when: string;
  /** "in 2 hours", or what happened for a finished one. */
  due: string;
  atLocal: string;
  to: string;
  cc?: string;
  bcc?: string;
  subject: string;
  body: string;
  status: "scheduled" | "sending" | "sent" | "failed" | "missed" | "cancelled";
  attempts: number;
  lastError?: string;
  sentAt?: number;
  lateBy?: number;
}

/** GET /api/v1/email/status — the Google connection and what it may do. */
export interface GmailStatus {
  connected: boolean;
  email: string | null;
  needsReconnect: boolean;
  scopes: { gmail: boolean; contacts: boolean; calendar: boolean; drive: boolean };
  sending: { enabled: boolean; dailyLimit: number; sentToday: number; remaining: number };
}

/** What Google looks like before anyone connects it — and after they disconnect. */
const DISCONNECTED: GmailStatus = {
  connected: false,
  email: null,
  needsReconnect: false,
  scopes: { gmail: false, contacts: false, calendar: false, drive: false },
  sending: { enabled: true, dailyLimit: 25, sentToday: 0, remaining: 25 },
};

/**
 * Google's mailbox, as Settings → Email shows it: whether it's connected, what
 * the agent may do with it, the email it wrote for a later moment, and the four
 * things a person can do about any of that — connect, disconnect, change the
 * sending cap, take one back before it goes out.
 *
 * Lifted out of AgentHub because the two had grown into each other: the screen
 * should hold the layout, and this holds the conversation with the server. The
 * names are unchanged so the JSX that reads them didn't have to move.
 */
export function useGmail() {
  const [gmailPolicy, setGmailPolicy] = useState<GmailSendPolicyView | null>(null);
  const [gmailStatus, setGmailStatus] = useState<GmailStatus>(DISCONNECTED);
  const [isConnectingGmail, setIsConnectingGmail] = useState(false);
  const [isSavingGmailPolicy, setIsSavingGmailPolicy] = useState(false);
  /** Email the agent queued for a later moment, and the recent ones it sent. */
  const [gmailScheduled, setGmailScheduled] = useState<{ scheduled: GmailScheduledView[]; history: GmailScheduledView[] } | null>(null);
  const [cancellingScheduledId, setCancellingScheduledId] = useState("");

  const fetchGmailStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/v1/email/status");
      if (res.ok) setGmailStatus(await res.json());
    } catch {}
  }, []);

  /** The sending policy + what was sent — Settings → Email shows both. */
  const fetchGmailPolicy = useCallback(async () => {
    try {
      const res = await fetch("/api/v1/email/policy");
      if (res.ok) setGmailPolicy(await res.json());
    } catch {}
  }, []);

  const fetchGmailScheduled = useCallback(async () => {
    try {
      const res = await fetch("/api/v1/email/scheduled");
      if (res.ok) setGmailScheduled(await res.json());
    } catch {}
  }, []);

  // Ask once when the screen opens; the three are independent, so they go together.
  useEffect(() => {
    void fetchGmailStatus();
    void fetchGmailPolicy();
    void fetchGmailScheduled();
  }, [fetchGmailStatus, fetchGmailPolicy, fetchGmailScheduled]);

  /** Takes one back before it goes out. Nothing is sent after this returns. */
  const cancelScheduledEmail = async (id: string, subject: string) => {
    setCancellingScheduledId(id);
    try {
      const res = await fetch(`/api/v1/email/scheduled/${encodeURIComponent(id)}`, { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error?.message || "Couldn't cancel that one.");
      toast.success("Scheduled email cancelled", `“${subject || "(no subject)"}” won't be sent.`);
      void fetchGmailScheduled();
    } catch (err) {
      toast.error("Scheduled email", (err as Error).message);
    } finally {
      setCancellingScheduledId("");
    }
  };

  /**
   * Move the daily cap while it's being typed. Saving waits for the blur, so the
   * field can show the number before the server has agreed to it.
   */
  const previewDailyLimit = (value: number) => {
    setGmailStatus((current) => ({
      ...current,
      sending: {
        ...current.sending,
        dailyLimit: Number.isFinite(value) ? value : current.sending.dailyLimit,
      },
    }));
  };

  const saveGmailPolicy = async (patch: { enabled?: boolean; dailyLimit?: number }) => {
    setIsSavingGmailPolicy(true);
    try {
      const res = await fetch("/api/v1/email/policy", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error?.message || "Couldn't save that.");
      setGmailPolicy(data);
      setGmailStatus((current) => ({
        ...current,
        sending: { enabled: data.enabled, dailyLimit: data.dailyLimit, sentToday: data.sentToday, remaining: data.remaining },
        scopes: data.scopes ?? current.scopes,
      }));
      toast.success(
        patch.enabled === false ? "Sending turned off" : patch.enabled === true ? "Sending turned on" : "Saved",
        patch.enabled === false
          ? "The agent will only save drafts from now on."
          : `The agent may send up to ${data.dailyLimit} emails a day from chat.`,
      );
    } catch (err) {
      toast.error("Email settings", (err as Error).message);
    } finally {
      setIsSavingGmailPolicy(false);
    }
  };

  // Gmail access is separate from YouTube: the user grants mailbox scopes in
  // Google's browser consent screen. The agent can save drafts, never send them.
  const handleConnectGmail = async () => {
    try {
      setIsConnectingGmail(true);
      const res = await fetch("/api/v1/email/connect", { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error?.message || "Couldn't start Gmail sign-in.");
      window.open(data.url, "_blank", "noopener,noreferrer");
      toast.info("Finish in your browser", "Review Google's Gmail permissions, then return here.");
      const until = Date.now() + 5 * 60_000;
      while (Date.now() < until) {
        await new Promise((resolve) => setTimeout(resolve, 2500));
        const status = await fetch("/api/v1/email/status").then((r) => r.json()).catch(() => null);
        if (status?.connected) {
          setGmailStatus(status);
          void fetchGmailPolicy();
          void fetchGmailScheduled();
          toast.success("Google connected", status.email || "Your inbox is ready.");
          return;
        }
      }
      await fetchGmailStatus();
    } catch (err) {
      toast.error("Gmail", (err as Error).message);
    } finally {
      setIsConnectingGmail(false);
    }
  };

  const handleDisconnectGmail = async () => {
    if (!window.confirm(`Disconnect ${gmailStatus.email || "Gmail"} from Soundwave? Existing drafts in Gmail will remain.`)) return;
    try {
      const res = await fetch("/api/v1/email/disconnect", { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error?.message || "Couldn't disconnect Gmail.");
      setGmailStatus(DISCONNECTED);
      void fetchGmailPolicy();
      void fetchGmailScheduled();
      toast.success("Google disconnected", "Soundwave can no longer read, draft or send email.");
    } catch (err) {
      toast.error("Gmail", (err as Error).message);
    }
  };

  return {
    gmailPolicy,
    gmailStatus,
    gmailScheduled,
    cancellingScheduledId,
    isConnectingGmail,
    isSavingGmailPolicy,
    fetchGmailStatus,
    fetchGmailPolicy,
    fetchGmailScheduled,
    cancelScheduledEmail,
    previewDailyLimit,
    saveGmailPolicy,
    handleConnectGmail,
    handleDisconnectGmail,
  };
}

import { useEffect, useState } from "react";
import { ExternalLink, Mail, Send, ShieldCheck } from "lucide-react";
import { Button } from "../ui/Button";
import { Modal } from "../ui/Modal";
import { toast } from "../../store/toast";

interface Draft {
  id: string;
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  body: string;
  attachments: string[];
  fingerprint: string;
}

export function EmailDraftCard({ draftId }: { draftId: string }) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [reloadCount, setReloadCount] = useState(0);

  useEffect(() => {
    let current = true;
    setLoading(true);
    fetch(`/api/v1/email/drafts/${encodeURIComponent(draftId)}`)
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data?.error?.message || "Couldn't load this Gmail draft.");
        return data.draft as Draft;
      })
      .then((value) => {
        if (current) {
          setDraft(value);
          setError(null);
        }
      })
      .catch((err) => {
        if (current) setError((err as Error).message);
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [draftId, reloadCount]);

  const hasRecipient = Boolean(draft && [draft.to, draft.cc, draft.bcc].some((value) => value.trim()));

  const sendAfterConfirmation = async () => {
    if (!draft) return;
    setSending(true);
    try {
      const res = await fetch(`/api/v1/email/drafts/${encodeURIComponent(draft.id)}/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmSend: true, fingerprint: draft.fingerprint }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error?.message || "The email was not sent.");
      setSent(true);
      setReviewOpen(false);
      toast.success("Email sent", `Sent to ${draft.to}.`);
    } catch (err) {
      setReviewOpen(false);
      setReloadCount((value) => value + 1);
      const message = (err as Error).message;
      setError(message);
      toast.error("Email not sent", message);
    } finally {
      setSending(false);
    }
  };

  return (
    <>
      <section className="mt-3 rounded-lg border border-cyan-500/30 bg-[#081323] p-3 text-[11px]" aria-label="Gmail reply draft">
        <div className="flex items-center gap-2 text-cyan-200">
          <Mail className="h-4 w-4 shrink-0" />
          <b>{sent ? "Email sent" : "Unsent Gmail draft"}</b>
          <span className="ml-auto inline-flex items-center gap-1 rounded border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.5 text-[9px] text-emerald-300">
            <ShieldCheck className="h-3 w-3" /> {sent ? "Confirmed" : "Not sent"}
          </span>
        </div>
        {loading ? <p className="mt-2 text-gray-400">Loading the saved draft…</p> : error ? <p className="mt-2 text-amber-200">{error}</p> : draft ? (
          <>
            <p className="mt-2 truncate text-gray-300"><span className="text-gray-500">To:</span> {draft.to}</p>
            {draft.cc && <p className="mt-1 truncate text-gray-300"><span className="text-gray-500">Cc:</span> {draft.cc}</p>}
            {draft.bcc && <p className="mt-1 truncate text-gray-300"><span className="text-gray-500">Bcc:</span> {draft.bcc}</p>}
            <p className="mt-1 truncate text-gray-300"><span className="text-gray-500">Subject:</span> {draft.subject}</p>
            {draft.attachments.length > 0 && <p className="mt-1 truncate text-amber-200">Attachments: {draft.attachments.join(", ")}</p>}
            {!sent && (
              <div className="mt-2 flex flex-wrap items-center gap-2">
                {draft.attachments.length === 0 ? (
                  <Button size="sm" variant="outline" onClick={() => setReviewOpen(true)}>
                    <ShieldCheck className="h-3.5 w-3.5" /> Review before sending
                  </Button>
                ) : (
                  <span className="text-amber-200">Review attachments and send from Gmail.</span>
                )}
                <a href="https://mail.google.com/mail/u/0/#drafts" target="_blank" rel="noopener noreferrer" className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-white/10 px-2.5 text-[10px] text-gray-300 hover:border-white/20 hover:text-white">
                  Edit in Gmail <ExternalLink className="h-3 w-3" />
                </a>
              </div>
            )}
          </>
        ) : null}
      </section>

      <Modal
        open={reviewOpen && Boolean(draft) && !sent && draft?.attachments.length === 0}
        onClose={() => setReviewOpen(false)}
        title="Review email before sending"
        description="Soundwave will send only after you confirm below."
        size="lg"
        closeOnBackdrop={!sending}
        footer={(
          <>
            <Button variant="outline" size="sm" onClick={() => setReviewOpen(false)} disabled={sending}>Keep as draft</Button>
            <Button variant="danger" size="sm" loading={sending} disabled={!hasRecipient} onClick={() => void sendAfterConfirmation()} icon={<Send className="h-3.5 w-3.5" />}>
              Send this email
            </Button>
          </>
        )}
      >
        {draft && (
          <div className="space-y-3 text-xs">
            <div><div className="text-gray-500">To</div><div className="mt-0.5 break-all text-white">{draft.to || "(no recipient)"}</div></div>
            {draft.cc && <div><div className="text-gray-500">Cc</div><div className="mt-0.5 break-all text-white">{draft.cc}</div></div>}
            {draft.bcc && <div><div className="text-gray-500">Bcc</div><div className="mt-0.5 break-all text-white">{draft.bcc}</div></div>}
            <div><div className="text-gray-500">Subject</div><div className="mt-0.5 break-words text-white">{draft.subject}</div></div>
            {draft.attachments.length > 0 && <div><div className="text-gray-500">Attachments</div><div className="mt-0.5 break-words text-amber-200">{draft.attachments.join(", ")}</div></div>}
            <div><div className="text-gray-500">Message</div><pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-[#172A4A] bg-[#070D18] p-3 font-sans text-gray-200">{draft.body}</pre></div>
            <p className="text-amber-200">This is the exact recipient and message Soundwave is about to send. Choose “Keep as draft” to leave it unsent.</p>
          </div>
        )}
      </Modal>
    </>
  );
}

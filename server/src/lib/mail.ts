import { config } from "../config.js";

// ── Transactional email ─────────────────────────────────────────────────────
// Resend in production. In development, emails are logged to the console so
// the full flow can be exercised without an API key. No email data is ever
// sent anywhere except the configured provider.

interface MailOptions {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export async function sendMail(opts: MailOptions): Promise<void> {
  if (config.resendApiKey && config.isProd) {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.resendApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: config.emailFrom,
        to: [opts.to],
        subject: opts.subject,
        text: opts.text,
        html: opts.html ?? opts.text,
      }),
    });
    if (!res.ok) {
      throw new Error(`Email send failed: ${res.status}`);
    }
    return;
  }
  // Development: log instead of sending.
  console.log(`\n📧 [mail] to=${opts.to} subject="${opts.subject}"\n${opts.text}\n`);
}

export function verificationEmail(to: string, name: string, token: string): MailOptions {
  const url = `${config.appUrl}/verify-email?token=${token}`;
  return {
    to,
    subject: "Verify your email — Soundwave AI",
    text: `Hi ${name},\n\nPlease verify your email address by clicking the link below (valid for 24 hours):\n\n${url}\n\nIf you did not create an account, you can ignore this email.`,
    html: `<p>Hi ${name},</p><p>Verify your email by clicking the link below (valid for 24 hours):</p><p><a href="${url}">${url}</a></p><p>If you did not create an account, you can ignore this email.</p>`,
  };
}

export function passwordResetEmail(to: string, name: string, token: string): MailOptions {
  const url = `${config.appUrl}/reset-password?token=${token}`;
  return {
    to,
    subject: "Reset your password — Soundwave AI",
    text: `Hi ${name},\n\nReset your password here (valid for 1 hour):\n\n${url}\n\nIf you did not request this, you can ignore this email.`,
    html: `<p>Hi ${name},</p><p>Reset your password here (valid for 1 hour):</p><p><a href="${url}">${url}</a></p><p>If you did not request this, you can ignore this email.</p>`,
  };
}

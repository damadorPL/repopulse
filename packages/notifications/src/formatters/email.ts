import nodemailer from "nodemailer";
import { NotificationDeliveryError } from "../errors.js";
import { escapeHtml, markdownToEmailHtml, releaseKindLabel, releaseSummary, truncateText } from "../markdown.js";
import type { MessageContext, SemverType } from "../types.js";

/** Release notes beyond this are cut; the email links to the full notes. */
const EMAIL_SUMMARY_LIMIT = 8000;

const BADGE_COLORS: Record<SemverType, { bg: string; fg: string }> = {
  MAJOR: { bg: "#fee2e2", fg: "#b91c1c" },
  MINOR: { bg: "#dbeafe", fg: "#1d4ed8" },
  PATCH: { bg: "#d1fae5", fg: "#047857" },
  PRERELEASE: { bg: "#fef3c7", fg: "#b45309" },
  OTHER: { bg: "#f1f5f9", fg: "#475569" },
};

// ─── SMTP configuration ────────────────────────────────────────────────────

export interface SmtpConfig {
  host: string;
  port: number;
  /** Implicit TLS (port 465). Otherwise STARTTLS is used when the server offers it. */
  secure: boolean;
  user: string | undefined;
  pass: string | undefined;
  from: string;
}

/** `SMTP_HOST` enables email; `SMTP_PORT` (587), `SMTP_USER`/`SMTP_PASS`, `SMTP_SECURE`, `SMTP_FROM` are optional. */
export function readSmtpConfig(env: Record<string, string | undefined> = process.env): SmtpConfig | null {
  const host = env.SMTP_HOST?.trim();
  if (!host) return null;
  const port = Number(env.SMTP_PORT?.trim() || 587);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new NotificationDeliveryError(`SMTP_PORT "${env.SMTP_PORT}" is not a valid port.`, { permanent: true });
  }
  const secureRaw = env.SMTP_SECURE?.trim().toLowerCase();
  const secure = secureRaw ? secureRaw === "true" || secureRaw === "1" : port === 465;
  const user = env.SMTP_USER?.trim() || undefined;
  const pass = env.SMTP_PASS || undefined;
  const from = env.SMTP_FROM?.trim() || (user?.includes("@") ? `RepoPulse <${user}>` : `RepoPulse <repopulse@${host}>`);
  return { host, port, secure, user, pass, from };
}

export function isSmtpConfigured(env: Record<string, string | undefined> = process.env): boolean {
  return Boolean(env.SMTP_HOST?.trim());
}

export interface EmailMessage {
  from: string;
  to: string;
  subject: string;
  text: string;
  html: string;
}

export type MailSender = (message: EmailMessage) => Promise<void>;

const transports = new Map<string, ReturnType<typeof nodemailer.createTransport>>();

/** Nodemailer SMTP transport, reused per configuration (pooled connections, 15 s timeouts). */
export function createSmtpSender(config: SmtpConfig): MailSender {
  const key = JSON.stringify([config.host, config.port, config.secure, config.user, config.pass]);
  let transport = transports.get(key);
  if (!transport) {
    transport = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.secure,
      ...(config.user ? { auth: { user: config.user, pass: config.pass ?? "" } } : {}),
      connectionTimeout: 15_000,
      greetingTimeout: 15_000,
      socketTimeout: 30_000,
    });
    transports.set(key, transport);
  }
  const mailer = transport;
  return async (message) => {
    try {
      await mailer.sendMail(message);
    } catch (error) {
      throw smtpError(error);
    }
  };
}

/** SMTP 5xx replies and authentication failures are permanent; 4xx and connection errors are retried. */
function smtpError(error: unknown): NotificationDeliveryError {
  const err = error as { code?: string; responseCode?: number; response?: string; message?: string };
  const responseCode = typeof err.responseCode === "number" ? err.responseCode : undefined;
  const permanent = err.code === "EAUTH" || err.code === "EENVELOPE" || (responseCode !== undefined && responseCode >= 500);
  const detail = (err.response ?? err.message ?? "unknown error").split(/\r?\n/, 1)[0]?.slice(0, 200);
  const label = err.code === "EAUTH" ? "SMTP authentication failed" : "The SMTP server rejected the email";
  return new NotificationDeliveryError(`${permanent ? label : "Sending the email failed"}: ${detail}`, {
    permanent,
    cause: error,
  });
}

// ─── Template ──────────────────────────────────────────────────────────────

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

function button(href: string, label: string, primary: boolean): string {
  const style = primary
    ? "background:#0f172a;color:#ffffff;border:1px solid #0f172a"
    : "background:#ffffff;color:#0f172a;border:1px solid #cbd5e1";
  return `<a href="${escapeHtml(href)}" style="display:inline-block;${style};border-radius:6px;padding:10px 16px;font-size:14px;font-weight:600;text-decoration:none;margin:0 8px 8px 0">${escapeHtml(label)}</a>`;
}

/** Responsive single-column HTML email (inline styles only, for email clients) plus a plain-text part. */
export function renderReleaseEmail(ctx: MessageContext): RenderedEmail {
  const { release, repository, rule } = ctx;
  const kind = releaseKindLabel(release);
  const summary = truncateText(releaseSummary(release), EMAIL_SUMMARY_LIMIT);
  const badge = BADGE_COLORS[release.semverType];
  const settingsUrl = `${ctx.appBaseUrl}/settings/notifications`;
  const published = release.publishedAt.toUTCString().replace(/:\d\d GMT$/, " UTC");
  const showTitle = release.title && release.title !== release.tagName;

  const subject = `${ctx.test ? "[Test] " : ""}${repository.fullName} ${release.tagName} released${release.semverType === "MAJOR" ? " (major)" : ""}`;

  const text = [
    ctx.test ? "This is a test notification from RepoPulse.\n" : null,
    `${repository.fullName} ${release.tagName} — ${kind}`,
    showTitle ? release.title : null,
    `Published ${published}`,
    "",
    summary,
    "",
    `Open in RepoPulse: ${ctx.readerUrl}`,
    `On GitHub: ${release.htmlUrl}`,
    "",
    `—\nSent by a RepoPulse notification rule${rule.tag ? ` for the tag "${rule.tag.name}"` : ""}. Manage rules: ${settingsUrl}`,
  ]
    .filter((line) => line !== null)
    .join("\n");

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>${escapeHtml(subject)}</title>
</head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#0f172a">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9">
<tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border:1px solid #e2e8f0;border-radius:10px">
<tr><td style="padding:20px 24px;border-bottom:1px solid #e2e8f0;font-size:14px;font-weight:700;letter-spacing:-0.01em">RepoPulse${ctx.test ? ' <span style="font-weight:500;color:#64748b">· test notification</span>' : ""}</td></tr>
<tr><td style="padding:24px 24px 8px">
<p style="margin:0 0 6px;font-size:13px;color:#64748b">${escapeHtml(repository.fullName)}</p>
<p style="margin:0 0 10px;font-size:22px;line-height:1.3;font-weight:700;word-break:break-word">${escapeHtml(release.tagName)}
<span style="display:inline-block;vertical-align:middle;margin-left:6px;padding:3px 8px;border-radius:999px;background:${badge.bg};color:${badge.fg};font-size:12px;font-weight:600">${escapeHtml(kind)}</span></p>
${showTitle ? `<p style="margin:0 0 6px;font-size:15px;font-weight:600">${escapeHtml(release.title)}</p>` : ""}
<p style="margin:0;font-size:13px;color:#64748b">Published ${escapeHtml(published)}${rule.tag ? ` · Tag <strong style="color:${escapeHtml(rule.tag.colorHex)}">${escapeHtml(rule.tag.name)}</strong>` : ""}</p>
</td></tr>
<tr><td style="padding:16px 24px 8px;font-size:14px;line-height:1.6;word-break:break-word">
${markdownToEmailHtml(summary)}
</td></tr>
<tr><td style="padding:8px 24px 20px">
${button(ctx.readerUrl, "Open in RepoPulse", true)}${button(release.htmlUrl, release.source === "TAG" ? "View on GitHub" : "Release notes on GitHub", false)}
</td></tr>
<tr><td style="padding:16px 24px;border-top:1px solid #e2e8f0;font-size:12px;line-height:1.5;color:#64748b">
Sent by a RepoPulse notification rule${rule.tag ? ` for the tag “${escapeHtml(rule.tag.name)}”` : " for all repositories"}.
<a href="${escapeHtml(settingsUrl)}" style="color:#64748b">Manage notification rules</a>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;

  return { subject, text, html };
}

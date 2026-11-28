import nodemailer, { type Transporter } from "nodemailer";

import { NotificationDeliveryError } from "../errors.js";
import {
  escapeHtml,
  githubLinkLabel,
  markdownToEmailHtml,
  releaseKindLabel,
  releaseSummary,
  safeHexColor,
  safeHttpUrl,
  truncateText,
} from "../markdown.js";
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

/**
 * The SMTP columns of `InstanceSettings` (Admin → Email), with the password already decrypted.
 * Structural, so this package doesn't depend on `@repopulse/db`.
 */
export interface StoredSmtpSettings {
  smtpHost: string | null;
  smtpPort: number;
  /** `null` = automatic: implicit TLS on port 465, STARTTLS otherwise. */
  smtpSecure: boolean | null;
  smtpUser: string | null;
  smtpPassword: string | null;
  smtpFrom: string | null;
}

/** The sender used when none is set: `RepoPulse <user>` when the username is an address. */
export function defaultSmtpFrom(host: string, user: string | null | undefined): string {
  return user?.includes("@") ? `RepoPulse <${user}>` : `RepoPulse <repopulse@${host}>`;
}

/** Transport settings, or `null` while no host is set (email is off). */
export function toSmtpConfig(settings: StoredSmtpSettings | null | undefined): SmtpConfig | null {
  const host = settings?.smtpHost?.trim();
  if (!settings || !host) return null;
  const port = settings.smtpPort;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new NotificationDeliveryError(`SMTP port "${port}" is not a valid port.`, { permanent: true });
  }
  const secure = settings.smtpSecure ?? port === 465;
  const trimmedUser = settings.smtpUser?.trim();
  const user = trimmedUser !== undefined && trimmedUser.length > 0 ? trimmedUser : undefined;
  const pass =
    user && settings.smtpPassword !== null && settings.smtpPassword.length > 0 ? settings.smtpPassword : undefined;
  const trimmedFrom = settings.smtpFrom?.trim();
  const from = trimmedFrom !== undefined && trimmedFrom.length > 0 ? trimmedFrom : defaultSmtpFrom(host, user);
  return { host, port, secure, user, pass, from };
}

export interface EmailMessage {
  from: string;
  to: string;
  subject: string;
  text: string;
  html: string;
}

export type MailSender = (message: EmailMessage) => Promise<void>;

interface CachedSmtpTransport {
  host: string;
  port: number;
  secure: boolean;
  user: string | undefined;
  pass: string | undefined;
  transport: Transporter;
}

let cachedTransport: CachedSmtpTransport | null = null;

function sameSmtpTransportConfig(cached: CachedSmtpTransport, config: SmtpConfig): boolean {
  return (
    cached.host === config.host &&
    cached.port === config.port &&
    cached.secure === config.secure &&
    cached.user === config.user &&
    cached.pass === config.pass
  );
}

function smtpTransportOptions(config: SmtpConfig) {
  return {
    host: config.host,
    port: config.port,
    secure: config.secure,
    ...(config.user ? { auth: { user: config.user, pass: config.pass ?? "" } } : {}),
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
    dnsTimeout: 10_000,
    tls: { minVersion: "TLSv1.2" as const },
  };
}

/** Closes the cached pooled SMTP transport and clears the transport cache. */
export function closeSmtpTransports(): void {
  const current = cachedTransport;
  if (!current) return;
  cachedTransport = null;
  current.transport.close();
}

/**
 * Verifies an SMTP configuration using an ephemeral (non-pooled) transport and closes it when done.
 * Maps SMTP authentication and connection failures to {@link NotificationDeliveryError}.
 *
 * @internal Exported for unit tests.
 */
export async function verifySmtpConfig(config: SmtpConfig): Promise<void> {
  // oxlint-disable-next-line import/no-named-as-default-member -- nodemailer is CommonJS; tests spy on nodemailer.createTransport.
  const transport = nodemailer.createTransport(smtpTransportOptions(config));
  try {
    await transport.verify();
  } catch (error) {
    throw smtpError(error, "SMTP verification failed");
  } finally {
    transport.close();
  }
}

/**
 * Pooled Nodemailer SMTP transport (15 s connection/greeting timeouts, 10 s DNS timeout, TLS 1.2+),
 * reused while the configuration stays the same. Saving new settings in the UI invalidates the
 * cached transport, and the old transport is closed.
 */
export function createSmtpSender(config: SmtpConfig): MailSender {
  if (!cachedTransport || !sameSmtpTransportConfig(cachedTransport, config)) {
    closeSmtpTransports();
    cachedTransport = {
      host: config.host,
      port: config.port,
      secure: config.secure,
      user: config.user,
      pass: config.pass,
      // oxlint-disable-next-line import/no-named-as-default-member -- nodemailer is CommonJS; tests spy on nodemailer.createTransport.
      transport: nodemailer.createTransport({
        ...smtpTransportOptions(config),
        pool: true,
        maxConnections: 5,
        maxMessages: 100,
      }),
    };
  }
  const mailer = cachedTransport.transport;
  return async (message) => {
    try {
      await mailer.sendMail(message);
    } catch (error) {
      throw smtpError(error);
    }
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** SMTP 5xx replies and authentication failures are permanent; 4xx and connection errors are retried. */
function smtpError(error: unknown, fallbackLabel = "Sending the email failed"): NotificationDeliveryError {
  const err = isRecord(error) ? error : {};
  const code = typeof err.code === "string" ? err.code : undefined;
  const responseCode = typeof err.responseCode === "number" ? err.responseCode : undefined;
  const response = typeof err.response === "string" ? err.response : undefined;
  const message = typeof err.message === "string" ? err.message : undefined;
  const permanent = code === "EAUTH" || code === "EENVELOPE" || (responseCode !== undefined && responseCode >= 500);
  const detail = (response ?? message ?? "unknown error").split(/\r?\n/, 1)[0]?.slice(0, 200);
  const label = code === "EAUTH" ? "SMTP authentication failed" : "The SMTP server rejected the email";
  return new NotificationDeliveryError(`${permanent ? label : fallbackLabel}: ${detail}`, {
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
  const safeHref = safeHttpUrl(href);
  if (!safeHref) return "";
  const style = primary
    ? "background:#0f172a;color:#ffffff;border:1px solid #0f172a"
    : "background:#ffffff;color:#0f172a;border:1px solid #cbd5e1";
  return `<a href="${escapeHtml(safeHref)}" style="display:inline-block;${style};border-radius:6px;padding:10px 16px;font-size:14px;font-weight:600;text-decoration:none;margin:0 8px 8px 0">${escapeHtml(label)}</a>`;
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

  const subject =
    release.source === "COMMIT"
      ? `${ctx.test ? "[Test] " : ""}${repository.fullName}: new commit ${release.tagName}`
      : `${ctx.test ? "[Test] " : ""}${repository.fullName} ${release.tagName} released${release.semverType === "MAJOR" ? " (major)" : ""}`;

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
<p style="margin:0;font-size:13px;color:#64748b">Published ${escapeHtml(published)}${rule.tag ? ` · Tag <strong style="color:${safeHexColor(rule.tag.colorHex)}">${escapeHtml(rule.tag.name)}</strong>` : ""}</p>
</td></tr>
<tr><td style="padding:16px 24px 8px;font-size:14px;line-height:1.6;word-break:break-word">
${markdownToEmailHtml(summary)}
</td></tr>
<tr><td style="padding:8px 24px 20px">
${button(ctx.readerUrl, "Open in RepoPulse", true)}${button(release.htmlUrl, githubLinkLabel(release), false)}
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

import { INSTANCE_SETTINGS_ID, loadSmtpSettings, prisma, SMTP_SETTINGS_SELECT } from "@repopulse/db";
import { defaultSmtpFrom, toSmtpConfig, type SmtpConfig } from "@repopulse/notifications";
import type { SmtpSecurity } from "@/lib/smtp";

/**
 * SMTP settings (Admin → Email). Not a `"use server"` module: nothing here is callable from
 * the browser, and the decrypted password never leaves the server.
 */

/** Transport settings for sending, or `null` while email is off. */
export async function getSmtpConfig(): Promise<SmtpConfig | null> {
  return toSmtpConfig(await loadSmtpSettings(prisma));
}

/** Whether a host is saved; cheap (no decryption), for showing or hiding the email channel. */
export async function isSmtpConfigured(): Promise<boolean> {
  const row = await prisma.instanceSettings.findUnique({ where: { id: INSTANCE_SETTINGS_ID }, select: { smtpHost: true } });
  return Boolean(row?.smtpHost?.trim());
}

export function toSmtpSecurity(secure: boolean | null): SmtpSecurity {
  if (secure === null) return "auto";
  return secure ? "tls" : "starttls";
}

export function fromSmtpSecurity(security: SmtpSecurity): boolean | null {
  if (security === "auto") return null;
  return security === "tls";
}

/** What the Email settings page shows. Never contains the password, only whether one is saved. */
export interface SmtpSettingsView {
  host: string;
  port: number;
  security: SmtpSecurity;
  user: string;
  hasPassword: boolean;
  from: string;
  /** The sender used while `from` is empty. */
  defaultFrom: string | null;
  enabled: boolean;
}

export async function getSmtpSettingsView(): Promise<SmtpSettingsView> {
  const row = await prisma.instanceSettings.findUnique({
    where: { id: INSTANCE_SETTINGS_ID },
    select: SMTP_SETTINGS_SELECT,
  });
  const host = row?.smtpHost ?? "";
  return {
    host,
    port: row?.smtpPort ?? 587,
    security: toSmtpSecurity(row?.smtpSecure ?? null),
    user: row?.smtpUser ?? "",
    hasPassword: Boolean(row?.smtpPasswordEncrypted),
    from: row?.smtpFrom ?? "",
    defaultFrom: host ? defaultSmtpFrom(host, row?.smtpUser) : null,
    enabled: Boolean(host),
  };
}

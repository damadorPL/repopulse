import { decryptToken } from "./crypto.js";
import type { PrismaClient } from "./generated/prisma/client.js";

/** `InstanceSettings` has a single row. */
export const INSTANCE_SETTINGS_ID = 1;

/** The SMTP columns of `InstanceSettings` (Admin → Email). */
export const SMTP_SETTINGS_SELECT = {
  smtpHost: true,
  smtpPort: true,
  smtpSecure: true,
  smtpUser: true,
  smtpPasswordEncrypted: true,
  smtpFrom: true,
} as const;

/** SMTP settings with the password decrypted. Server-side only: never send this to the browser. */
export interface DecryptedSmtpSettings {
  smtpHost: string | null;
  smtpPort: number;
  smtpSecure: boolean | null;
  smtpUser: string | null;
  smtpPassword: string | null;
  smtpFrom: string | null;
}

/** The stored SMTP password can't be decrypted, usually because `TOKEN_ENCRYPTION_KEY` changed. */
export class SmtpPasswordUnreadableError extends Error {
  constructor(options?: { cause?: unknown }) {
    super(
      "The saved SMTP password can't be decrypted (was TOKEN_ENCRYPTION_KEY changed?). The super admin can re-enter it in Admin → Email.",
      options,
    );
    this.name = "SmtpPasswordUnreadableError";
  }
}

/**
 * Reads the SMTP settings, or `null` when the settings row doesn't exist yet.
 * Throws {@link SmtpPasswordUnreadableError} when a stored password can't be decrypted.
 */
export async function loadSmtpSettings(client: Pick<PrismaClient, "instanceSettings">): Promise<DecryptedSmtpSettings | null> {
  const row = await client.instanceSettings.findUnique({ where: { id: INSTANCE_SETTINGS_ID }, select: SMTP_SETTINGS_SELECT });
  if (!row) return null;
  const { smtpPasswordEncrypted, ...rest } = row;
  let smtpPassword: string | null = null;
  if (smtpPasswordEncrypted) {
    try {
      smtpPassword = decryptToken(smtpPasswordEncrypted);
    } catch (error) {
      throw new SmtpPasswordUnreadableError({ cause: error });
    }
  }
  return { ...rest, smtpPassword };
}

/** The release history columns of `InstanceSettings` (Admin → Release history). */
export const BACKFILL_SETTINGS_SELECT = {
  backfillDefaultTarget: true,
  backfillMaxAgeDays: true,
  backfillHardCap: true,
  backfillMinQuota: true,
  backfillDeepStep: true,
  backfillDeepCooldownMinutes: true,
} as const;

/**
 * Admin overrides of the release history settings, keyed like `BackfillConfig` in `@repopulse/queue`
 * (merge them with `applyBackfillOverrides`). `null` = keep the environment / default value.
 */
export interface BackfillSettingsOverrides {
  defaultTarget: number | null;
  maxAgeDays: number | null;
  hardCap: number | null;
  minQuota: number | null;
  deepStep: number | null;
  deepCooldownMinutes: number | null;
}

export const NO_BACKFILL_OVERRIDES: BackfillSettingsOverrides = {
  defaultTarget: null,
  maxAgeDays: null,
  hardCap: null,
  minQuota: null,
  deepStep: null,
  deepCooldownMinutes: null,
};

/** Reads the admin overrides; all `null` when the settings row doesn't exist yet. */
export async function loadBackfillOverrides(client: Pick<PrismaClient, "instanceSettings">): Promise<BackfillSettingsOverrides> {
  const row = await client.instanceSettings.findUnique({ where: { id: INSTANCE_SETTINGS_ID }, select: BACKFILL_SETTINGS_SELECT });
  if (!row) return { ...NO_BACKFILL_OVERRIDES };
  return {
    defaultTarget: row.backfillDefaultTarget,
    maxAgeDays: row.backfillMaxAgeDays,
    hardCap: row.backfillHardCap,
    minQuota: row.backfillMinQuota,
    deepStep: row.backfillDeepStep,
    deepCooldownMinutes: row.backfillDeepCooldownMinutes,
  };
}

/** The GitHub App columns of `InstanceSettings` (Admin → GitHub App, Slice 08 Part B). */
export const GITHUB_APP_SETTINGS_SELECT = {
  githubAppId: true,
  githubAppSlug: true,
  githubAppClientId: true,
  githubAppPrivateKeyEncrypted: true,
  githubAppWebhookSecretEncrypted: true,
  githubAppOwner: true,
} as const;

/** GitHub App settings with the key and the webhook secret decrypted. Server-side only: never send to the browser. */
export interface DecryptedGitHubAppSettings {
  appId: number;
  slug: string;
  clientId: string | null;
  owner: string | null;
  /** PEM private key. */
  privateKey: string;
  webhookSecret: string | null;
}

/** The stored App key or webhook secret can't be decrypted, usually because `TOKEN_ENCRYPTION_KEY` changed. */
export class GitHubAppKeyUnreadableError extends Error {
  constructor(options?: { cause?: unknown }) {
    super(
      "The saved GitHub App key can't be decrypted (was TOKEN_ENCRYPTION_KEY changed?). The super admin can re-enter it in Admin → GitHub App.",
      options,
    );
    this.name = "GitHubAppKeyUnreadableError";
  }
}

/**
 * Reads the GitHub App settings, or `null` when the App is not configured (id, slug and key must all be set).
 * Throws {@link GitHubAppKeyUnreadableError} when a stored secret can't be decrypted.
 */
export async function loadGitHubAppSettings(
  client: Pick<PrismaClient, "instanceSettings">,
): Promise<DecryptedGitHubAppSettings | null> {
  const row = await client.instanceSettings.findUnique({ where: { id: INSTANCE_SETTINGS_ID }, select: GITHUB_APP_SETTINGS_SELECT });
  if (!row || row.githubAppId === null || !row.githubAppSlug || !row.githubAppPrivateKeyEncrypted) return null;
  try {
    return {
      appId: row.githubAppId,
      slug: row.githubAppSlug,
      clientId: row.githubAppClientId,
      owner: row.githubAppOwner,
      privateKey: decryptToken(row.githubAppPrivateKeyEncrypted),
      webhookSecret: row.githubAppWebhookSecretEncrypted ? decryptToken(row.githubAppWebhookSecretEncrypted) : null,
    };
  } catch (error) {
    throw new GitHubAppKeyUnreadableError({ cause: error });
  }
}

/** Whether the Dependencies module is enabled (Admin → Dependencies). `false` when the settings row doesn't exist. */
export async function loadDepsEnabled(client: Pick<PrismaClient, "instanceSettings">): Promise<boolean> {
  const row = await client.instanceSettings.findUnique({ where: { id: INSTANCE_SETTINGS_ID }, select: { depsEnabled: true } });
  return row?.depsEnabled ?? false;
}

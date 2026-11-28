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
export async function loadSmtpSettings(
  client: Pick<PrismaClient, "instanceSettings">,
): Promise<DecryptedSmtpSettings | null> {
  const row = await client.instanceSettings.findUnique({
    where: { id: INSTANCE_SETTINGS_ID },
    select: SMTP_SETTINGS_SELECT,
  });
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
const BACKFILL_SETTINGS_SELECT = {
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

function mapBackfillOverrides(row: {
  backfillDefaultTarget: number | null;
  backfillMaxAgeDays: number | null;
  backfillHardCap: number | null;
  backfillMinQuota: number | null;
  backfillDeepStep: number | null;
  backfillDeepCooldownMinutes: number | null;
}): BackfillSettingsOverrides {
  return {
    defaultTarget: row.backfillDefaultTarget,
    maxAgeDays: row.backfillMaxAgeDays,
    hardCap: row.backfillHardCap,
    minQuota: row.backfillMinQuota,
    deepStep: row.backfillDeepStep,
    deepCooldownMinutes: row.backfillDeepCooldownMinutes,
  };
}

/** Reads the admin overrides; all `null` when the settings row doesn't exist yet. */
export async function loadBackfillOverrides(
  client: Pick<PrismaClient, "instanceSettings">,
): Promise<BackfillSettingsOverrides> {
  const row = await client.instanceSettings.findUnique({
    where: { id: INSTANCE_SETTINGS_ID },
    select: BACKFILL_SETTINGS_SELECT,
  });
  if (!row) return { ...NO_BACKFILL_OVERRIDES };
  return mapBackfillOverrides(row);
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

function isGitHubAppConfiguredRow(row: {
  githubAppId: number | null;
  githubAppSlug: string | null;
  githubAppPrivateKeyEncrypted: string | null;
}): row is {
  githubAppId: number;
  githubAppSlug: string;
  githubAppPrivateKeyEncrypted: string;
} {
  return row.githubAppId !== null && Boolean(row.githubAppSlug) && Boolean(row.githubAppPrivateKeyEncrypted);
}

/**
 * Reads the GitHub App settings, or `null` when the App is not configured (id, slug and key must all be set).
 * Throws {@link GitHubAppKeyUnreadableError} when a stored secret can't be decrypted.
 */
export async function loadGitHubAppSettings(
  client: Pick<PrismaClient, "instanceSettings">,
): Promise<DecryptedGitHubAppSettings | null> {
  const row = await client.instanceSettings.findUnique({
    where: { id: INSTANCE_SETTINGS_ID },
    select: GITHUB_APP_SETTINGS_SELECT,
  });
  if (!row || !isGitHubAppConfiguredRow(row)) return null;
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

/** Combined select for the GitHub App webhook endpoint (`depsEnabled` + webhook verification secret). */
const GITHUB_APP_WEBHOOK_SETTINGS_SELECT = {
  depsEnabled: true,
  githubAppId: true,
  githubAppSlug: true,
  githubAppPrivateKeyEncrypted: true,
  githubAppWebhookSecretEncrypted: true,
} as const;

export interface GitHubAppWebhookSettings {
  depsEnabled: boolean;
  app: { webhookSecret: string | null } | null;
}

/**
 * Loads `depsEnabled` and the GitHub App webhook secret in a single `InstanceSettings` query.
 * Decrypts `githubAppWebhookSecretEncrypted` only when the App is configured, throwing
 * {@link GitHubAppKeyUnreadableError} if the stored webhook secret cannot be decrypted.
 */
export async function loadGitHubAppWebhookSettings(
  client: Pick<PrismaClient, "instanceSettings">,
): Promise<GitHubAppWebhookSettings> {
  const row = await client.instanceSettings.findUnique({
    where: { id: INSTANCE_SETTINGS_ID },
    select: GITHUB_APP_WEBHOOK_SETTINGS_SELECT,
  });
  if (!row) return { depsEnabled: false, app: null };
  if (!isGitHubAppConfiguredRow(row)) {
    return { depsEnabled: row.depsEnabled, app: null };
  }
  let webhookSecret: string | null = null;
  if (row.githubAppWebhookSecretEncrypted) {
    try {
      webhookSecret = decryptToken(row.githubAppWebhookSecretEncrypted);
    } catch (error) {
      throw new GitHubAppKeyUnreadableError({ cause: error });
    }
  }
  return {
    depsEnabled: row.depsEnabled,
    app: { webhookSecret },
  };
}

/** Whether the Dependencies module is enabled (Admin → Dependencies). `false` when the settings row doesn't exist. */
export async function loadDepsEnabled(client: Pick<PrismaClient, "instanceSettings">): Promise<boolean> {
  const row = await client.instanceSettings.findUnique({
    where: { id: INSTANCE_SETTINGS_ID },
    select: { depsEnabled: true },
  });
  return row?.depsEnabled ?? false;
}

/** Combined select for the Admin overview page (`/admin`) to read all settings in one query. */
const ADMIN_OVERVIEW_SETTINGS_SELECT = {
  publicRegistration: true,
  depsEnabled: true,
  ...SMTP_SETTINGS_SELECT,
  ...BACKFILL_SETTINGS_SELECT,
  ...GITHUB_APP_SETTINGS_SELECT,
} as const;

/** Safe admin-overview snapshot (never exposes encrypted secret strings). */
export interface AdminSettingsSnapshot {
  publicRegistration: boolean;
  depsEnabled: boolean;
  smtp: {
    host: string | null;
    port: number;
    secure: boolean | null;
    user: string | null;
    hasPassword: boolean;
    from: string | null;
  };
  backfillOverrides: BackfillSettingsOverrides;
  githubApp: {
    configured: boolean;
    appId: number | null;
    slug: string | null;
    clientId: string | null;
    owner: string | null;
    keySaved: boolean;
    keyReadable: boolean;
    webhookSecretSaved: boolean;
  };
}

function canDecrypt(value: string): boolean {
  try {
    decryptToken(value);
    return true;
  } catch {
    return false;
  }
}

/** Reads all instance settings needed by the Admin overview page in a single `InstanceSettings` query. */
export async function loadAdminSettingsSnapshot(
  client: Pick<PrismaClient, "instanceSettings">,
): Promise<AdminSettingsSnapshot> {
  const row = await client.instanceSettings.findUnique({
    where: { id: INSTANCE_SETTINGS_ID },
    select: ADMIN_OVERVIEW_SETTINGS_SELECT,
  });
  if (!row) {
    return {
      publicRegistration: true,
      depsEnabled: false,
      smtp: {
        host: null,
        port: 587,
        secure: null,
        user: null,
        hasPassword: false,
        from: null,
      },
      backfillOverrides: { ...NO_BACKFILL_OVERRIDES },
      githubApp: {
        configured: false,
        appId: null,
        slug: null,
        clientId: null,
        owner: null,
        keySaved: false,
        keyReadable: false,
        webhookSecretSaved: false,
      },
    };
  }
  const keySaved = Boolean(row.githubAppPrivateKeyEncrypted);
  return {
    publicRegistration: row.publicRegistration,
    depsEnabled: row.depsEnabled,
    smtp: {
      host: row.smtpHost,
      port: row.smtpPort,
      secure: row.smtpSecure,
      user: row.smtpUser,
      hasPassword: Boolean(row.smtpPasswordEncrypted),
      from: row.smtpFrom,
    },
    backfillOverrides: mapBackfillOverrides(row),
    githubApp: {
      configured: isGitHubAppConfiguredRow(row),
      appId: row.githubAppId,
      slug: row.githubAppSlug,
      clientId: row.githubAppClientId,
      owner: row.githubAppOwner,
      keySaved,
      keyReadable: keySaved && canDecrypt(row.githubAppPrivateKeyEncrypted!),
      webhookSecretSaved: Boolean(row.githubAppWebhookSecretEncrypted),
    },
  };
}

/** Default TTL for in-memory worker settings caches (changes in Admin apply within 15s without restart). */
const DEFAULT_SETTINGS_CACHE_TTL_MS = 15_000;

export interface CachedLoaderOptions {
  ttlMs?: number;
  now?: () => number;
}

/**
 * Wraps an async settings loader with a short-TTL in-memory cache and single-flight deduplication so bursts of
 * concurrent worker jobs share one DB read + decryption. Rejected promises are never cached.
 */
export function createCachedLoader<T>(
  load: () => Promise<T>,
  options: CachedLoaderOptions = {},
): (() => Promise<T>) & { invalidate(): void } {
  const ttlMs = options.ttlMs ?? DEFAULT_SETTINGS_CACHE_TTL_MS;
  const now = options.now ?? Date.now;
  let cached: { value: T; expiresAt: number } | null = null;
  let inFlight: Promise<T> | null = null;
  let generation = 0;

  const fn = async (): Promise<T> => {
    if (cached && now() < cached.expiresAt) return cached.value;
    if (inFlight) return inFlight;

    const currentGeneration = generation;
    const promise = load()
      .then((value) => {
        if (generation === currentGeneration && ttlMs > 0) {
          cached = { value, expiresAt: now() + ttlMs };
        }
        return value;
      })
      .finally(() => {
        if (inFlight === promise) inFlight = null;
      });
    inFlight = promise;
    return promise;
  };

  fn.invalidate = () => {
    generation += 1;
    cached = null;
    inFlight = null;
  };

  return fn;
}

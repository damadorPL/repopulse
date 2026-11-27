import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/prisma/client.js";

/**
 * Global field omissions: encrypted secrets stay excluded from default queries and must be
 * requested explicitly with `select` or `omit: { ...: false }` by server-side callers.
 */
const GLOBAL_OMIT = {
  user: {
    githubAccessTokenEncrypted: true,
  },
  instanceSettings: {
    smtpPasswordEncrypted: true,
    githubAppPrivateKeyEncrypted: true,
    githubAppWebhookSecretEncrypted: true,
  },
} as const;

const DEFAULT_POOL_MAX = 10;
const MIN_POOL_MAX = 1;
const MAX_POOL_MAX = 100;

/**
 * Parses `DATABASE_POOL_MAX` as an integer in `[1, 100]`, falling back to `10`
 * when unset or out of range.
 */
export function parsePoolMax(raw = process.env.DATABASE_POOL_MAX): number {
  const trimmed = raw?.trim();
  if (!trimmed || !/^\d+$/.test(trimmed)) return DEFAULT_POOL_MAX;
  const parsed = Number.parseInt(trimmed, 10);
  return parsed >= MIN_POOL_MAX && parsed <= MAX_POOL_MAX ? parsed : DEFAULT_POOL_MAX;
}

function resolveApplicationName(): string {
  return process.env.DATABASE_APP_NAME?.trim() || process.env.PGAPPNAME?.trim() || "repopulse";
}

/**
 * Prisma 7 uses the Rust-free query compiler and connects through a driver
 * adapter (node-postgres here) instead of a native query engine.
 *
 * `statementNameGenerator` is intentionally omitted:
 * 1. With PgBouncer transaction pooling and Prisma 7 dynamic IN-list queries, named prepared
 *    statements can fail across rotated backend connections and accumulate per-connection caches.
 * 2. Unnamed statements allow PostgreSQL to generate custom plans per bind value so queries
 *    match parameterized partial indexes (e.g. `WHERE "isDraft" = false`, `WHERE "isRead" = false`).
 */
function createPrismaClient(): PrismaClient {
  const adapter = new PrismaPg(
    {
      connectionString: process.env.DATABASE_URL,
      max: parsePoolMax(),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      query_timeout: 35_000,
      application_name: resolveApplicationName(),
    },
    {
      onPoolError: (err) => {
        console.error("[db] idle pool client error", err);
      },
      onConnectionError: (err) => {
        console.error("[db] connection error", err);
      },
    },
  );
  // Prisma 7's `OmitOpts` generic on `PrismaClient` is invariant (`in out`), so casting back
  // to `PrismaClient` keeps `Pick<PrismaClient, "instanceSettings">` and worker signatures
  // compatible while enforcing `GLOBAL_OMIT` at runtime on every query.
  return new PrismaClient({
    adapter,
    omit: GLOBAL_OMIT,
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  }) as unknown as PrismaClient;
}

/**
 * Singleton Prisma client cached unconditionally on `globalThis` across both development
 * (Next.js HMR) and production (multiple route chunks / worker module evaluations) so a
 * single process never opens duplicate connection pools.
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma: PrismaClient = globalForPrisma.prisma ?? createPrismaClient();
globalForPrisma.prisma = prisma;

/** Alias matching the master PRD naming (`db`). */
export const db = prisma;

export * from "./generated/prisma/client.js";
export { encryptToken, decryptToken } from "./crypto.js";
export {
  ADMIN_OVERVIEW_SETTINGS_SELECT,
  BACKFILL_SETTINGS_SELECT,
  createCachedLoader,
  DEFAULT_SETTINGS_CACHE_TTL_MS,
  GITHUB_APP_SETTINGS_SELECT,
  GITHUB_APP_WEBHOOK_SETTINGS_SELECT,
  GitHubAppKeyUnreadableError,
  INSTANCE_SETTINGS_ID,
  loadAdminSettingsSnapshot,
  loadDepsEnabled,
  loadGitHubAppSettings,
  loadGitHubAppWebhookSettings,
  loadBackfillOverrides,
  NO_BACKFILL_OVERRIDES,
  SMTP_SETTINGS_SELECT,
  SmtpPasswordUnreadableError,
  loadSmtpSettings,
  type AdminSettingsSnapshot,
  type BackfillSettingsOverrides,
  type CachedLoaderOptions,
  type DecryptedGitHubAppSettings,
  type DecryptedSmtpSettings,
  type GitHubAppWebhookSettings,
} from "./instance-settings.js";

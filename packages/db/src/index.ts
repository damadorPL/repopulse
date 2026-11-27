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

/**
 * Prisma 7 uses the Rust-free query compiler and connects through a driver
 * adapter (node-postgres here) instead of a native query engine.
 *
 * `statementNameGenerator` is intentionally omitted: with PgBouncer transaction pooling
 * and Prisma 7 dynamic IN-list queries, named prepared statements can fail across rotated
 * backend connections and accumulate per-connection statement caches.
 */
function createPrismaClient(): PrismaClient {
  const adapter = new PrismaPg(
    {
      connectionString: process.env.DATABASE_URL,
      connectionTimeoutMillis: 10_000,
      application_name: "repopulse",
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
 * Singleton Prisma client. In development, Next.js HMR re-evaluates modules,
 * so the instance is cached on globalThis to avoid exhausting DB connections.
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma: PrismaClient = globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}

/** Alias matching the master PRD naming (`db`). */
export const db = prisma;

export * from "./generated/prisma/client.js";
export { encryptToken, decryptToken } from "./crypto.js";
export {
  BACKFILL_SETTINGS_SELECT,
  GITHUB_APP_SETTINGS_SELECT,
  GitHubAppKeyUnreadableError,
  INSTANCE_SETTINGS_ID,
  loadDepsEnabled,
  loadGitHubAppSettings,
  loadBackfillOverrides,
  NO_BACKFILL_OVERRIDES,
  SMTP_SETTINGS_SELECT,
  SmtpPasswordUnreadableError,
  loadSmtpSettings,
  type BackfillSettingsOverrides,
  type DecryptedGitHubAppSettings,
  type DecryptedSmtpSettings,
} from "./instance-settings.js";

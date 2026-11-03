import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/prisma/client.js";

/**
 * Prisma 7 uses the Rust-free query compiler and connects through a driver
 * adapter (node-postgres here) instead of a native query engine.
 */
function createPrismaClient(): PrismaClient {
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
  return new PrismaClient({
    adapter,
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });
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

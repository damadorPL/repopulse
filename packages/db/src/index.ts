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
  INSTANCE_SETTINGS_ID,
  SMTP_SETTINGS_SELECT,
  SmtpPasswordUnreadableError,
  loadSmtpSettings,
  type DecryptedSmtpSettings,
} from "./instance-settings.js";

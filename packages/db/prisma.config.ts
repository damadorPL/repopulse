import { defineConfig } from "prisma/config";

/**
 * Prisma 7 CLI config (generate / migrate). The runtime client gets its
 * connection string from the PrismaPg driver adapter in src/index.ts instead.
 *
 * DATABASE_URL is read lazily from the environment (Prisma 7 no longer loads
 * .env files automatically). `prisma generate` doesn't need it, so it may be
 * unset at Docker build time; `migrate` commands fail fast without it.
 */
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: process.env.DATABASE_URL ?? "",
  },
});

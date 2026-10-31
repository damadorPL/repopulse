import { existsSync } from "node:fs";
import path from "node:path";
import { defineConfig } from "prisma/config";

/**
 * Local dev: Prisma 7 no longer loads .env files, so load the monorepo-root .env
 * (found by walking up to pnpm-workspace.yaml). Variables already set in the
 * environment win, and it is skipped when NODE_ENV=production (Docker migrator).
 */
function loadRootEnv(): void {
  if (process.env.NODE_ENV === "production") return;
  for (let dir = process.cwd(); ; dir = path.dirname(dir)) {
    if (existsSync(path.join(dir, "pnpm-workspace.yaml"))) {
      const envFile = path.join(dir, ".env");
      if (existsSync(envFile)) process.loadEnvFile(envFile);
      return;
    }
    if (path.dirname(dir) === dir) return;
  }
}
loadRootEnv();

/**
 * Prisma 7 CLI config (generate / migrate). The runtime client gets its
 * connection string from the PrismaPg driver adapter in src/index.ts instead.
 *
 * DATABASE_URL is read lazily from the environment. `prisma generate` doesn't
 * need it, so it may be unset at Docker build time; `migrate` commands fail fast without it.
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

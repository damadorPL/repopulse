import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const monorepoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");

// Local dev: share the monorepo-root .env (Next only reads apps/web/.env* itself).
// Variables already set in the environment win. Never loaded in production.
const rootEnvFile = path.join(monorepoRoot, ".env");
if (process.env.NODE_ENV !== "production" && existsSync(rootEnvFile)) {
  process.loadEnvFile(rootEnvFile);
}

const nextConfig: NextConfig = {
  output: "standalone",
  // Trace from the monorepo root so pnpm-symlinked workspace packages
  // (e.g. @repopulse/db) and their deps are copied into .next/standalone.
  outputFileTracingRoot: monorepoRoot,
  // Prisma 7 needs no tracing workaround: there is no native query engine, the
  // generated client is compiled into @repopulse/db/dist, and the wasm query
  // compiler ships as base64 JS inside @prisma/client/runtime (traced normally).
  poweredByHeader: false,
};

export default nextConfig;

import { DEFAULT_DEPS_SCAN_CRON } from "@repopulse/queue";

/** `deps-worker` settings from the environment (Slice 08 §3.12). Read once at startup; invalid values fail fast. */
export interface DepsWorkerConfig {
  scanCron: string;
  scanConcurrency: number;
  updateConcurrency: number;
  sandboxUrl: string;
  /** `null` = lockfile regeneration is unavailable (update PRs that need a lockfile are refused). */
  sandboxToken: string | null;
}

export const DEFAULT_SANDBOX_URL = "http://deps-sandbox:3003";

function positiveInt(env: Record<string, string | undefined>, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) throw new Error(`Invalid ${name} "${raw}"`);
  return value;
}

export function readConfig(env: Record<string, string | undefined> = process.env): DepsWorkerConfig {
  const sandboxUrl = (env.DEPS_SANDBOX_URL?.trim() || DEFAULT_SANDBOX_URL).replace(/\/+$/, "");
  let parsed: URL;
  try {
    parsed = new URL(sandboxUrl);
  } catch {
    throw new Error("Invalid DEPS_SANDBOX_URL (not a URL)");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("DEPS_SANDBOX_URL must be http(s)");
  return {
    scanCron: env.DEPS_SCAN_CRON?.trim() || DEFAULT_DEPS_SCAN_CRON,
    scanConcurrency: positiveInt(env, "DEPS_SCAN_CONCURRENCY", 3),
    updateConcurrency: positiveInt(env, "DEPS_UPDATE_CONCURRENCY", 1),
    sandboxUrl,
    sandboxToken: env.DEPS_SANDBOX_TOKEN?.trim() || null,
  };
}

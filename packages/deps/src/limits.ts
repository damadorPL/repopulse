/**
 * Caps and defaults of the Dependencies module (Slice 08 §3.13), shared by `apps/web` (forms, actions) and
 * `apps/deps-worker` (scans, updates). Browser-safe: no Node imports.
 */

export const MAX_DEPENDENCY_PROJECTS_PER_USER = 50;
export const MAX_PROJECTS_PER_ADD = 20;
export const MAX_MANIFESTS_PER_PROJECT = 25;
export const MAX_DEPENDENCIES_PER_PROJECT = 1000;
export const MAX_MANIFEST_BYTES = 1024 * 1024;
export const MAX_LOCKFILE_BYTES = 20 * 1024 * 1024;
export const MAX_IGNORE_RULES = 50;
export const SCAN_COOLDOWN_MS = 5 * 60 * 1000;
export const REGISTRY_CACHE_TTL_MS = 60 * 60 * 1000;
export const REGISTRY_CONCURRENCY = 8;
export const DIGEST_MAX_ITEMS = 25;
export const SCAN_INTERVAL_HOURS = [6, 12, 24, 168] as const;
export const MIN_RELEASE_AGE_DAYS_MAX = 30;
export const MAX_OPEN_PRS_MAX = 20;

/** Sandbox contract caps (§3.10). */
export const MAX_SANDBOX_BODY_BYTES = 30 * 1024 * 1024;
export const MAX_SANDBOX_FILES = 2000;
export const MAX_SANDBOX_STDERR_TAIL_BYTES = 2048;

/** Bot branches are `repopulse/deps/<groupKey>`; group keys contain only `[a-z0-9-]`. */
export const DEPS_BRANCH_PREFIX = "repopulse/deps/";

/** Redis key of the `deps-worker` heartbeat (written every 30 s, TTL 90 s). */
export const DEPS_WORKER_HEARTBEAT_KEY = "deps:worker:heartbeat";
export const DEPS_WORKER_HEARTBEAT_INTERVAL_MS = 30_000;
export const DEPS_WORKER_HEARTBEAT_TTL_SECONDS = 90;

/** Payload stored under {@link DEPS_WORKER_HEARTBEAT_KEY} (JSON). Read by Admin → Dependencies. */
export interface DepsWorkerHeartbeat {
  /** ISO timestamp of the write. */
  at: string;
  /** Result of `GET /health` on the sandbox: `null` when unreachable. */
  sandbox: { status: "ok"; tools: Record<string, string> } | null;
}

/** Defaults of a new `DependencyProject` (mirrors the Prisma defaults). */
export const DEPENDENCY_PROJECT_DEFAULTS = {
  updateMode: "NOTIFY",
  maxUpdateLevel: "MINOR",
  includePrereleases: false,
  minReleaseAgeDays: 3,
  groupMode: "SEPARATE_MAJORS",
  rangeStrategy: "BUMP",
  maxOpenPrs: 5,
  scanIntervalHours: 24,
  notificationLevel: "MINOR_AND_UP",
  commitPrefix: "chore(deps):",
} as const;

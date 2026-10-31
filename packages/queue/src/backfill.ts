/**
 * Release history backfill settings (Slice 04b), read from the environment by the worker and by
 * apps/web ("Load older releases" needs the hard cap).
 */
export interface BackfillConfig {
  /** `RELEASE_BACKFILL_DEFAULT_TARGET`: releases kept per repository after the automatic backfill. */
  defaultTarget: number;
  /** `RELEASE_BACKFILL_MAX_AGE_DAYS`: the automatic backfill stops at older releases (`0` = no limit). */
  maxAgeDays: number;
  /** `RELEASE_BACKFILL_HARD_CAP`: maximum releases per repository, even via "Load older releases". */
  hardCap: number;
  /** `RELEASE_BACKFILL_MIN_QUOTA`: pause the backfill when the GitHub quota drops below this. */
  minQuota: number;
}

export const BACKFILL_DEFAULTS: BackfillConfig = { defaultTarget: 100, maxAgeDays: 365, hardCap: 1000, minQuota: 500 };

/** How much "Load older releases" raises `backfillTarget` per click. */
export const DEEP_BACKFILL_STEP = 200;

/** Minimum time between two "Load older releases" requests for the same repository. */
export const DEEP_BACKFILL_COOLDOWN_MS = 5 * 60 * 1000;

function nonNegativeInt(env: Record<string, string | undefined>, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) throw new Error(`Invalid ${name} "${raw}"`);
  return value;
}

export function readBackfillConfig(env: Record<string, string | undefined> = process.env): BackfillConfig {
  const hardCap = Math.max(1, nonNegativeInt(env, "RELEASE_BACKFILL_HARD_CAP", BACKFILL_DEFAULTS.hardCap));
  return {
    defaultTarget: Math.min(hardCap, nonNegativeInt(env, "RELEASE_BACKFILL_DEFAULT_TARGET", BACKFILL_DEFAULTS.defaultTarget)),
    maxAgeDays: nonNegativeInt(env, "RELEASE_BACKFILL_MAX_AGE_DAYS", BACKFILL_DEFAULTS.maxAgeDays),
    hardCap,
    minQuota: nonNegativeInt(env, "RELEASE_BACKFILL_MIN_QUOTA", BACKFILL_DEFAULTS.minQuota),
  };
}

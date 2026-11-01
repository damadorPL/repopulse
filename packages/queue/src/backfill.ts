/**
 * Release history backfill settings (Slice 04b). The base values come from the environment
 * (`readBackfillConfig`) and the super admin can override each one in Admin → Release history
 * (`InstanceSettings.backfill*`, merged by `applyBackfillOverrides`). The worker re-reads them on
 * every backfill job, and apps/web for "Load older releases".
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
  /** How much "Load older releases" raises `backfillTarget` per click (admin setting only). */
  deepStep: number;
  /** Minimum minutes between two "Load older releases" requests for one repository (admin setting only). */
  deepCooldownMinutes: number;
}

export type BackfillSettingKey = keyof BackfillConfig;

/** How much "Load older releases" raises `backfillTarget` per click, by default. */
export const DEEP_BACKFILL_STEP = 200;

/** Minimum time between two "Load older releases" requests for the same repository, by default. */
export const DEEP_BACKFILL_COOLDOWN_MS = 5 * 60 * 1000;

export const BACKFILL_DEFAULTS: BackfillConfig = {
  defaultTarget: 100,
  maxAgeDays: 365,
  hardCap: 1000,
  minQuota: 500,
  deepStep: DEEP_BACKFILL_STEP,
  deepCooldownMinutes: DEEP_BACKFILL_COOLDOWN_MS / 60_000,
};

/** Accepted range of each setting, for the admin form and its Server Action. */
export const BACKFILL_LIMITS: Record<BackfillSettingKey, { min: number; max: number }> = {
  defaultTarget: { min: 0, max: 100_000 },
  maxAgeDays: { min: 0, max: 36_500 },
  hardCap: { min: 1, max: 100_000 },
  minQuota: { min: 0, max: 15_000 },
  deepStep: { min: 1, max: 10_000 },
  deepCooldownMinutes: { min: 0, max: 1_440 },
};

/** Admin overrides: `null` (or missing) keeps the environment / default value. */
export type BackfillOverrides = Partial<Record<BackfillSettingKey, number | null>>;

function nonNegativeInt(env: Record<string, string | undefined>, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) throw new Error(`Invalid ${name} "${raw}"`);
  return value;
}

/** The `RELEASE_BACKFILL_*` environment variables, or the defaults. Throws on invalid values. */
export function readBackfillConfig(env: Record<string, string | undefined> = process.env): BackfillConfig {
  const hardCap = Math.max(1, nonNegativeInt(env, "RELEASE_BACKFILL_HARD_CAP", BACKFILL_DEFAULTS.hardCap));
  return {
    defaultTarget: Math.min(hardCap, nonNegativeInt(env, "RELEASE_BACKFILL_DEFAULT_TARGET", BACKFILL_DEFAULTS.defaultTarget)),
    maxAgeDays: nonNegativeInt(env, "RELEASE_BACKFILL_MAX_AGE_DAYS", BACKFILL_DEFAULTS.maxAgeDays),
    hardCap,
    minQuota: nonNegativeInt(env, "RELEASE_BACKFILL_MIN_QUOTA", BACKFILL_DEFAULTS.minQuota),
    deepStep: BACKFILL_DEFAULTS.deepStep,
    deepCooldownMinutes: BACKFILL_DEFAULTS.deepCooldownMinutes,
  };
}

function clamp(value: number, key: BackfillSettingKey): number {
  const { min, max } = BACKFILL_LIMITS[key];
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

/**
 * `base` with the admin overrides applied. Out-of-range or non-integer overrides are clamped (they
 * are validated on save; this guards hand-edited rows), and the default target never exceeds the
 * hard cap, as in `readBackfillConfig`.
 */
export function applyBackfillOverrides(base: BackfillConfig, overrides: BackfillOverrides | null | undefined): BackfillConfig {
  const merged = { ...base };
  for (const key of Object.keys(base) as BackfillSettingKey[]) {
    const value = overrides?.[key];
    if (typeof value === "number" && Number.isFinite(value)) merged[key] = clamp(value, key);
  }
  merged.defaultTarget = Math.min(merged.defaultTarget, merged.hardCap);
  return merged;
}

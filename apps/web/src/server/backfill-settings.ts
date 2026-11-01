import { loadBackfillOverrides, prisma, type BackfillSettingsOverrides, type Prisma } from "@repopulse/db";
import {
  applyBackfillOverrides,
  BACKFILL_LIMITS,
  readBackfillConfig,
  type BackfillConfig,
  type BackfillSettingKey,
} from "@repopulse/queue";

/**
 * Release history settings (Admin → Release history): the `RELEASE_BACKFILL_*` environment
 * variables (or defaults), overridden per value by the super admin. Not a `"use server"` module:
 * nothing here is callable from the browser.
 */

/** The settings in effect, as the worker applies them. */
export async function getBackfillConfig(): Promise<BackfillConfig> {
  return applyBackfillOverrides(readBackfillConfig(), await loadBackfillOverrides(prisma));
}

export type BackfillSettingSource = "admin" | "env" | "default";

export interface BackfillSettingView {
  key: BackfillSettingKey;
  /** In effect (after clamping). */
  value: number;
  /** Saved in Admin → Release history, or `null`. */
  override: number | null;
  /** What applies without an override: the environment variable, or the built-in default. */
  fallback: number;
  /** Where `fallback` comes from. */
  fallbackSource: "env" | "default";
  /** Where `value` comes from. */
  source: BackfillSettingSource;
  /** Environment variable name, when there is one. */
  envVar: string | null;
  min: number;
  max: number;
}

export const BACKFILL_ENV_VARS: Record<BackfillSettingKey, string | null> = {
  defaultTarget: "RELEASE_BACKFILL_DEFAULT_TARGET",
  maxAgeDays: "RELEASE_BACKFILL_MAX_AGE_DAYS",
  hardCap: "RELEASE_BACKFILL_HARD_CAP",
  minQuota: "RELEASE_BACKFILL_MIN_QUOTA",
  deepStep: null,
  deepCooldownMinutes: null,
};

export const BACKFILL_SETTING_KEYS: readonly BackfillSettingKey[] = [
  "defaultTarget",
  "maxAgeDays",
  "deepStep",
  "deepCooldownMinutes",
  "hardCap",
  "minQuota",
];

export function buildBackfillSettingsView(
  env: Record<string, string | undefined>,
  overrides: BackfillSettingsOverrides,
): BackfillSettingView[] {
  const base = readBackfillConfig(env);
  const effective = applyBackfillOverrides(base, overrides);
  return BACKFILL_SETTING_KEYS.map((key) => {
    const envVar = BACKFILL_ENV_VARS[key];
    const fromEnv = envVar !== null && Boolean(env[envVar]?.trim());
    const override = overrides[key];
    return {
      key,
      value: effective[key],
      override,
      fallback: base[key],
      fallbackSource: fromEnv ? "env" : "default",
      source: override !== null ? "admin" : fromEnv ? "env" : "default",
      envVar,
      ...BACKFILL_LIMITS[key],
    };
  });
}

export async function getBackfillSettingsView(): Promise<BackfillSettingView[]> {
  return buildBackfillSettingsView(process.env, await loadBackfillOverrides(prisma));
}

/**
 * Repositories "Apply to existing repositories" re-imports: tracked, import finished with older
 * releases left on GitHub, and a target not raised by "Load older releases" beyond the automatic one.
 */
export function reapplyCandidatesWhere(defaultTarget: number): Prisma.RepositoryWhereInput {
  return {
    subscriptions: { some: {} },
    backfillStatus: "DONE",
    backfillNextPage: { not: null },
    backfillTarget: { lte: defaultTarget },
  };
}

export async function countReapplyCandidates(defaultTarget: number): Promise<number> {
  return prisma.repository.count({ where: reapplyCandidatesWhere(defaultTarget) });
}

import {
  MAX_IGNORE_RULES,
  MAX_MANIFESTS_PER_PROJECT,
  MAX_OPEN_PRS_MAX,
  MAX_PROJECTS_PER_ADD,
  MIN_RELEASE_AGE_DAYS_MAX,
  SCAN_INTERVAL_HOURS,
} from "@repopulse/deps/limits";
import { z } from "zod";

import {
  COMMIT_PREFIX_MAX_LENGTH,
  DEPS_GROUP_MODES,
  DEPS_RANGE_STRATEGIES,
  DEPS_UPDATE_LEVELS,
  DEPS_UPDATE_MODES,
} from "./dependency-settings";
import { NOTIFICATION_LEVELS } from "./subscription-settings";

const idSchema = z.string().min(1).max(64);

/** One line, no control characters (it starts every commit message and PR title). */
// oxlint-disable-next-line no-control-regex -- exclude control characters from commit messages and PR titles.
const COMMIT_PREFIX_RE = /^[^\u0000-\u001f\u007f]*$/;

export const updateModeSchema = z.enum(DEPS_UPDATE_MODES, "Choose an update mode");

export const addSourceSchema = z.union([
  z.strictObject({ subscriptionId: idSchema }),
  z.strictObject({ repoUrlOrSlug: z.string().trim().min(1, "Enter a repository").max(500) }),
]);

export const addDependencyProjectsInput = z.strictObject({
  sources: z
    .array(addSourceSchema)
    .min(1, "Choose at least one repository")
    .max(MAX_PROJECTS_PER_ADD, `Add at most ${MAX_PROJECTS_PER_ADD} repositories at once`),
  updateMode: updateModeSchema.default("NOTIFY"),
  /** "Notify about what is outdated now": the first scan sends a digest. */
  notifyOnFirstScan: z.boolean().default(false),
});
export type AddDependencyProjectsInput = z.input<typeof addDependencyProjectsInput>;

export const projectIdInput = z.strictObject({ projectId: idSchema });

/** Loose shape of one ignore rule; the action re-validates with `ignoreRuleSchema` from `@repopulse/deps`. */
export const ignoreRuleInput = z.strictObject({
  name: z.string().trim().min(1, "Enter a package name or pattern").max(214, "That name is too long"),
  versions: z.string().trim().max(256, "That range is too long").optional(),
});

/** Input of `updateDependencyProjectSettingsAction`: every field optional, only the ones sent change. */
export const dependencySettingsInput = z.strictObject({
  projectId: idSchema,
  updateMode: updateModeSchema.optional(),
  maxUpdateLevel: z.enum(DEPS_UPDATE_LEVELS).optional(),
  includePrereleases: z.boolean().optional(),
  minReleaseAgeDays: z
    .number()
    .int("Use whole days")
    .min(0, "The minimum release age can't be negative")
    .max(MIN_RELEASE_AGE_DAYS_MAX, `At most ${MIN_RELEASE_AGE_DAYS_MAX} days`)
    .optional(),
  groupMode: z.enum(DEPS_GROUP_MODES).optional(),
  rangeStrategy: z.enum(DEPS_RANGE_STRATEGIES).optional(),
  maxOpenPrs: z
    .number()
    .int()
    .min(1, "At least one pull request")
    .max(MAX_OPEN_PRS_MAX, `At most ${MAX_OPEN_PRS_MAX} pull requests`)
    .optional(),
  scanIntervalHours: z
    .number()
    .int()
    .refine((value) => (SCAN_INTERVAL_HOURS as readonly number[]).includes(value), "Choose a check interval")
    .optional(),
  notificationLevel: z.enum(NOTIFICATION_LEVELS).optional(),
  /** Raw paths; empty = auto-detect. Normalized by the action. */
  manifestPaths: z
    .array(z.string().max(1000))
    .max(MAX_MANIFESTS_PER_PROJECT, `At most ${MAX_MANIFESTS_PER_PROJECT} manifest paths`)
    .optional(),
  commitPrefix: z
    .string()
    .trim()
    .max(COMMIT_PREFIX_MAX_LENGTH, `At most ${COMMIT_PREFIX_MAX_LENGTH} characters`)
    .refine((value) => COMMIT_PREFIX_RE.test(value), "Use a single line")
    .optional(),
  ignoreRules: z.array(ignoreRuleInput).max(MAX_IGNORE_RULES, `At most ${MAX_IGNORE_RULES} ignore rules`).optional(),
});
export type DependencySettingsInput = z.input<typeof dependencySettingsInput>;

export const ignoreDependencyInput = z.strictObject({
  projectId: idSchema,
  name: ignoreRuleInput.shape.name,
  versions: ignoreRuleInput.shape.versions,
});
export type IgnoreDependencyInput = z.input<typeof ignoreDependencyInput>;

export const createPullRequestInput = z.strictObject({
  projectId: idSchema,
  groupKey: z.string().min(1).max(80),
});

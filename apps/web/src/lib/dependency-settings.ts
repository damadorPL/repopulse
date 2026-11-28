import {
  MAX_IGNORE_RULES,
  MAX_MANIFESTS_PER_PROJECT,
  MAX_OPEN_PRS_MAX,
  MAX_PROJECTS_PER_ADD,
  MIN_RELEASE_AGE_DAYS_MAX,
  SCAN_INTERVAL_HOURS,
} from "@repopulse/deps/limits";

import type { NotificationLevelValue } from "./subscription-settings";

/**
 * Dependencies module (Slice 08): option labels, pure types, and small display helpers shared by
 * the forms and the pages. Browser-safe: only `@repopulse/deps/limits` (no parsers, no Prisma,
 * no Zod). Server Action input schemas live in `./dependency-settings-schema`.
 */

/** Mirror the Prisma enums (kept local so client bundles never import `@repopulse/db`). */
export const DEPS_UPDATE_MODES = ["NOTIFY", "MANUAL_PR", "AUTO_PR"] as const;
export type DepsUpdateModeValue = (typeof DEPS_UPDATE_MODES)[number];
export const DEPS_UPDATE_LEVELS = ["PATCH", "MINOR", "MAJOR"] as const;
export type DepsUpdateLevelValue = (typeof DEPS_UPDATE_LEVELS)[number];
export const DEPS_GROUP_MODES = ["SINGLE", "SEPARATE_MAJORS", "PER_DEPENDENCY"] as const;
export type DepsGroupModeValue = (typeof DEPS_GROUP_MODES)[number];
export const DEPS_RANGE_STRATEGIES = ["BUMP", "LOCKFILE_ONLY"] as const;
export type DepsRangeStrategyValue = (typeof DEPS_RANGE_STRATEGIES)[number];
export const DEPENDENCY_UPDATE_STATUSES = [
  "OUTDATED",
  "TOO_NEW",
  "ABOVE_LEVEL",
  "BLOCKED_BY_RANGE",
  "IGNORED",
  "DISMISSED",
  "UNSUPPORTED_SOURCE",
] as const;
export type DependencyUpdateStatusValue = (typeof DEPENDENCY_UPDATE_STATUSES)[number];
export const DEPENDENCY_KINDS = ["PROD", "DEV", "PEER", "OPTIONAL", "GROUP"] as const;
export type DependencyKindValue = (typeof DEPENDENCY_KINDS)[number];
export const DEPENDENCY_ECOSYSTEMS = ["NPM", "PYPI"] as const;
export type DependencyEcosystemValue = (typeof DEPENDENCY_ECOSYSTEMS)[number];
export type PackageManagerValue = "NPM" | "PNPM" | "BUN" | "YARN" | "PIP" | "PIP_TOOLS" | "UV" | "POETRY" | "NONE";
export type DepsPrStateValue = "OPEN" | "MERGED" | "CLOSED" | "EDITED";

export {
  MAX_IGNORE_RULES,
  MAX_MANIFESTS_PER_PROJECT,
  MAX_OPEN_PRS_MAX,
  MAX_PROJECTS_PER_ADD,
  MIN_RELEASE_AGE_DAYS_MAX,
  SCAN_INTERVAL_HOURS,
};

export const UPDATE_MODE_OPTIONS: ReadonlyArray<{
  value: DepsUpdateModeValue;
  label: string;
  badge: string;
  hint: string;
}> = [
  {
    value: "NOTIFY",
    label: "Notify only",
    badge: "Notify",
    hint: "Shows outdated dependencies and notifies you. Never touches the repository.",
  },
  {
    value: "MANUAL_PR",
    label: "Pull request on request",
    badge: "PR on request",
    hint: "“Create PR” opens or updates a pull request.",
  },
  {
    value: "AUTO_PR",
    label: "Automatic pull requests",
    badge: "Auto PR",
    hint: "Every check opens or updates the pull requests it plans.",
  },
];

export const UPDATE_LEVEL_OPTIONS: ReadonlyArray<{ value: DepsUpdateLevelValue; label: string; hint: string }> = [
  { value: "PATCH", label: "Patch", hint: "Only bug-fix releases become targets." },
  { value: "MINOR", label: "Minor and patch", hint: "Majors are shown, never targeted." },
  { value: "MAJOR", label: "Major, minor and patch", hint: "Every newer release can be a target." },
];

export const GROUP_MODE_OPTIONS: ReadonlyArray<{ value: DepsGroupModeValue; label: string; hint: string }> = [
  { value: "SINGLE", label: "One pull request", hint: "Every update in a single pull request." },
  {
    value: "SEPARATE_MAJORS",
    label: "Separate majors",
    hint: "Patch and minor together, one pull request per major update.",
  },
  { value: "PER_DEPENDENCY", label: "One per dependency", hint: "A pull request for each dependency." },
];

export const RANGE_STRATEGY_OPTIONS: ReadonlyArray<{ value: DepsRangeStrategyValue; label: string; hint: string }> = [
  { value: "BUMP", label: "Bump the declared range", hint: "^1.2.3 becomes ^1.4.0." },
  { value: "LOCKFILE_ONLY", label: "Lockfile only", hint: "Keep declared ranges; updates outside them are blocked." },
];

export const SCAN_INTERVAL_OPTIONS: ReadonlyArray<{ value: (typeof SCAN_INTERVAL_HOURS)[number]; label: string }> = [
  { value: 6, label: "Every 6 hours" },
  { value: 12, label: "Every 12 hours" },
  { value: 24, label: "Daily" },
  { value: 168, label: "Weekly" },
];

export const DEPS_NOTIFICATION_LEVEL_OPTIONS: ReadonlyArray<{
  value: NotificationLevelValue;
  label: string;
  hint: string;
}> = [
  { value: "ALL", label: "All updates", hint: "Your notification rules decide." },
  { value: "MINOR_AND_UP", label: "Minor and major", hint: "Skips patch updates." },
  { value: "MAJOR_ONLY", label: "Major updates only", hint: "Skips everything else." },
  { value: "NONE", label: "In the app only", hint: "No external notifications." },
];

export const STATUS_META: Record<DependencyUpdateStatusValue, { label: string; hint: string }> = {
  OUTDATED: { label: "Outdated", hint: "A newer version passes your policy." },
  TOO_NEW: { label: "Too new", hint: "The newest version is younger than the minimum release age." },
  ABOVE_LEVEL: { label: "Above level", hint: "Only updates above the maximum update level exist." },
  BLOCKED_BY_RANGE: { label: "Blocked by range", hint: "The declared range excludes the newer version." },
  IGNORED: { label: "Ignored", hint: "Matches an ignore rule." },
  DISMISSED: { label: "Dismissed", hint: "Its pull request was closed without merging; a newer version reopens it." },
  UNSUPPORTED_SOURCE: { label: "Unsupported", hint: "Git, file, workspace or private registry dependency." },
};

export const KIND_LABELS: Record<DependencyKindValue, string> = {
  PROD: "prod",
  DEV: "dev",
  PEER: "peer",
  OPTIONAL: "optional",
  GROUP: "group",
};

export const PACKAGE_MANAGER_LABELS: Record<PackageManagerValue, string> = {
  NPM: "npm",
  PNPM: "pnpm",
  BUN: "Bun",
  YARN: "Yarn",
  PIP: "pip",
  PIP_TOOLS: "pip-tools",
  UV: "uv",
  POETRY: "Poetry",
  NONE: "no lockfile",
};

export const PR_STATE_LABELS: Record<DepsPrStateValue, string> = {
  OPEN: "Open",
  MERGED: "Merged",
  CLOSED: "Closed",
  EDITED: "Edited by someone else",
};

export function updateModeLabel(mode: DepsUpdateModeValue): string {
  return UPDATE_MODE_OPTIONS.find((option) => option.value === mode)?.badge ?? mode;
}

export const COMMIT_PREFIX_MAX_LENGTH = 50;

export type AddDependencySource = { subscriptionId: string } | { repoUrlOrSlug: string };

export type IgnoreRuleValue = { name: string; versions?: string | undefined };

/** Suggestions for the manifest paths picker. */
export const MANIFEST_PATH_SUGGESTIONS = ["package.json", "pyproject.toml", "requirements.txt"] as const;

/** Same rule identity everywhere: name (case-insensitive) + range. */
export function sameIgnoreRule(a: IgnoreRuleValue, b: IgnoreRuleValue): boolean {
  return (
    a.name.trim().toLowerCase() === b.name.trim().toLowerCase() &&
    (a.versions?.trim() ?? "") === (b.versions?.trim() ?? "")
  );
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Reads a stored `ignoreRules` JSON value defensively (anything malformed is dropped). */
export function readIgnoreRules(value: unknown): IgnoreRuleValue[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!isObjectRecord(entry)) return [];
    const { name, versions } = entry;
    if (typeof name !== "string" || name.trim() === "") return [];
    return [typeof versions === "string" && versions.trim() !== "" ? { name, versions } : { name }];
  });
}

export function formatIgnoreRule(rule: IgnoreRuleValue): string {
  return rule.versions ? `${rule.name} ${rule.versions}` : rule.name;
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

export interface LevelCounts {
  major: number;
  minor: number;
  patch: number;
  other: number;
}

/** `3 major · 5 minor · 2 patch` (zero counts omitted); `""` when nothing is outdated. */
export function formatOutdatedCounts(counts: LevelCounts): string {
  const parts: string[] = [];
  if (counts.major > 0) parts.push(`${counts.major} major`);
  if (counts.minor > 0) parts.push(`${counts.minor} minor`);
  if (counts.patch > 0) parts.push(`${counts.patch} patch`);
  if (counts.other > 0) parts.push(`${counts.other} other`);
  return parts.join(" · ");
}

export function totalOutdated(counts: LevelCounts): number {
  return counts.major + counts.minor + counts.patch + counts.other;
}

export interface StatusExplainable {
  status: DependencyUpdateStatusValue;
  targetVersion: string | null;
  latestVersion: string | null;
  wantedVersion: string | null;
}

/**
 * One line under a row's status: "2.0.0 available, outside your policy" when an `OUTDATED` row's
 * latest version is newer than its target, otherwise the status hint with the version it is about.
 */
export function statusExplanation(row: StatusExplainable, minReleaseAgeDays: number): string | null {
  const latest = row.latestVersion;
  switch (row.status) {
    case "OUTDATED":
      return latest && row.targetVersion && latest !== row.targetVersion
        ? `${latest} available, outside your policy`
        : null;
    case "TOO_NEW":
      return latest
        ? `${latest} is younger than ${minReleaseAgeDays} day${minReleaseAgeDays === 1 ? "" : "s"}`
        : STATUS_META.TOO_NEW.hint;
    case "ABOVE_LEVEL":
      return latest ? `${latest} is above your maximum update level` : STATUS_META.ABOVE_LEVEL.hint;
    case "BLOCKED_BY_RANGE":
      return latest ? `${latest} is outside the declared range` : STATUS_META.BLOCKED_BY_RANGE.hint;
    case "DISMISSED":
      return STATUS_META.DISMISSED.hint;
    case "IGNORED":
      return STATUS_META.IGNORED.hint;
    case "UNSUPPORTED_SOURCE":
      return STATUS_META.UNSUPPORTED_SOURCE.hint;
  }
}

/** The registry page of a package. */
export function registryUrl(ecosystem: DependencyEcosystemValue, name: string): string {
  return ecosystem === "NPM"
    ? `https://www.npmjs.com/package/${name.split("/").map(encodeURIComponent).join("/")}`
    : `https://pypi.org/project/${encodeURIComponent(name)}/`;
}

/** `owner/name` of a GitHub repository URL (`sourceRepoUrl`), or `null`. */
export function githubRepoFromUrl(
  url: string | null | undefined,
): { owner: string; name: string; fullName: string } | null {
  if (!url) return null;
  const match = /^https:\/\/github\.com\/([A-Za-z0-9-]{1,39})\/([A-Za-z0-9_.-]{1,100}?)(?:\.git)?\/?(?:[#?].*)?$/.exec(
    url.trim(),
  );
  if (!match) return null;
  const [, owner = "", name = ""] = match;
  if (name === "." || name === "..") return null;
  return { owner, name, fullName: `${owner}/${name}` };
}

/** The releases page (changelog link) of a `sourceRepoUrl`, or `null` for non-GitHub URLs. */
export function changelogUrl(sourceRepoUrl: string | null | undefined): string | null {
  const repo = githubRepoFromUrl(sourceRepoUrl);
  return repo ? `https://github.com/${repo.owner}/${repo.name}/releases` : null;
}

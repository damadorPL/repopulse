/**
 * Planning (Slice 08 §3.5, pure): target selection under the project policy, update classification, ignore
 * rules, grouping into pull requests and whether a group can get one.
 */
import { z } from "zod";
import { MAX_IGNORE_RULES } from "./limits.js";
import type { RegistryVersion } from "./registries/types.js";
import { SANDBOX_PACKAGE_MANAGERS } from "./sandbox-contract.js";
import type {
  DependencyEcosystem,
  DependencyKind,
  DependencyUpdateStatus,
  DepsGroupMode,
  DepsRangeStrategy,
  DepsUpdateLevel,
  PackageManager,
  RangeSyntax,
  SemverType,
} from "./types.js";
import { normalizePypiName } from "./util.js";
import {
  bumpRange,
  compareVersions,
  isPrereleaseVersion,
  isValidRange,
  maxSatisfying,
  rangeLowerBound,
  satisfiesRange,
  versionCore,
} from "./versions/index.js";
import { isValidPep440Constraint, pep440Satisfies } from "./versions/pep440.js";

// ---------------------------------------------------------------------------
// Ignore rules
// ---------------------------------------------------------------------------

export interface IgnoreRule {
  /** Name glob: `*` only at the start and/or end (`@types/*`, `*-plugin`, `*eslint*`, `react`). */
  name: string;
  /** Optional range in the dependency's own syntax: only versions inside it are ignored. */
  versions?: string;
}

const IGNORE_PATTERN = /^\*?[A-Za-z0-9@/._-]+\*?$/;
export const IGNORE_PATTERN_MAX_LENGTH = 214;

/** `true` for a valid ignore-rule name pattern (`*` alone ignores everything). */
export function isValidIgnorePattern(pattern: string): boolean {
  return pattern.length > 0 && pattern.length <= IGNORE_PATTERN_MAX_LENGTH && (pattern === "*" || IGNORE_PATTERN.test(pattern));
}

/** `true` when `versions` is a valid range in npm, PEP 440 or Poetry syntax. */
export function isValidIgnoreVersions(versions: string): boolean {
  return isValidRange("npm", versions) || isValidRange("pep440", versions) || isValidRange("poetry", versions);
}

/** Case-insensitive glob match; PyPI names (and the pattern) are PEP 503-normalized first. */
export function ignorePatternMatches(pattern: string, name: string, ecosystem: DependencyEcosystem): boolean {
  if (pattern === "*") return true;
  const normalize = (value: string): string => (ecosystem === "PYPI" ? normalizePypiName(value) : value.toLowerCase());
  const leading = pattern.startsWith("*");
  const trailing = pattern.endsWith("*") && pattern.length > 1;
  const core = normalize(pattern.slice(leading ? 1 : 0, trailing ? -1 : undefined));
  const value = normalize(name);
  if (leading && trailing) return value.includes(core);
  if (leading) return value.endsWith(core);
  if (trailing) return value.startsWith(core);
  return value === core;
}

/** zod schema for one ignore rule (shared with the web settings form). */
export const ignoreRuleSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1)
      .max(IGNORE_PATTERN_MAX_LENGTH)
      .refine(isValidIgnorePattern, { message: "Use a package name; * is allowed only at the start and/or end" }),
    versions: z
      .string()
      .trim()
      .max(256)
      .refine((value) => value === "" || isValidIgnoreVersions(value), { message: "Not a valid version range" })
      .optional()
      .transform((value) => (value === "" ? undefined : value)),
  })
  .strict();

export const ignoreRulesSchema = z.array(ignoreRuleSchema).max(MAX_IGNORE_RULES);

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

const LEVEL_RANK: Record<DepsUpdateLevel, number> = { PATCH: 1, MINOR: 2, MAJOR: 3 };

/** Numeric size of an update ignoring pre-release labels: 3 major (or minor on 0.x), 2 minor, 1 patch / other. */
function updateRank(current: string, target: string, ecosystem: DependencyEcosystem): number {
  const from = versionCore(ecosystem, current);
  const to = versionCore(ecosystem, target);
  if (!from || !to) return LEVEL_RANK.MAJOR;
  if (from.major !== to.major) return LEVEL_RANK.MAJOR;
  if (from.minor !== to.minor) return from.major === 0 ? LEVEL_RANK.MAJOR : LEVEL_RANK.MINOR;
  return LEVEL_RANK.PATCH;
}

/**
 * `SemverType` of `current → target`, with the thresholds of `classifySemver` in `@repopulse/github`: `MAJOR` when
 * the major changes (or the minor on `0.x`), `MINOR`, `PATCH` (any other release-segment change, PEP 440
 * post-releases), `PRERELEASE` when the target is a pre-release, `OTHER` when nothing comparable changed.
 */
export function classifyUpdate(current: string, target: string, ecosystem: DependencyEcosystem): SemverType {
  if (isPrereleaseVersion(ecosystem, target)) return "PRERELEASE";
  const from = versionCore(ecosystem, current);
  const to = versionCore(ecosystem, target);
  if (!from || !to) return "OTHER";
  if (from.major !== to.major) return "MAJOR";
  if (from.minor !== to.minor) return from.major === 0 ? "MAJOR" : "MINOR";
  if (from.patch !== to.patch) return "PATCH";
  if (compareVersions(ecosystem, current, target) !== 0) return "PATCH";
  return "OTHER";
}

// ---------------------------------------------------------------------------
// Target selection
// ---------------------------------------------------------------------------

export interface DepsPolicy {
  maxUpdateLevel: DepsUpdateLevel;
  includePrereleases: boolean;
  minReleaseAgeDays: number;
  rangeStrategy: DepsRangeStrategy;
  ignoreRules: readonly IgnoreRule[];
  /** The manifest's `requires-python` (PyPI only), in `requiresPythonSyntax` (default PEP 440). */
  requiresPython?: string | null;
  requiresPythonSyntax?: "pep440" | "poetry";
}

export interface PlanDependency {
  ecosystem: DependencyEcosystem;
  name: string;
  kind: DependencyKind;
  declared: string;
  rangeSyntax: RangeSyntax;
  /** From the lockfile (or `==` pin); `null` → the lower bound of `declared` is used. */
  currentVersion: string | null;
  supported: boolean;
  unsupportedReason?: string;
  /** Version whose PR was closed without merging (stored `targetVersion` of a `DISMISSED` row). */
  dismissedVersion?: string | null;
}

/** `UP_TO_DATE` → the worker deletes the row. */
export type SelectionStatus = DependencyUpdateStatus | "UP_TO_DATE";

export interface TargetSelection {
  status: SelectionStatus;
  /** The version compared against: lockfile / pin, else the declared lower bound. */
  currentVersion: string | null;
  currentFromLockfile: boolean;
  /** Newest acceptable version that satisfies `declared`. */
  wantedVersion: string | null;
  /** What a PR would set: only for `OUTDATED` (and `DISMISSED`, to compare on the next scan). */
  targetVersion: string | null;
  /** The version the status is about (= target when `OUTDATED`; the held-back version for `TOO_NEW` …). */
  consideredVersion: string | null;
  /** Newest version that passed the step-1 filters ("2.0.0 available, outside your policy"). */
  latestVersion: string | null;
  /** `current → considered`. */
  level: SemverType | null;
  /** Release date of `consideredVersion`. */
  targetReleasedAt: Date | null;
  /** `OUTDATED`: the declared spec to write (equal to `declared` for lockfile-only updates). */
  newDeclared: string | null;
  /** Short explanation for non-`OUTDATED` statuses. */
  reason: string | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Python versions probed to decide whether two `requires-python` specifiers overlap. */
const PYTHON_PROBES: string[] = ["2.7.0", "2.7.18"];
for (let minor = 0; minor <= 25; minor++) PYTHON_PROBES.push(`3.${minor}.0`, `3.${minor}.99`);

/** `true` when some Python version satisfies both specifiers (probed at `x.y.0` and `x.y.99`). */
export function requiresPythonOverlaps(
  fileSpec: string,
  projectSpec: string,
  projectSyntax: "pep440" | "poetry" = "pep440",
): boolean {
  if (!isValidPep440Constraint(fileSpec) || !isValidPep440Constraint(projectSpec, projectSyntax)) return true;
  return PYTHON_PROBES.some((python) => pep440Satisfies(python, fileSpec) && pep440Satisfies(python, projectSpec, projectSyntax));
}

function sameMajorMinor(ecosystem: DependencyEcosystem, a: string, b: string): boolean {
  const x = versionCore(ecosystem, a);
  const y = versionCore(ecosystem, b);
  return x !== null && y !== null && x.major === y.major && x.minor === y.minor;
}

function baseSelection(partial: Partial<TargetSelection> & { status: SelectionStatus }): TargetSelection {
  return {
    currentVersion: null,
    currentFromLockfile: false,
    wantedVersion: null,
    targetVersion: null,
    consideredVersion: null,
    latestVersion: null,
    level: null,
    targetReleasedAt: null,
    newDeclared: null,
    reason: null,
    ...partial,
  };
}

/**
 * Picks the update target of one dependency (§3.5 steps 1–7):
 * 1. drop deprecated, yanked, pre-release (unless `includePrereleases` and the current version is a pre-release of
 *    the same `major.minor`) and `requires-python`-incompatible versions;
 * 2. ignore rules (no `versions` → `IGNORED`; with `versions` those versions are dropped);
 * 3. nothing above current → `UP_TO_DATE`;
 * 4. above `maxUpdateLevel` → newest within the level, else `ABOVE_LEVEL`;
 * 5. younger than `minReleaseAgeDays` → newest old-enough version still above current, else `TOO_NEW`
 *    (unknown publish dates count as old enough);
 * 6. `LOCKFILE_ONLY` (and peer dependencies) need the target inside `declared`; with `BUMP` the range is bumped
 *    and an upper bound that rejects the target blocks it. In both cases the newest eligible version the range
 *    admits is used instead when there is one, else `BLOCKED_BY_RANGE`;
 * 7. a target equal to `dismissedVersion` → `DISMISSED`.
 */
export function selectTarget(
  candidates: readonly RegistryVersion[],
  dependency: PlanDependency,
  policy: DepsPolicy,
  now: Date,
): TargetSelection {
  const { ecosystem, declared, rangeSyntax } = dependency;
  if (!dependency.supported) {
    return baseSelection({ status: "UNSUPPORTED_SOURCE", reason: dependency.unsupportedReason ?? "Unsupported source" });
  }
  const fromLockfile = dependency.currentVersion !== null;
  const current = dependency.currentVersion ?? rangeLowerBound(rangeSyntax, declared);
  const currentIsPrerelease = current !== null && isPrereleaseVersion(ecosystem, current);
  const compare = (a: string, b: string): number => compareVersions(ecosystem, a, b);

  // Step 1.
  const projectPython = ecosystem === "PYPI" ? (policy.requiresPython ?? null) : null;
  const usable = candidates.filter((candidate) => {
    if (candidate.deprecated || candidate.yanked) return false;
    if (isPrereleaseVersion(ecosystem, candidate.version)) {
      if (!policy.includePrereleases || !currentIsPrerelease || current === null) return false;
      if (!sameMajorMinor(ecosystem, candidate.version, current)) return false;
    }
    if (projectPython && candidate.requiresPython) {
      if (!candidate.requiresPython.some((spec) => requiresPythonOverlaps(spec, projectPython, policy.requiresPythonSyntax))) {
        return false;
      }
    }
    return true;
  });
  usable.sort((a, b) => compare(a.version, b.version));
  const latestVersion = usable.at(-1)?.version ?? null;
  const wantedVersion = maxSatisfying(rangeSyntax, usable.map((c) => c.version), declared);
  const common = { currentVersion: current, currentFromLockfile: fromLockfile, wantedVersion, latestVersion };

  // Step 2.
  let remaining = usable;
  for (const rule of policy.ignoreRules) {
    if (!ignorePatternMatches(rule.name, dependency.name, ecosystem)) continue;
    if (!rule.versions) {
      return baseSelection({ ...common, status: "IGNORED", reason: `Ignored by rule "${rule.name}"` });
    }
    const range = rule.versions;
    remaining = remaining.filter((candidate) => !satisfiesRange(rangeSyntax, candidate.version, range));
  }

  // Step 3.
  if (current === null) {
    return baseSelection({ ...common, status: "UP_TO_DATE", reason: "No current version (no lockfile entry or lower bound)" });
  }
  const above = remaining.filter((candidate) => compare(candidate.version, current) > 0);
  const newest = above.at(-1);
  if (!newest) return baseSelection({ ...common, status: "UP_TO_DATE" });

  const describe = (version: RegistryVersion | undefined): Partial<TargetSelection> =>
    version
      ? {
          consideredVersion: version.version,
          level: classifyUpdate(current, version.version, ecosystem),
          targetReleasedAt: version.publishedAt,
        }
      : {};

  // Step 4.
  const maxRank = LEVEL_RANK[policy.maxUpdateLevel];
  const withinLevel = above.filter((candidate) => updateRank(current, candidate.version, ecosystem) <= maxRank);
  if (withinLevel.length === 0) {
    return baseSelection({
      ...common,
      ...describe(newest),
      status: "ABOVE_LEVEL",
      reason: `${newest.version} is above the ${policy.maxUpdateLevel.toLowerCase()} update level`,
    });
  }

  // Step 5.
  const cutoff = now.getTime() - Math.max(0, policy.minReleaseAgeDays) * DAY_MS;
  const oldEnough = (candidate: RegistryVersion): boolean =>
    candidate.publishedAt === null || candidate.publishedAt.getTime() <= cutoff;
  const eligible = withinLevel.filter(oldEnough);
  const preferred = withinLevel.at(-1) as RegistryVersion;
  if (eligible.length === 0) {
    return baseSelection({
      ...common,
      ...describe(preferred),
      status: "TOO_NEW",
      reason: `${preferred.version} is younger than ${policy.minReleaseAgeDays} days`,
    });
  }

  // Step 6.
  const lockfileOnly = policy.rangeStrategy === "LOCKFILE_ONLY" || dependency.kind === "PEER";
  let target: RegistryVersion | undefined;
  let newDeclared: string | null = null;
  for (let index = eligible.length - 1; index >= 0; index--) {
    const candidate = eligible[index] as RegistryVersion;
    if (lockfileOnly) {
      if (satisfiesRange(rangeSyntax, candidate.version, declared)) {
        target = candidate;
        newDeclared = declared;
        break;
      }
    } else {
      const bump = bumpRange(rangeSyntax, declared, candidate.version);
      if (bump.outcome !== "blocked") {
        target = candidate;
        newDeclared = bump.outcome === "bumped" ? bump.declared : declared;
        break;
      }
    }
  }
  if (!target) {
    const blocked = eligible.at(-1) as RegistryVersion;
    return baseSelection({
      ...common,
      ...describe(blocked),
      status: "BLOCKED_BY_RANGE",
      reason: lockfileOnly
        ? `${blocked.version} is outside the declared range "${declared}"`
        : `The declared range "${declared}" excludes ${blocked.version}`,
    });
  }

  // Step 7.
  if (dependency.dismissedVersion && compare(target.version, dependency.dismissedVersion) === 0) {
    return baseSelection({
      ...common,
      ...describe(target),
      targetVersion: target.version,
      status: "DISMISSED",
      reason: `The pull request for ${target.version} was closed`,
    });
  }
  return baseSelection({ ...common, ...describe(target), targetVersion: target.version, newDeclared, status: "OUTDATED" });
}

export interface PolicyInput {
  dependency: PlanDependency;
  /** Registry versions, or `null` when the package is not on the public registry. */
  candidates: readonly RegistryVersion[] | null;
  /** Reason from the registry lookup when `candidates` is `null`. */
  notFoundReason?: string;
}

/** {@link selectTarget} over many dependencies; a registry miss → `UNSUPPORTED_SOURCE`. */
export function applyPolicy(items: readonly PolicyInput[], policy: DepsPolicy, now: Date): TargetSelection[] {
  return items.map((item) =>
    item.candidates === null
      ? baseSelection({ status: "UNSUPPORTED_SOURCE", reason: item.notFoundReason ?? "Not on the public registry" })
      : selectTarget(item.candidates, item.dependency, policy, now),
  );
}

// ---------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------

export interface GroupableUpdate {
  ecosystem: DependencyEcosystem;
  name: string;
  manifestPath: string;
  level: SemverType | null;
}

export interface UpdateGroup<T extends GroupableUpdate> {
  /** `[a-z0-9-]` only: `all`, `major-<slug>`, `<eco>-<slug>`. */
  groupKey: string;
  updates: T[];
  /** Contains a major update (sorted last). */
  isMajor: boolean;
  /** Among the first `maxOpenPrs` groups: may have a PR now; the rest wait for a slot. */
  hasPrSlot: boolean;
}

/** `@types/node` → `types-node`; `[a-z0-9-]`, at most 60 characters, never empty. */
export function slugifyGroupName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return slug === "" ? "dep" : slug;
}

/** `true` for a valid group key (also the branch suffix). */
export function isValidGroupKey(key: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/.test(key);
}

function compareUpdates(a: GroupableUpdate, b: GroupableUpdate): number {
  if (a.name !== b.name) return a.name < b.name ? -1 : 1;
  if (a.manifestPath !== b.manifestPath) return a.manifestPath < b.manifestPath ? -1 : 1;
  return 0;
}

/**
 * Groups outdated updates into pull requests (§3.5), deterministic order (non-major groups first, `all` first,
 * then by key; majors last). Only the first `maxOpenPrs` groups get `hasPrSlot`.
 * - `SINGLE`: one `all` group;
 * - `SEPARATE_MAJORS`: `all` for patch + minor (+ others), `major-<slug(name)>` per major dependency;
 * - `PER_DEPENDENCY`: `<eco>-<slug(name)>` per dependency name (every manifest that uses it moves together).
 */
export function groupUpdates<T extends GroupableUpdate>(
  outdated: readonly T[],
  groupMode: DepsGroupMode,
  maxOpenPrs: number = Number.POSITIVE_INFINITY,
): UpdateGroup<T>[] {
  const groups = new Map<string, T[]>();
  for (const update of outdated) {
    let key: string;
    if (groupMode === "SINGLE") key = "all";
    else if (groupMode === "SEPARATE_MAJORS") key = update.level === "MAJOR" ? `major-${slugifyGroupName(update.name)}` : "all";
    else key = `${update.ecosystem.toLowerCase()}-${slugifyGroupName(update.name)}`;
    const list = groups.get(key) ?? [];
    list.push(update);
    groups.set(key, list);
  }
  const result = [...groups.entries()].map(([groupKey, updates]) => ({
    groupKey,
    updates: [...updates].sort(compareUpdates),
    isMajor: updates.some((update) => update.level === "MAJOR"),
    hasPrSlot: false,
  }));
  result.sort((a, b) => {
    if (a.isMajor !== b.isMajor) return a.isMajor ? 1 : -1;
    if (a.groupKey === "all" || b.groupKey === "all") return a.groupKey === "all" ? -1 : 1;
    return a.groupKey < b.groupKey ? -1 : a.groupKey > b.groupKey ? 1 : 0;
  });
  result.forEach((group, index) => {
    group.hasPrSlot = index < maxOpenPrs;
  });
  return result;
}

// ---------------------------------------------------------------------------
// Pull request capability
// ---------------------------------------------------------------------------

export interface ManifestUpdateTarget {
  path: string;
  packageManager: PackageManager;
  lockfilePath: string | null;
  /** From detection (Yarn, `bun.lockb`, pip-tools). */
  checkOnlyReason?: string | null;
}

/** Package managers whose lockfile the sandbox regenerates. */
const REGENERATED: ReadonlySet<PackageManager> = new Set(SANDBOX_PACKAGE_MANAGERS);

/** Check-only reason of a manifest (Yarn, `bun.lockb`, pip-tools), or `null`. */
export function manifestCheckOnlyReason(manifest: ManifestUpdateTarget): string | null {
  if (manifest.checkOnlyReason) return manifest.checkOnlyReason;
  if (manifest.packageManager === "YARN") return "Yarn projects are check only: update pull requests are not supported";
  if (manifest.packageManager === "PIP_TOOLS") return "pip-compile output is check only: recompile it with pip-compile";
  if (manifest.packageManager === "BUN" && manifest.lockfilePath?.endsWith("bun.lockb")) {
    return "bun.lockb is binary and cannot be regenerated: switch to the text bun.lock";
  }
  return null;
}

/** `true` when an update must regenerate a lockfile (any manager except `NONE` / `PIP` with a lockfile present). */
export function manifestNeedsLockfile(manifest: ManifestUpdateTarget): boolean {
  return manifest.lockfilePath !== null && REGENERATED.has(manifest.packageManager);
}

export interface GroupCapability {
  canCreatePr: boolean;
  needsLockfile: boolean;
  /** Lockfiles the update regenerates (unique, sorted). */
  lockfiles: string[];
  /** Why "Create PR" is disabled, or `null`. */
  reason: string | null;
}

/**
 * Whether a group's manifests can get an update PR. Check-only manifests (Yarn, `bun.lockb`, pip-tools) block it;
 * a lockfile regeneration blocks it until the sandbox is available (`lockfileRegeneration`, Part D).
 */
export function groupCapability(
  manifests: readonly ManifestUpdateTarget[],
  options: { lockfileRegeneration: boolean },
): GroupCapability {
  const lockfiles = [
    ...new Set(manifests.filter(manifestNeedsLockfile).map((manifest) => manifest.lockfilePath as string)),
  ].sort();
  const needsLockfile = lockfiles.length > 0;
  for (const manifest of manifests) {
    const reason = manifestCheckOnlyReason(manifest);
    if (reason) return { canCreatePr: false, needsLockfile, lockfiles, reason: `${manifest.path}: ${reason}` };
  }
  if (needsLockfile && !options.lockfileRegeneration) {
    return {
      canCreatePr: false,
      needsLockfile,
      lockfiles,
      reason: `Needs a regenerated lockfile (${lockfiles.join(", ")}), which is not available yet`,
    };
  }
  return { canCreatePr: true, needsLockfile, lockfiles, reason: null };
}

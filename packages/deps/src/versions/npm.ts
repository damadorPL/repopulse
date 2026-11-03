/** npm semver ranges (wraps `semver`): validity, maxSatisfying, lower bound and style-keeping range bumps. */
import semver from "semver";
import type { BumpResult } from "./bump.js";

const RANGE_OPTIONS = { loose: false, includePrerelease: true } as const;

/** Specs that are not registry semver ranges (→ `UNSUPPORTED_SOURCE`). `null` when the spec is a usable range. */
export function npmUnsupportedReason(spec: string): string | null {
  const value = spec.trim();
  if (value === "" || value === "*" || value.toLowerCase() === "x") return "Any version (`*`): nothing to compare";
  const lower = value.toLowerCase();
  const prefixes: Array<[string, string]> = [
    ["workspace:", "Workspace dependency"],
    ["catalog:", "pnpm catalog entry"],
    ["npm:", "npm alias"],
    ["file:", "Local file dependency"],
    ["link:", "Linked dependency"],
    ["portal:", "Portal dependency"],
    ["patch:", "Patched dependency"],
    ["exec:", "exec: dependency"],
    ["jsr:", "JSR dependency"],
    ["git+", "Git dependency"],
    ["git:", "Git dependency"],
    ["git@", "Git dependency"],
    ["github:", "GitHub dependency"],
    ["gitlab:", "GitLab dependency"],
    ["bitbucket:", "Bitbucket dependency"],
    ["gist:", "Gist dependency"],
    ["http://", "URL dependency"],
    ["https://", "URL dependency"],
  ];
  for (const [prefix, reason] of prefixes) if (lower.startsWith(prefix)) return reason;
  if (value.startsWith(".") || value.startsWith("/") || value.startsWith("~/")) return "Local path dependency";
  if (/^[^@\s]+\/[^\s]+$/.test(value) && !/^[<>=~^\d]/.test(value)) return "GitHub dependency";
  if (semver.validRange(value, RANGE_OPTIONS) === null) return "Not a semver range (dist-tag or unknown spec)";
  return null;
}

/** `true` for a valid npm semver range (not `*`, aliases, tags, URLs …). */
export function isSupportedNpmRange(spec: string): boolean {
  return npmUnsupportedReason(spec) === null;
}

/** Valid semver version (`1.2.3`, `1.2.3-beta.1`). */
export function isValidNpmVersion(version: string): boolean {
  return semver.valid(version) !== null;
}

export function compareNpm(a: string, b: string): number {
  return semver.compare(a, b);
}

export function isNpmPrerelease(version: string): boolean {
  return (semver.prerelease(version)?.length ?? 0) > 0;
}

/** `version` is inside `range` (pre-releases are not filtered: the planner decides). Invalid input → `false`. */
export function npmSatisfies(version: string, range: string): boolean {
  try {
    return semver.satisfies(version, range, RANGE_OPTIONS);
  } catch {
    return false;
  }
}

/** Highest version in `range` → `wantedVersion`. */
export function npmMaxSatisfying(versions: readonly string[], range: string): string | null {
  try {
    return semver.maxSatisfying([...versions], range, RANGE_OPTIONS);
  } catch {
    return null;
  }
}

/** Lowest version the range admits (`^1.2.3` → `1.2.3`, `1.x` → `1.0.0`), used when no lockfile pins one. */
export function npmLowerBound(range: string): string | null {
  try {
    return semver.minVersion(range)?.version ?? null;
  } catch {
    return null;
  }
}

const SIMPLE_RANGE =
  /^(?<op>\^|~|>=|=)?(?<v>v?)(?<major>\d+|[xX*])(?:\.(?<minor>\d+|[xX*]))?(?:\.(?<patch>\d+|[xX*]))?(?<pre>-[0-9A-Za-z.-]+)?(?<build>\+[0-9A-Za-z.-]+)?$/;

/**
 * Bumps `declared` so that it admits `target`, keeping its operator style and precision: `1.2.3` → `1.4.0`,
 * `^1.2.3` → `^1.4.0`, `~1.2.3` → `~1.2.9`, `>=1.2.3` → `>=1.4.0`, `1.x` / `^1` → `2.x` / `^2` for a major.
 * A compound range (`>=1 <3`, `||`, hyphen) or a bare upper bound is never rewritten: `unchanged` when the target
 * is inside it, `blocked` otherwise.
 */
export function npmBumpRange(declared: string, target: string): BumpResult {
  const range = declared.trim();
  const leading = declared.slice(0, declared.indexOf(range));
  const trailing = declared.slice(leading.length + range.length);
  const targetVersion = semver.parse(target);
  if (!targetVersion) return { outcome: "blocked" };
  const match = SIMPLE_RANGE.exec(range);
  const groups = match?.groups;
  if (!groups) return npmSatisfies(target, range) ? { outcome: "unchanged" } : { outcome: "blocked" };

  const parts = [groups.major, groups.minor, groups.patch];
  const numbers = [targetVersion.major, targetVersion.minor, targetVersion.patch];
  const written: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part === undefined) break;
    written.push(/^\d+$/.test(part) ? String(numbers[i]) : part);
  }
  const allNumeric = written.length === 3 && written.every((part) => /^\d+$/.test(part));
  let version = written.join(".");
  if (allNumeric && targetVersion.prerelease.length > 0) version += `-${targetVersion.prerelease.join(".")}`;
  let next = `${groups.op ?? ""}${groups.v ?? ""}${version}`;
  if (!npmSatisfies(target, next)) {
    // Precision too low for a pre-release target, or an x-range that cannot hold it: write the full version.
    next = `${groups.op ?? ""}${groups.v ?? ""}${targetVersion.version}`;
    if (!npmSatisfies(target, next)) return { outcome: "blocked" };
  }
  if (next === range) return { outcome: "unchanged" };
  return { outcome: "bumped", declared: `${leading}${next}${trailing}` };
}

/** Ecosystem-agnostic version helpers used by the planner (npm semver or PEP 440 / Poetry). */
import semver from "semver";
import type { DependencyEcosystem, RangeSyntax } from "../types.js";
import type { BumpResult } from "./bump.js";
import {
  compareNpm,
  isNpmPrerelease,
  isSupportedNpmRange,
  npmBumpRange,
  npmLowerBound,
  npmMaxSatisfying,
  npmSatisfies,
} from "./npm.js";
import {
  comparePep440,
  isPep440Prerelease,
  isValidPep440Constraint,
  parsePep440,
  pep440BumpSpecifier,
  pep440LowerBound,
  pep440MaxSatisfying,
  pep440Satisfies,
} from "./pep440.js";

export function isValidVersion(ecosystem: DependencyEcosystem, version: string): boolean {
  return ecosystem === "NPM" ? semver.valid(version) !== null : parsePep440(version) !== null;
}

/** Sort comparator; invalid versions sort first. */
export function compareVersions(ecosystem: DependencyEcosystem, a: string, b: string): number {
  if (ecosystem === "PYPI") return comparePep440(a, b);
  const validA = semver.valid(a) !== null;
  const validB = semver.valid(b) !== null;
  if (!validA || !validB) return validA === validB ? 0 : validA ? 1 : -1;
  return compareNpm(a, b);
}

export function isPrereleaseVersion(ecosystem: DependencyEcosystem, version: string): boolean {
  return ecosystem === "NPM" ? isNpmPrerelease(version) : isPep440Prerelease(version);
}

/** `{ major, minor, patch }` of the release part (missing segments = 0), or `null` when invalid. */
export function versionCore(
  ecosystem: DependencyEcosystem,
  version: string,
): { major: number; minor: number; patch: number; rest: number[] } | null {
  if (ecosystem === "NPM") {
    const parsed = semver.parse(version);
    return parsed ? { major: parsed.major, minor: parsed.minor, patch: parsed.patch, rest: [] } : null;
  }
  const parsed = parsePep440(version);
  if (!parsed) return null;
  const [major = 0, minor = 0, patch = 0, ...rest] = parsed.release;
  return { major, minor, patch, rest };
}

export function isValidRange(syntax: RangeSyntax, range: string): boolean {
  return syntax === "npm" ? isSupportedNpmRange(range) : isValidPep440Constraint(range, syntax);
}

export function satisfiesRange(syntax: RangeSyntax, version: string, range: string): boolean {
  return syntax === "npm" ? npmSatisfies(version, range) : pep440Satisfies(version, range, syntax);
}

export function maxSatisfying(syntax: RangeSyntax, versions: readonly string[], range: string): string | null {
  return syntax === "npm" ? npmMaxSatisfying(versions, range) : pep440MaxSatisfying(versions, range, syntax);
}

export function rangeLowerBound(syntax: RangeSyntax, range: string): string | null {
  return syntax === "npm" ? npmLowerBound(range) : pep440LowerBound(range, syntax);
}

export function bumpRange(syntax: RangeSyntax, declared: string, target: string): BumpResult {
  return syntax === "npm" ? npmBumpRange(declared, target) : pep440BumpSpecifier(declared, target, syntax);
}

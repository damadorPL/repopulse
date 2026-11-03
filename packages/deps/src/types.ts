/**
 * Shared types of the Dependencies module. The string unions mirror the Prisma enums in
 * `packages/db/prisma/schema.prisma`, so web and the worker can pass Prisma values straight in.
 */

export type DependencyEcosystem = "NPM" | "PYPI";
export type PackageManager = "NPM" | "PNPM" | "BUN" | "YARN" | "PIP" | "PIP_TOOLS" | "UV" | "POETRY" | "NONE";
export type DependencyKind = "PROD" | "DEV" | "PEER" | "OPTIONAL" | "GROUP";
export type DependencyUpdateStatus =
  | "OUTDATED"
  | "TOO_NEW"
  | "ABOVE_LEVEL"
  | "BLOCKED_BY_RANGE"
  | "IGNORED"
  | "DISMISSED"
  | "UNSUPPORTED_SOURCE";
export type SemverType = "MAJOR" | "MINOR" | "PATCH" | "PRERELEASE" | "OTHER";
export type DepsUpdateMode = "NOTIFY" | "MANUAL_PR" | "AUTO_PR";
export type DepsUpdateLevel = "PATCH" | "MINOR" | "MAJOR";
export type DepsGroupMode = "SINGLE" | "SEPARATE_MAJORS" | "PER_DEPENDENCY";
export type DepsRangeStrategy = "BUMP" | "LOCKFILE_ONLY";
export type DepsPrState = "OPEN" | "MERGED" | "CLOSED" | "EDITED";

/**
 * Syntax of a declared range: npm semver ranges, PEP 440 specifiers (PEP 508 strings, requirements files) or
 * Poetry constraints (`^` / `~` / `||` on top of PEP 440).
 */
export type RangeSyntax = "npm" | "pep440" | "poetry";

/** Half-open `[start, end)` offsets into the file text (JavaScript string indices, i.e. UTF-16 code units). */
export interface TextSpan {
  start: number;
  end: number;
}

/** One direct dependency as declared in a manifest. */
export interface ParsedDependency {
  /** npm name as written, or the PEP 503-normalized PyPI name. */
  name: string;
  /** The name exactly as written in the file. */
  rawName: string;
  kind: DependencyKind;
  /** PEP 735 group, Poetry group or extra; `""` = none. Also `"overrides"` / `"resolutions"` for npm overrides. */
  group: string;
  /** The spec as written: `"^1.2.3"`, `">=2,<3"`, `"==4.1.0"`, `""` (unpinned requirement). */
  declared: string;
  rangeSyntax: RangeSyntax;
  /** Location of `declared` in the file, for span edits. `null` when it cannot be rewritten safely. */
  span: TextSpan | null;
  /** `false` → `UNSUPPORTED_SOURCE` (git / file / workspace / alias / URL / catalog / private index …). */
  supported: boolean;
  /** Why it is unsupported (shown in the UI). */
  unsupportedReason?: string;
  /** Repo-relative path of the file that declares it (differs from the manifest for `-r` includes). */
  file: string;
}

/** Ecosystem of a range syntax. */
export function ecosystemOfSyntax(syntax: RangeSyntax): DependencyEcosystem {
  return syntax === "npm" ? "NPM" : "PYPI";
}

/**
 * PEP 440 versions and specifiers, plus Poetry constraints (`^`, `~`, bare versions, `*`, `||`), written here rather
 * than added as a dependency (Slice 08 §3.3). Pure and browser-safe.
 */
import type { BumpResult } from "./bump.js";

type PreLabel = "a" | "b" | "rc";

export interface Pep440Version {
  epoch: number;
  release: number[];
  pre: { label: PreLabel; number: number } | null;
  post: number | null;
  dev: number | null;
  /** Local segments (`+ubuntu.1` → `["ubuntu", 1]`), or `null`. */
  local: Array<string | number> | null;
}

const VERSION_PATTERN = new RegExp(
  "^\\s*v?" +
    "(?:(?<epoch>[0-9]+)!)?" +
    "(?<release>[0-9]+(?:\\.[0-9]+)*)" +
    "(?<pre>[-_.]?(?<preL>alpha|a|beta|b|preview|pre|c|rc)[-_.]?(?<preN>[0-9]+)?)?" +
    "(?<post>(?:-(?<postN1>[0-9]+))|(?:[-_.]?(?<postL>post|rev|r)[-_.]?(?<postN2>[0-9]+)?))?" +
    "(?<dev>[-_.]?(?<devL>dev)[-_.]?(?<devN>[0-9]+)?)?" +
    "(?:\\+(?<local>[a-z0-9]+(?:[-_.][a-z0-9]+)*))?" +
    "\\s*$",
  "i",
);

/** Parses a PEP 440 version (normalizing spellings such as `1.0-alpha1`, `1.0.post`, `v2`). `null` if invalid. */
export function parsePep440(input: string): Pep440Version | null {
  const match = VERSION_PATTERN.exec(input);
  const groups = match?.groups;
  if (!groups) return null;
  const release = (groups.release as string).split(".").map(Number);
  let pre: Pep440Version["pre"] = null;
  if (groups.preL) {
    const label = groups.preL.toLowerCase();
    const normalized: PreLabel = label === "alpha" || label === "a" ? "a" : label === "beta" || label === "b" ? "b" : "rc";
    pre = { label: normalized, number: groups.preN ? Number(groups.preN) : 0 };
  }
  let post: number | null = null;
  if (groups.postN1 !== undefined) post = Number(groups.postN1);
  else if (groups.postL) post = groups.postN2 ? Number(groups.postN2) : 0;
  const dev = groups.devL ? (groups.devN ? Number(groups.devN) : 0) : null;
  const local = groups.local
    ? groups.local
        .toLowerCase()
        .split(/[-_.]/)
        .map((segment) => (/^[0-9]+$/.test(segment) ? Number(segment) : segment))
    : null;
  return { epoch: groups.epoch ? Number(groups.epoch) : 0, release, pre, post, dev, local };
}

/** `true` when the string is a valid PEP 440 version. */
export function isValidPep440(input: string): boolean {
  return parsePep440(input) !== null;
}

/** Canonical string form (`1.0a1.post2.dev3+local.1`). */
export function formatPep440(version: Pep440Version): string {
  let out = version.epoch ? `${version.epoch}!` : "";
  out += version.release.join(".");
  if (version.pre) out += `${version.pre.label}${version.pre.number}`;
  if (version.post !== null) out += `.post${version.post}`;
  if (version.dev !== null) out += `.dev${version.dev}`;
  if (version.local) out += `+${version.local.join(".")}`;
  return out;
}

/** Normalizes a version string (`1.0-Alpha1` → `1.0a1`); returns the input unchanged when invalid. */
export function normalizePep440(input: string): string {
  const parsed = parsePep440(input);
  return parsed ? formatPep440(parsed) : input.trim();
}

/** Pre-release or dev release. */
export function isPep440Prerelease(version: Pep440Version | string): boolean {
  const parsed = typeof version === "string" ? parsePep440(version) : version;
  return parsed !== null && (parsed.pre !== null || parsed.dev !== null);
}

const PRE_RANK: Record<PreLabel, number> = { a: 0, b: 1, rc: 2 };

function compareNumbers(a: number, b: number): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareRelease(a: number[], b: number[]): number {
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i++) {
    const diff = compareNumbers(a[i] ?? 0, b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function compareLocal(a: Array<string | number> | null, b: Array<string | number> | null): number {
  if (a === null || b === null) return a === b ? 0 : a === null ? -1 : 1;
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i++) {
    const x = a[i];
    const y = b[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (typeof x === "number" && typeof y === "number") {
      const diff = compareNumbers(x, y);
      if (diff !== 0) return diff;
    } else if (typeof x === "number") return 1;
    else if (typeof y === "number") return -1;
    else if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** Sort keys of the pre / post / dev parts per PEP 440 (see `packaging.version._cmpkey`). */
function suffixKey(version: Pep440Version): [number, number, number, number] {
  // [preRank, preNumber, post, dev]; Infinity / -Infinity as in packaging.
  let preRank: number;
  let preNumber = 0;
  if (version.pre === null && version.post === null && version.dev !== null) preRank = -Infinity;
  else if (version.pre === null) preRank = Infinity;
  else {
    preRank = PRE_RANK[version.pre.label];
    preNumber = version.pre.number;
  }
  const post = version.post === null ? -Infinity : version.post;
  const dev = version.dev === null ? Infinity : version.dev;
  return [preRank, preNumber, post, dev];
}

/** Compares two versions (strings are parsed; an invalid string sorts first). */
export function comparePep440(a: Pep440Version | string, b: Pep440Version | string): number {
  const x = typeof a === "string" ? parsePep440(a) : a;
  const y = typeof b === "string" ? parsePep440(b) : b;
  if (!x || !y) return x === y ? 0 : x ? 1 : -1;
  if (x.epoch !== y.epoch) return compareNumbers(x.epoch, y.epoch);
  const release = compareRelease(x.release, y.release);
  if (release !== 0) return release;
  const kx = suffixKey(x);
  const ky = suffixKey(y);
  for (let i = 0; i < kx.length; i++) {
    const diff = compareNumbers(kx[i] as number, ky[i] as number);
    if (diff !== 0) return diff;
  }
  return compareLocal(x.local, y.local);
}

function publicVersion(version: Pep440Version): Pep440Version {
  return { ...version, local: null };
}

function baseVersion(version: Pep440Version): Pep440Version {
  return { epoch: version.epoch, release: version.release, pre: null, post: null, dev: null, local: null };
}

// ---------------------------------------------------------------------------
// Constraints
// ---------------------------------------------------------------------------

export type ConstraintOperator = "~=" | "==" | "!=" | "<=" | ">=" | "<" | ">" | "===" | "^" | "~" | "=" | "*";

export interface ConstraintClause {
  operator: ConstraintOperator;
  /** Version text as written (without `.*`); `""` for `*`. */
  version: string;
  /** `==1.*` / Poetry `1.2.*`. */
  wildcard: boolean;
  /** Offsets of `version` in the constraint string. */
  versionStart: number;
  versionEnd: number;
}

/** OR of AND clauses. An empty AND list matches everything. */
export type ParsedConstraint = ConstraintClause[][];

const PEP440_OPERATORS = ["===", "~=", "==", "!=", "<=", ">=", "<", ">"] as const;
const POETRY_OPERATORS = ["===", "~=", "==", "!=", "<=", ">=", "<", ">", "^", "~", "="] as const;

/**
 * Parses a PEP 440 specifier set (`>=1.2, <2`, `==1.*`, `~=1.4`) or, with `poetry`, a Poetry constraint (`^1.2`,
 * `~1.2.3`, `1.2.3`, `1.2.*`, `*`, `>=1,<2 || ^3`). Returns `null` when invalid.
 */
export function parsePep440Constraint(text: string, syntax: "pep440" | "poetry" = "pep440"): ParsedConstraint | null {
  const operators = syntax === "poetry" ? POETRY_OPERATORS : PEP440_OPERATORS;
  const alternatives: ParsedConstraint = [];
  let current: ConstraintClause[] = [];
  let i = 0;
  let expectSeparator = false;
  while (i < text.length) {
    const char = text[i] as string;
    if (char === " " || char === "\t") {
      i++;
      continue;
    }
    if (char === ",") {
      if (!expectSeparator) return null;
      expectSeparator = false;
      i++;
      continue;
    }
    if (char === "|") {
      if (syntax !== "poetry" || !expectSeparator) return null;
      i += text[i + 1] === "|" ? 2 : 1;
      alternatives.push(current);
      current = [];
      expectSeparator = false;
      continue;
    }
    if (expectSeparator && syntax === "pep440") return null;
    let operator: ConstraintOperator | null = null;
    for (const candidate of operators) {
      if (text.startsWith(candidate, i)) {
        operator = candidate;
        i += candidate.length;
        break;
      }
    }
    while (text[i] === " " || text[i] === "\t") i++;
    const start = i;
    while (i < text.length && !/[\s,|]/.test(text[i] as string)) i++;
    let version = text.slice(start, i);
    if (version === "") return null;
    if (operator === null) {
      if (syntax !== "poetry") return null;
      if (version === "*") {
        current.push({ operator: "*", version: "", wildcard: false, versionStart: start, versionEnd: start });
        expectSeparator = true;
        continue;
      }
      operator = "=";
    }
    let wildcard = false;
    if (version.endsWith(".*")) {
      if (operator !== "==" && operator !== "!=" && operator !== "=") return null;
      wildcard = true;
      version = version.slice(0, -2);
    }
    if (operator === "===") {
      current.push({ operator, version, wildcard, versionStart: start, versionEnd: start + version.length });
      expectSeparator = true;
      continue;
    }
    const parsed = parsePep440(version);
    if (!parsed) return null;
    if (wildcard && (parsed.pre || parsed.post !== null || parsed.dev !== null || parsed.local)) return null;
    if (operator === "~=" && parsed.release.length < 2) return null;
    current.push({ operator, version, wildcard, versionStart: start, versionEnd: start + version.length });
    expectSeparator = true;
  }
  if (!expectSeparator && current.length > 0) return null;
  if (alternatives.length > 0 && current.length === 0) return null;
  alternatives.push(current);
  return alternatives;
}

/** `true` when the text is a valid PEP 440 specifier set (or Poetry constraint). */
export function isValidPep440Constraint(text: string, syntax: "pep440" | "poetry" = "pep440"): boolean {
  return parsePep440Constraint(text, syntax) !== null;
}

function nextBoundary(release: number[], index: number): number[] {
  const out = release.slice(0, index + 1).map((n) => n);
  while (out.length < index + 1) out.push(0);
  out[index] = (out[index] ?? 0) + 1;
  return out;
}

/** Exclusive upper bound of a Poetry caret / tilde clause. */
function poetryUpperBound(operator: "^" | "~", version: Pep440Version): number[] {
  const release = version.release;
  if (operator === "~") return nextBoundary(release, release.length === 1 ? 0 : 1);
  const [major = 0, minor = 0] = release;
  if (major > 0 || release.length === 1) return nextBoundary(release, 0);
  if (minor > 0 || release.length === 2) return nextBoundary(release, 1);
  return nextBoundary(release, 2);
}

function releaseOnly(epoch: number, release: number[]): Pep440Version {
  return { epoch, release, pre: null, post: null, dev: null, local: null };
}

function prefixMatches(candidate: Pep440Version, prefix: Pep440Version): boolean {
  if (candidate.epoch !== prefix.epoch) return false;
  return prefix.release.every((segment, index) => (candidate.release[index] ?? 0) === segment);
}

function lessThan(candidate: Pep440Version, bound: Pep440Version): boolean {
  if (comparePep440(publicVersion(candidate), bound) >= 0) return false;
  // `<3.0` excludes 3.0 pre-releases unless the bound is itself a pre-release.
  if (!isPep440Prerelease(bound) && isPep440Prerelease(candidate)) {
    if (comparePep440(baseVersion(candidate), baseVersion(bound)) === 0) return false;
  }
  return true;
}

function clauseMatches(clause: ConstraintClause, candidate: Pep440Version, rawCandidate: string): boolean {
  if (clause.operator === "*") return true;
  if (clause.operator === "===") return rawCandidate.trim().toLowerCase() === clause.version.toLowerCase();
  const spec = parsePep440(clause.version);
  if (!spec) return false;
  switch (clause.operator) {
    case "==":
    case "=":
    case "!=": {
      let equal: boolean;
      if (clause.wildcard) equal = prefixMatches(candidate, spec);
      else if (spec.local) equal = comparePep440(candidate, spec) === 0;
      else equal = comparePep440(publicVersion(candidate), spec) === 0;
      return clause.operator === "!=" ? !equal : equal;
    }
    case "~=": {
      if (comparePep440(publicVersion(candidate), spec) < 0) return false;
      return prefixMatches(candidate, releaseOnly(spec.epoch, spec.release.slice(0, -1)));
    }
    case ">=":
      return comparePep440(publicVersion(candidate), spec) >= 0;
    case "<=":
      return comparePep440(publicVersion(candidate), spec) <= 0;
    case "<":
      return lessThan(candidate, spec);
    case ">": {
      if (comparePep440(publicVersion(candidate), spec) <= 0) return false;
      const sameBase = comparePep440(baseVersion(candidate), baseVersion(spec)) === 0;
      if (spec.post === null && candidate.post !== null && sameBase) return false;
      if (candidate.local !== null && sameBase) return false;
      return true;
    }
    case "^":
    case "~": {
      if (comparePep440(publicVersion(candidate), spec) < 0) return false;
      return lessThan(candidate, releaseOnly(spec.epoch, poetryUpperBound(clause.operator, spec)));
    }
  }
}

/**
 * `true` when `version` satisfies the constraint. Pre-releases are not filtered here (the planner decides).
 * Invalid input → `false`.
 */
export function pep440Satisfies(
  version: string,
  constraint: string | ParsedConstraint,
  syntax: "pep440" | "poetry" = "pep440",
): boolean {
  const candidate = parsePep440(version);
  const parsed = typeof constraint === "string" ? parsePep440Constraint(constraint, syntax) : constraint;
  if (!candidate || !parsed) return false;
  return parsed.some((clauses) => clauses.every((clause) => clauseMatches(clause, candidate, version)));
}

/** Highest version satisfying the constraint (pre-releases included only if passed in). */
export function pep440MaxSatisfying(
  versions: readonly string[],
  constraint: string,
  syntax: "pep440" | "poetry" = "pep440",
): string | null {
  const parsed = parsePep440Constraint(constraint, syntax);
  if (!parsed) return null;
  let best: string | null = null;
  for (const version of versions) {
    if (!pep440Satisfies(version, parsed)) continue;
    if (best === null || comparePep440(version, best) > 0) best = version;
  }
  return best;
}

const LOWER_BOUND_OPERATORS = new Set<ConstraintOperator>(["==", "=", "===", "~=", ">=", ">", "^", "~"]);

/**
 * Lowest version the constraint names as a lower bound (`>=1.2,<2` → `1.2`, `==1.*` → `1`, `^0.3` → `0.3`), used
 * as the current version when no lockfile pins one. `null` when there is none (`<2`, `*`, `!=1.0`).
 */
export function pep440LowerBound(constraint: string, syntax: "pep440" | "poetry" = "pep440"): string | null {
  const parsed = parsePep440Constraint(constraint, syntax);
  if (!parsed) return null;
  let lowest: string | null = null;
  for (const clauses of parsed) {
    let highest: string | null = null;
    for (const clause of clauses) {
      if (!LOWER_BOUND_OPERATORS.has(clause.operator) || !isValidPep440(clause.version)) continue;
      if (highest === null || comparePep440(clause.version, highest) > 0) highest = clause.version;
    }
    if (highest === null) return null;
    if (lowest === null || comparePep440(highest, lowest) < 0) lowest = highest;
  }
  return lowest === null ? null : normalizePep440(lowest);
}

const ANCHOR_OPERATORS = new Set<ConstraintOperator>(["==", "=", "===", "~=", ">=", "^", "~"]);

/** Writes `target` with the precision (number of release segments) of `written`. */
function withPrecision(target: Pep440Version, targetRaw: string, written: string, minimum = 1): string {
  const writtenVersion = parsePep440(written);
  if (target.pre || target.post !== null || target.dev !== null || target.local) return normalizePep440(targetRaw);
  const precision = Math.max(minimum, writtenVersion?.release.length ?? target.release.length);
  const release = target.release.slice(0, precision);
  while (release.length < precision) release.push(0);
  return `${target.epoch ? `${target.epoch}!` : ""}${release.join(".")}`;
}

/**
 * Bumps a PEP 440 specifier / Poetry constraint so that it admits `target` while keeping its style:
 * `==1.2.3` → `==1.4.0`, `~=1.2` → `~=1.4`, `>=1.2` → `>=1.4`, `==1.*` → `==2.*`, Poetry `^1.2` → `^1.4`,
 * `>=1.2,<2` → `>=1.4,<2`. An upper bound or exclusion that rejects the target (`<2`, `!=…`) → `blocked`; a
 * constraint with no lower bound that already admits the target (`<3`, `*`) → `unchanged`.
 */
export function pep440BumpSpecifier(
  declared: string,
  target: string,
  syntax: "pep440" | "poetry" = "pep440",
): BumpResult {
  const parsed = parsePep440Constraint(declared, syntax);
  const targetVersion = parsePep440(target);
  if (!parsed || !targetVersion) return { outcome: "blocked" };
  if (parsed.length !== 1) return pep440Satisfies(target, parsed) ? { outcome: "unchanged" } : { outcome: "blocked" };
  const clauses = parsed[0] as ConstraintClause[];
  const anchors = clauses.filter((clause) => ANCHOR_OPERATORS.has(clause.operator));
  if (anchors.length === 0) return pep440Satisfies(target, parsed) ? { outcome: "unchanged" } : { outcome: "blocked" };

  let next = declared;
  // Replace from the end so earlier offsets stay valid.
  for (const clause of [...anchors].sort((a, b) => b.versionStart - a.versionStart)) {
    let replacement: string;
    if (clause.operator === "===") replacement = target;
    else if ((clause.operator === "==" || clause.operator === "=") && !clause.wildcard) replacement = target.trim();
    else if (clause.wildcard) {
      const precision = parsePep440(clause.version)?.release.length ?? 1;
      replacement = targetVersion.release.slice(0, precision).join(".");
      if (targetVersion.epoch) replacement = `${targetVersion.epoch}!${replacement}`;
    } else replacement = withPrecision(targetVersion, target, clause.version, clause.operator === "~=" ? 2 : 1);
    next = next.slice(0, clause.versionStart) + replacement + next.slice(clause.versionEnd);
  }
  if (!pep440Satisfies(target, next, syntax)) return { outcome: "blocked" };
  return next === declared ? { outcome: "unchanged" } : { outcome: "bumped", declared: next };
}

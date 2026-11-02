/**
 * "My version" (Slice 07): how far the version a user runs is behind the releases they can see.
 * Pure and shared by server and client code (no `@repopulse/db`, no `semver` dependency).
 *
 * The primary comparison is by stored row: the release or tag whose `tagName` is the user's version
 * anchors the comparison, and every visible `RELEASE` / `TAG` row published after it is "newer". When
 * no row matches (a version from before the stored history, or typed differently), versions are
 * compared as SemVer after normalization (`v1.2.3`, `release-1.2.3` and `pkg@1.2.3` all read as 1.2.3).
 */

export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  /** Pre-release identifiers (`1.2.3-rc.1` → `["rc", "1"]`); empty for a stable version. */
  prerelease: string[];
}

/** Matches the first `major[.minor[.patch]][-pre]` in a tag, after any prefix such as `v`, `release-` or `pkg@`. */
const VERSION_RE = /(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?/;

/** Normalizes a tag name to a version, or `null` when it holds no number at all. */
export function parseVersion(tagName: string): ParsedVersion | null {
  const trimmed = tagName.trim();
  // Scoped monorepo tags (`@scope/pkg@1.2.3`): the version follows the last `@`.
  const at = trimmed.lastIndexOf("@");
  const candidate = at > 0 ? trimmed.slice(at + 1) : trimmed;
  const match = VERSION_RE.exec(candidate);
  if (!match) return null;
  const toNumber = (value: string | undefined) => (value === undefined ? 0 : Number(value));
  const [major, minor, patch] = [toNumber(match[1]), toNumber(match[2]), toNumber(match[3])];
  if (![major, minor, patch].every(Number.isSafeInteger)) return null;
  return { major, minor, patch, prerelease: match[4] ? match[4].split(".").filter(Boolean) : [] };
}

function compareIdentifiers(a: string, b: string): number {
  const numericA = /^\d+$/.test(a);
  const numericB = /^\d+$/.test(b);
  if (numericA && numericB) return Math.sign(Number(a) - Number(b));
  if (numericA) return -1; // SemVer: numeric identifiers sort before alphanumeric ones.
  if (numericB) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** SemVer precedence of two tags: negative, 0 or positive, or `null` when either is not a version. */
export function compareVersions(a: string, b: string): number | null {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return null;
  for (const key of ["major", "minor", "patch"] as const) {
    if (left[key] !== right[key]) return Math.sign(left[key] - right[key]);
  }
  // A pre-release sorts before the stable version it leads to.
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    return left.prerelease.length === right.prerelease.length ? 0 : left.prerelease.length === 0 ? 1 : -1;
  }
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let i = 0; i < length; i++) {
    const x = left.prerelease[i];
    const y = right.prerelease[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const result = compareIdentifiers(x, y);
    if (result !== 0) return result;
  }
  return 0;
}

/**
 * Tag names that count as "the user's version": exactly what they typed, plus the same with or
 * without a leading `v` (`1.2.3` matches the tag `v1.2.3`).
 */
export function versionTagCandidates(currentVersion: string): string[] {
  const value = currentVersion.trim();
  if (!value) return [];
  const bare = /^v\d/i.test(value) ? value.slice(1) : value;
  return [...new Set([value, bare, `v${bare}`])];
}

export interface VersionRow {
  tagName: string;
  publishedAt: Date;
  semverType: string;
}

/** The stored row matching the user's version: an exact `tagName` first, then a `v`-prefix variant. */
export function findVersionRow<T extends VersionRow>(rows: readonly T[], currentVersion: string): T | null {
  const candidates = versionTagCandidates(currentVersion);
  for (const candidate of candidates) {
    const row = rows.find((r) => r.tagName === candidate);
    if (row) return row;
  }
  return null;
}

/**
 * Whether a release or tag is newer than the user's version. `anchorPublishedAt` is the publication
 * date of the stored row matching that version (`null` when none matches: SemVer comparison, and
 * a tag that is not a version is never "newer").
 */
export function isNewerThanVersion(
  candidate: { tagName: string; publishedAt: Date },
  currentVersion: string,
  anchorPublishedAt: Date | null,
): boolean {
  if (versionTagCandidates(currentVersion).includes(candidate.tagName)) return false;
  if (anchorPublishedAt) return candidate.publishedAt.getTime() > anchorPublishedAt.getTime();
  const result = compareVersions(candidate.tagName, currentVersion);
  return result !== null && result > 0;
}

export interface VersionStatus {
  /** Visible releases / tags newer than the user's version. */
  behind: number;
  /** How many of them are major releases. */
  major: number;
  /** A stored row matched the version (otherwise SemVer comparison was used). */
  matched: boolean;
}

/**
 * How far `currentVersion` is behind the visible `RELEASE` / `TAG` rows of one repository. `null`
 * when it cannot be compared: no row matches and the text is not a version.
 */
export function computeVersionStatus(rows: readonly VersionRow[], currentVersion: string | null): VersionStatus | null {
  if (!currentVersion?.trim()) return null;
  const anchor = findVersionRow(rows, currentVersion);
  if (!anchor && !parseVersion(currentVersion)) return null;
  const newer = rows.filter((row) => isNewerThanVersion(row, currentVersion, anchor?.publishedAt ?? null));
  return { behind: newer.length, major: newer.filter((row) => row.semverType === "MAJOR").length, matched: anchor !== null };
}

/** "Up to date", "1 release behind", "3 releases behind · 1 major". */
export function formatVersionStatus(status: VersionStatus): string {
  if (status.behind === 0) return "Up to date";
  const base = `${status.behind} release${status.behind === 1 ? "" : "s"} behind`;
  return status.major > 0 ? `${base} · ${status.major} major` : base;
}

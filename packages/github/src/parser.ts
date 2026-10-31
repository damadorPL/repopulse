import semver from "semver";

/** Mirrors the `SemverType` enum in `@repopulse/db` (kept local so this package has no Prisma dependency). */
export type SemverType = "MAJOR" | "MINOR" | "PATCH" | "PRERELEASE" | "OTHER";

export interface RepoRef {
  owner: string;
  name: string;
}

export class InvalidRepositoryInputError extends Error {
  readonly input: string;

  constructor(input: string, reason: string) {
    super(`Invalid repository "${input}": ${reason}. Use "owner/repo" or a https://github.com/owner/repo URL.`);
    this.name = "InvalidRepositoryInputError";
    this.input = input;
  }
}

const REPO_SLUG_RE = /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/;
const SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i;
const GITHUB_HOST_RE = /^(?:www\.)?github\.com$/i;
const SSH_RE = /^git@github\.com:(.+)$/i;

function stripSuffixes(path: string): string {
  return path.replace(/\/+$/, "").replace(/\.git$/i, "").replace(/\/+$/, "");
}

/**
 * Normalizes user input into `{ owner, name }`.
 *
 * Accepts `owner/repo`, `github.com/owner/repo(.git)`, `https://github.com/owner/repo/...`
 * (extra path segments such as `/releases` are ignored) and `git@github.com:owner/repo.git`.
 */
export function parseRepoInput(input: string): RepoRef {
  const raw = input.trim();
  if (!raw) {
    throw new InvalidRepositoryInputError(input, "input is empty");
  }

  let slug: string;
  const ssh = SSH_RE.exec(raw);

  if (ssh) {
    slug = stripSuffixes(ssh[1]!);
  } else if (SCHEME_RE.test(raw) || /^(?:www\.)?github\.com(?:\/|$)/i.test(raw)) {
    let url: URL;
    try {
      url = new URL(SCHEME_RE.test(raw) ? raw : `https://${raw}`);
    } catch {
      throw new InvalidRepositoryInputError(input, "not a valid URL");
    }
    if (!GITHUB_HOST_RE.test(url.hostname)) {
      throw new InvalidRepositoryInputError(input, "only github.com repositories are supported");
    }
    const [owner, name] = url.pathname.split("/").filter(Boolean);
    if (!owner || !name) {
      throw new InvalidRepositoryInputError(input, "URL must include both owner and repository");
    }
    slug = `${owner}/${stripSuffixes(name)}`;
  } else {
    slug = stripSuffixes(raw);
  }

  if (!REPO_SLUG_RE.test(slug)) {
    throw new InvalidRepositoryInputError(input, "expected the form owner/repo");
  }
  const [owner, name] = slug.split("/") as [string, string];
  if (owner === "." || owner === ".." || name === "." || name === "..") {
    throw new InvalidRepositoryInputError(input, "owner and repository cannot be '.' or '..'");
  }
  return { owner, name };
}

/**
 * Parses a release tag into a SemVer. Strict-ish parse first (`v1.2.3-rc.1`), then
 * coercion for prefixed tags (`release-1.2.3`, `coolify@4.0.0-beta.380`).
 */
function parseTagVersion(tagName: string): semver.SemVer | null {
  const cleaned = semver.clean(tagName, { loose: true });
  if (cleaned) {
    return semver.parse(cleaned, { loose: true });
  }
  return semver.coerce(tagName, { includePrerelease: true });
}

/** Classifies a release tag as a MAJOR / MINOR / PATCH / PRERELEASE / OTHER bump. */
export function classifySemver(tagName: string, isPrereleaseFlag: boolean): SemverType {
  if (isPrereleaseFlag) {
    return "PRERELEASE";
  }
  const version = parseTagVersion(tagName);
  if (!version) {
    return "OTHER";
  }
  if ((semver.prerelease(version)?.length ?? 0) > 0) {
    return "PRERELEASE";
  }
  const { major, minor, patch } = version;
  if (major === 0 && minor === 0 && patch === 0) {
    return "OTHER";
  }
  if (minor === 0 && patch === 0) {
    return "MAJOR";
  }
  if (patch === 0) {
    return "MINOR";
  }
  if (patch > 0) {
    return "PATCH";
  }
  return "OTHER";
}

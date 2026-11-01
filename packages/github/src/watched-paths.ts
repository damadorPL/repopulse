/**
 * Watched path helpers ("Files / folders" tracking, Slice 06). Pure and browser-safe (no Octokit),
 * so client forms import them through `@repopulse/github/watched-paths`.
 */

/** Paths a single subscription can watch. */
export const MAX_WATCHED_PATHS = 10;
/** Longest accepted repo-relative path. */
export const MAX_WATCHED_PATH_LENGTH = 240;

// Control characters (C0, DEL, C1), backslashes, and URL query/fragment markers.
// eslint-disable-next-line no-control-regex
const FORBIDDEN_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\\?#]/;

/**
 * Normalizes a repo-relative file or folder path: trims whitespace, strips a leading `/` or `./`
 * and trailing `/`, and collapses repeated `/`. Returns `null` for anything that is not a plain
 * repo-relative path: empty, `.`/`..` segments, `\`, `?`, `#`, control characters, or longer than
 * {@link MAX_WATCHED_PATH_LENGTH}.
 */
export function normalizeWatchedPath(raw: string): string | null {
  const trimmed = raw.trim();
  if (FORBIDDEN_CHARACTERS.test(trimmed)) return null;
  let path = trimmed.replace(/\/{2,}/g, "/");
  while (path.startsWith("./")) path = path.slice(2);
  path = path.replace(/^\/+/, "").replace(/\/+$/, "");
  if (path === "" || path.length > MAX_WATCHED_PATH_LENGTH) return null;
  if (path.split("/").some((segment) => segment === "." || segment === "..")) return null;
  return path;
}

export interface ParsedWatchedPaths {
  /** Normalized, deduplicated, in input order, at most {@link MAX_WATCHED_PATHS}. */
  paths: string[];
  /** Entries that could not be normalized (trimmed, as typed). */
  invalid: string[];
  /** More than {@link MAX_WATCHED_PATHS} distinct valid paths were given (the rest were dropped). */
  tooMany: boolean;
}

/**
 * Parses watched paths from a text field (newline- or comma-separated) or a list. Blank entries
 * are ignored; duplicates (after normalization) are kept once, in input order.
 */
export function parseWatchedPaths(input: string | readonly string[]): ParsedWatchedPaths {
  const entries = typeof input === "string" ? input.split(/[\n,]/) : input.flatMap((entry) => entry.split(/[\n,]/));
  const paths: string[] = [];
  const invalid: string[] = [];
  let tooMany = false;
  for (const entry of entries) {
    if (entry.trim() === "") continue;
    const path = normalizeWatchedPath(entry);
    if (path === null) {
      invalid.push(entry.trim());
      continue;
    }
    if (paths.includes(path)) continue;
    if (paths.length === MAX_WATCHED_PATHS) {
      tooMany = true;
      continue;
    }
    paths.push(path);
  }
  return { paths, invalid, tooMany };
}

/** Whether a changed file path is the watched path itself or inside the watched folder. */
export function commitMatchesPath(changedPath: string, watchedPath: string): boolean {
  return changedPath === watchedPath || changedPath.startsWith(`${watchedPath}/`);
}

/** Whether any changed path matches any watched path. */
export function commitMatchesAnyPath(changedPaths: readonly string[], watchedPaths: readonly string[]): boolean {
  return changedPaths.some((changed) => watchedPaths.some((watched) => commitMatchesPath(changed, watched)));
}

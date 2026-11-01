import { commitMatchesAnyPath, MAX_WATCHED_PATHS, normalizeWatchedPath, parseWatchedPaths } from "@repopulse/github/watched-paths";

/**
 * Watched path helpers ("Files / folders" tracking) shared by Server Actions and client forms.
 * Parsing and matching come from `@repopulse/github/watched-paths` (browser-safe), so the form,
 * the action and the worker agree on what a valid path is.
 */

export { commitMatchesAnyPath, MAX_WATCHED_PATHS, normalizeWatchedPath };

export const WATCHED_PATHS_PLACEHOLDER = "CHANGELOG.md, packages/cli";

export type WatchedPathsValidation = { ok: true; paths: string[] } | { ok: false; message: string };

/**
 * Validates watched paths typed by the user (comma- or newline-separated) or sent by a form.
 * Returns the normalized paths, or a message saying what to fix.
 */
export function validateWatchedPaths(input: string | readonly string[]): WatchedPathsValidation {
  const { paths, invalid, tooMany } = parseWatchedPaths(input);
  if (invalid.length > 0) {
    const shown = invalid[0]!.length > 60 ? `${invalid[0]!.slice(0, 59)}…` : invalid[0]!;
    return { ok: false, message: `"${shown}" is not a valid path. Use a path relative to the repository root, like packages/cli.` };
  }
  if (tooMany) return { ok: false, message: `Watch at most ${MAX_WATCHED_PATHS} paths.` };
  if (paths.length === 0) return { ok: false, message: "Enter at least one file or folder path." };
  return { ok: true, paths };
}

/** Short label for a repository card: `CHANGELOG.md`, `CHANGELOG.md, docs`, `CHANGELOG.md +2 more`. */
export function summarizeWatchedPaths(paths: readonly string[]): string {
  if (paths.length <= 2) return paths.join(", ");
  return `${paths[0]} +${paths.length - 1} more`;
}

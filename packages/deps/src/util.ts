/** Small helpers shared by the parsers. Pure and browser-safe. */

/** PEP 503 name normalization: lowercase, runs of `-`, `_`, `.` become one `-`. */
export function normalizePypiName(name: string): string {
  return name.trim().toLowerCase().replace(/[-_.]+/g, "-");
}

/** UTF-8 byte length without allocating (`Buffer` is not available in every consumer). */
export function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4;
      i++;
    } else bytes += 3;
  }
  return bytes;
}

/** Directory part of a repo-relative path: `"a/b/c.json"` → `"a/b"`, `"c.json"` → `""`. */
export function dirname(path: string): string {
  const index = path.lastIndexOf("/");
  return index === -1 ? "" : path.slice(0, index);
}

/** File name part of a repo-relative path. */
export function basename(path: string): string {
  const index = path.lastIndexOf("/");
  return index === -1 ? path : path.slice(index + 1);
}

/** Joins repo-relative path parts, dropping empty ones. */
export function joinPath(...parts: string[]): string {
  return parts.filter((part) => part !== "").join("/");
}

/**
 * Resolves `relative` against directory `dir` (both repo-relative, POSIX). Returns `null` when the result escapes
 * the repository root or is absolute.
 */
export function resolveRelativePath(dir: string, relative: string): string | null {
  if (relative.startsWith("/") || /^[A-Za-z]:/.test(relative) || relative.includes("\\") || relative.includes("\0")) {
    return null;
  }
  const segments = dir === "" ? [] : dir.split("/");
  for (const segment of relative.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) return null;
      segments.pop();
    } else segments.push(segment);
  }
  return segments.length === 0 ? null : segments.join("/");
}

/** `true` when `ancestor` (a directory, `""` = root) contains `path`. */
export function isWithinDir(path: string, ancestor: string): boolean {
  return ancestor === "" || path === ancestor || path.startsWith(`${ancestor}/`);
}

/** Path of `path` relative to directory `from` (which must contain it). `""` when equal. */
export function relativeTo(path: string, from: string): string {
  if (from === "") return path;
  if (path === from) return "";
  return path.slice(from.length + 1);
}

/**
 * Minimal workspace glob → RegExp (npm / pnpm / Bun / uv `workspaces` entries): `*` = one segment, `**` = any
 * depth, `?` = one character. A trailing `/` is ignored.
 */
export function workspaceGlobToRegExp(glob: string): RegExp {
  let pattern = glob.trim().replace(/^\.\//, "").replace(/\/+$/, "");
  if (pattern === "" || pattern === ".") return /^$/;
  pattern = pattern.replace(/\/\*\*$/, "/**");
  let source = "";
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i] as string;
    if (char === "*") {
      if (pattern[i + 1] === "*") {
        // `**/` matches zero or more directories.
        if (pattern[i + 2] === "/") {
          source += "(?:[^/]+/)*";
          i += 2;
        } else {
          source += ".*";
          i += 1;
        }
      } else source += "[^/]*";
    } else if (char === "?") source += "[^/]";
    else source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`);
}

/** `true` when directory `dir` matches the workspace globs (with `!` negations, evaluated in order). */
export function matchesWorkspaceGlobs(dir: string, globs: readonly string[]): boolean {
  let matched = false;
  for (const glob of globs) {
    if (glob.startsWith("!")) {
      if (matched && workspaceGlobToRegExp(glob.slice(1)).test(dir)) matched = false;
    } else if (!matched && workspaceGlobToRegExp(glob).test(dir)) matched = true;
  }
  return matched;
}

/** Strips a UTF-8 BOM. Returns the offset shift (0 or 1) so spans can be mapped back. */
export function stripBom(text: string): { text: string; offset: number } {
  return text.charCodeAt(0) === 0xfeff ? { text: text.slice(1), offset: 1 } : { text, offset: 0 };
}

/** Structural deep equality for JSON / TOML values (TOML dates compare by string form). */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== "object") {
    return Number.isNaN(a) && Number.isNaN(b);
  }
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (a instanceof Date || b instanceof Date) return String(a) === String(b);
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => deepEqual(item, b[index]));
  }
  const aRecord = a as Record<string, unknown>;
  const bRecord = b as Record<string, unknown>;
  const aKeys = Object.keys(aRecord);
  const bKeys = Object.keys(bRecord);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((key) => Object.prototype.hasOwnProperty.call(bRecord, key) && deepEqual(aRecord[key], bRecord[key]));
}

/** `true` for a plain object (not an array, not null). */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Line ending used by a text (`"\r\n"` when it appears before any bare `"\n"`). */
export function detectLineEnding(text: string): "\n" | "\r\n" {
  const index = text.indexOf("\n");
  return index > 0 && text[index - 1] === "\r" ? "\r\n" : "\n";
}

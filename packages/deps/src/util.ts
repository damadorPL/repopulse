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
 * depth, `?` = one character. A trailing `/` is ignored. Uses segment-based dynamic programming and linear
 * intra-segment wildcard matching so untrusted globs cannot trigger superlinear regex backtracking.
 */
export function workspaceGlobToRegExp(glob: string): RegExp {
  let pattern = glob.trim().replace(/^\.\//, "").replace(/\/+$/, "");
  if (pattern === "" || pattern === ".") return /^$/;
  if (pattern.length > 512) return /^(?!)$/;
  pattern = pattern.replace(/\/+/g, "/");
  // Fast real RegExp for simple patterns (at most one `**` or a couple of `*`s).
  if ((pattern.match(/\*\*/g)?.length ?? 0) <= 1 && (pattern.match(/\*/g)?.length ?? 0) <= 3) {
    let source = "";
    for (let i = 0; i < pattern.length; i++) {
      const char = pattern[i] as string;
      if (char === "*") {
        if (pattern[i + 1] === "*") {
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
  const rawSegs = pattern.split("/");
  const patSegs: RegExp[] = [];
  const isGlobstar: boolean[] = [];
  for (let i = 0; i < rawSegs.length; i++) {
    const seg = rawSegs[i]!;
    if (seg === "**") {
      if (isGlobstar.length > 0 && isGlobstar[isGlobstar.length - 1]) continue;
      if (i === rawSegs.length - 1 && rawSegs.length > 1) {
        patSegs.push(/^[^/]+$/);
        isGlobstar.push(false);
      }
      patSegs.push(/^.*$/);
      isGlobstar.push(true);
    } else {
      patSegs.push(segmentToRegExp(seg));
      isGlobstar.push(false);
    }
  }
  const fake = new RegExp("^$");
  fake.test = (dir: string): boolean => {
    if (dir === "") return false;
    return matchGlobSegments(dir.split("/"), patSegs, isGlobstar);
  };
  return fake;
}

function matchGlobSegments(
  dirSegs: readonly string[],
  patSegs: readonly RegExp[],
  isGlobstar: readonly boolean[],
): boolean {
  const n = dirSegs.length;
  const m = patSegs.length;
  let dp = new Uint8Array(n + 1);
  dp[0] = 1;
  for (let j = 0; j < m; j++) {
    const next = new Uint8Array(n + 1);
    if (isGlobstar[j]) {
      let seen = 0;
      for (let i = 0; i <= n; i++) {
        if (dp[i]) seen = 1;
        next[i] = seen;
      }
    } else {
      const re = patSegs[j]!;
      for (let i = 0; i < n; i++) {
        if (dp[i] && re.test(dirSegs[i]!)) {
          next[i + 1] = 1;
        }
      }
    }
    dp = next;
  }
  return dp[n] === 1;
}

function segmentToRegExp(seg: string): RegExp {
  // Collapse consecutive `*` inside a single path segment and use linear segment matching when multiple `*` exist.
  const collapsed = seg.replace(/\*+/g, "*");
  const parts = collapsed.split("*");
  if (parts.length === 1) {
    const src = parts[0]!.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\?/g, "[^/]");
    return new RegExp(`^${src}$`);
  }
  // Linear scan across `*`-separated subparts within a single segment (no backtracking).
  const partRegexes = parts.map((p) => new RegExp(p.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\?/g, "[^/]"), "y"));
  return {
    test(input: string): boolean {
      // First part must match at start (pos = 0).
      const first = partRegexes[0]!;
      first.lastIndex = 0;
      if (!first.test(input)) return false;
      let pos = first.lastIndex;

      // Last part must match at the end; check intermediate parts greedily from left to right.
      for (let k = 1; k < partRegexes.length - 1; k++) {
        const sub = partRegexes[k]!;
        let found = false;
        while (pos <= input.length) {
          sub.lastIndex = pos;
          if (sub.test(input)) {
            pos = sub.lastIndex;
            found = true;
            break;
          }
          pos++;
        }
        if (!found) return false;
      }

      const lastPart = parts[parts.length - 1]!;
      if (lastPart === "") return true;
      const last = partRegexes[partRegexes.length - 1]!;
      // Count character length of lastPart (each `?` or literal is 1 char).
      const endStart = input.length - lastPart.length;
      if (endStart < pos) return false;
      last.lastIndex = endStart;
      return last.test(input) && last.lastIndex === input.length;
    },
  } as RegExp;
}

function matchesSingleWorkspaceGlob(dir: string, glob: string): boolean {
  let pattern = glob.trim().replace(/^\.\//, "").replace(/\/+$/, "");
  if (pattern === "" || pattern === ".") return dir === "";
  if (pattern.length > 512) return false;
  pattern = pattern.replace(/\/+/g, "/");
  if (!pattern.includes("**") && (pattern.match(/\*/g)?.length ?? 0) <= 2) {
    return workspaceGlobToRegExp(pattern).test(dir);
  }
  const dirSegs = dir === "" ? [] : dir.split("/");
  const rawSegs = pattern.split("/");
  const patSegs: RegExp[] = [];
  const isGlobstar: boolean[] = [];
  for (let i = 0; i < rawSegs.length; i++) {
    const seg = rawSegs[i]!;
    if (seg === "**") {
      if (isGlobstar.length > 0 && isGlobstar[isGlobstar.length - 1]) continue;
      // Trailing `/**` in `packages/**` requires at least one child segment under `packages`.
      if (i === rawSegs.length - 1 && rawSegs.length > 1) {
        patSegs.push(/^[^/]+$/);
        isGlobstar.push(false);
      }
      patSegs.push(/^.*$/);
      isGlobstar.push(true);
    } else if (seg.includes("**")) {
      // Inline `**` within a segment (e.g. `a**b`): treat as single-segment wildcard if no slash, or DP across segments.
      patSegs.push(segmentToRegExp(seg));
      isGlobstar.push(false);
    } else {
      patSegs.push(segmentToRegExp(seg));
      isGlobstar.push(false);
    }
  }
  return matchGlobSegments(dirSegs, patSegs, isGlobstar);
}

/** `true` when directory `dir` matches the workspace globs (with `!` negations, evaluated in order). */
export function matchesWorkspaceGlobs(dir: string, globs: readonly string[]): boolean {
  let matched = false;
  for (const glob of globs) {
    if (glob.startsWith("!")) {
      if (matched && matchesSingleWorkspaceGlob(dir, glob.slice(1))) matched = false;
    } else if (!matched && matchesSingleWorkspaceGlob(dir, glob)) matched = true;
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

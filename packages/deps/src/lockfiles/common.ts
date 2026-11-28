/** Shared result type and guards of the lockfile readers. */
import { MAX_LOCKFILE_BYTES } from "../limits.js";
import { utf8ByteLength } from "../util.js";

export interface LockfileVersions {
  /** Direct dependency name (npm name / PEP 503-normalized PyPI name) → resolved version. */
  versions: Map<string, string>;
  /**
   * Format version of the file, compared by the worker before / after the sandbox: npm `lockfileVersion`
   * (`"3"`), pnpm `lockfileVersion` (`"9.0"`), Bun `lockfileVersion` (`"1"`), uv `"1/2"` (`version/revision`),
   * Poetry `lock-version` (`"2.1"`), Yarn `"classic"` or the Berry `__metadata.version` (`"berry/8"`).
   */
  formatVersion: string | null;
  /** Oversize file or parse failure: the scan goes on with declared ranges. */
  warnings: string[];
}

export interface PreparedLockfile {
  readFor(importer: string, dependencies: ReadonlyArray<{ name: string; declared: string }>): LockfileVersions;
}

export function emptyLockfile(warning?: string): LockfileVersions {
  return { versions: new Map(), formatVersion: null, warnings: warning ? [warning] : [] };
}

/** A warning when the lockfile exceeds {@link MAX_LOCKFILE_BYTES}, else `null`. */
export function oversizeWarning(text: string, path: string): string | null {
  // Cheap check first: every UTF-16 unit is at most 3 bytes.
  if (text.length <= MAX_LOCKFILE_BYTES / 3) return null;
  return utf8ByteLength(text) > MAX_LOCKFILE_BYTES
    ? `${path} is larger than ${MAX_LOCKFILE_BYTES / 1024 / 1024} MiB: current versions are taken from the declared ranges`
    : null;
}

function parseFailureWarning(path: string, error: unknown): string {
  const detail = error instanceof Error ? error.message.split("\n")[0] : String(error);
  return `${path} could not be parsed (${detail}): current versions are taken from the declared ranges`;
}

/** Runs a lockfile parser once with the size guard and turns any failure into an empty PreparedLockfile + warning. */
export function guardPrepareLockfile(text: string, path: string, prepare: () => PreparedLockfile): PreparedLockfile {
  const oversize = oversizeWarning(text, path);
  if (oversize) return { readFor: () => emptyLockfile(oversize) };
  try {
    return prepare();
  } catch (error) {
    const warning = parseFailureWarning(path, error);
    return { readFor: () => emptyLockfile(warning) };
  }
}

/** Formats a scalar lockfile version field, returning `null` for missing or non-scalar values. */
export function formatLockfileVersion(value: unknown): string | null {
  return typeof value === "string" || typeof value === "number" ? String(value) : null;
}

/** Splits `"name@version"` (scoped names keep their leading `@`). */
export function splitNameAtVersion(ident: string): { name: string; version: string } | null {
  const at = ident.lastIndexOf("@");
  if (at <= 0) return null;
  return { name: ident.slice(0, at), version: ident.slice(at + 1) };
}

/** Shared types and helpers of the manifest rewriters (span edits + structural re-parse check). */
import type { DependencyKind, TextSpan } from "../types.js";

/** One planned change of a declared spec. */
export interface ManifestEdit {
  /** npm name, or any spelling of the PyPI name (compared normalized). */
  name: string;
  kind: DependencyKind;
  /** `""` = none (requirements files always use `""`). */
  group: string;
  /** The declared spec the plan was computed from (stale-file guard). */
  from: string;
  /** The new declared spec. */
  to: string;
  /**
   * requirements only: sha256 digests (hex, or `sha256:<hex>`) of **every** file of the target version. Required
   * when the line has `--hash` options.
   */
  hashes?: readonly string[];
}

export type RewriteErrorCode =
  /** No dependency with that name / kind / group in the file. */
  | "NOT_FOUND"
  /** The file's declared spec differs from `from` (the file changed since the plan). */
  | "STALE"
  /** The value has no usable span (escapes, continuation inside the spec, unsupported layout). */
  | "NOT_REWRITABLE"
  /** The new spec contains characters that would change the file structure. */
  | "INVALID_VALUE"
  /** A hashed requirement without the target's hashes. */
  | "HASHES_REQUIRED"
  /** The re-parse shows a change outside the plan. */
  | "VERIFY_FAILED";

/** Aborts the update job: the bot writes only what it planned. */
export class ManifestRewriteError extends Error {
  constructor(
    readonly code: RewriteErrorCode,
    readonly path: string,
    message: string,
  ) {
    super(`${path}: ${message}`);
    this.name = "ManifestRewriteError";
  }
}

export function isManifestRewriteError(error: unknown): error is ManifestRewriteError {
  return error instanceof ManifestRewriteError;
}

export interface SpanReplacement {
  span: TextSpan;
  text: string;
}

/** Applies non-overlapping replacements (any order). Throws on overlap. */
export function applyReplacements(text: string, replacements: readonly SpanReplacement[], path: string): string {
  const sorted = [...replacements].sort((a, b) => b.span.start - a.span.start);
  let out = text;
  let previousStart = Number.POSITIVE_INFINITY;
  for (const replacement of sorted) {
    if (replacement.span.end > previousStart) {
      throw new ManifestRewriteError("VERIFY_FAILED", path, "overlapping edits");
    }
    out = out.slice(0, replacement.span.start) + replacement.text + out.slice(replacement.span.end);
    previousStart = replacement.span.start;
  }
  return out;
}

/** Rejects specs that could break out of a string / line. */
export function assertSafeSpec(value: string, path: string, forbidden: RegExp): void {
  // eslint-disable-next-line no-control-regex -- reject control characters in version specs.
  if (value.trim() === "" || forbidden.test(value) || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new ManifestRewriteError("INVALID_VALUE", path, `unsafe version spec ${JSON.stringify(value)}`);
  }
}

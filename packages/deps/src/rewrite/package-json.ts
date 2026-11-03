/** `package.json` rewrite: span edits of dependency values, then a structural comparison with the plan. */
import { packageJsonSectionOf, parsePackageJson } from "../manifests/package-json.js";
import { deepEqual, isRecord } from "../util.js";
import { applyReplacements, assertSafeSpec, ManifestRewriteError, type ManifestEdit, type SpanReplacement } from "./common.js";

/**
 * Applies `edits` to a `package.json`. Only the value strings change, so formatting, key order, line endings and
 * the trailing newline are kept. Throws {@link ManifestRewriteError} when a dependency is missing or stale, or when
 * the re-parsed document differs from the original in anything but the planned values.
 */
export function rewritePackageJson(text: string, edits: readonly ManifestEdit[], path = "package.json"): string {
  const manifest = parsePackageJson(text, path);
  const replacements: SpanReplacement[] = [];
  for (const edit of edits) {
    assertSafeSpec(edit.to, path, /["\\]/);
    const dependency = manifest.dependencies.find(
      (candidate) => candidate.name === edit.name && candidate.kind === edit.kind && candidate.group === "",
    );
    if (!dependency) throw new ManifestRewriteError("NOT_FOUND", path, `${edit.name} (${edit.kind}) not found`);
    if (dependency.declared !== edit.from) {
      throw new ManifestRewriteError("STALE", path, `${edit.name} is "${dependency.declared}", expected "${edit.from}"`);
    }
    if (!dependency.span) throw new ManifestRewriteError("NOT_REWRITABLE", path, `${edit.name} cannot be rewritten`);
    replacements.push({ span: dependency.span, text: edit.to });
  }
  const next = applyReplacements(text, replacements, path);

  // Structural check: the original document with the planned values must equal the new one.
  const strip = (value: string): string => (value.charCodeAt(0) === 0xfeff ? value.slice(1) : value);
  const expected: unknown = JSON.parse(strip(text));
  let actual: unknown;
  try {
    actual = JSON.parse(strip(next));
  } catch {
    throw new ManifestRewriteError("VERIFY_FAILED", path, "the rewritten file is not valid JSON");
  }
  for (const edit of edits) {
    const section = packageJsonSectionOf(edit.kind);
    const table = isRecord(expected) && section ? expected[section] : undefined;
    if (isRecord(table)) table[edit.name] = edit.to;
  }
  if (!deepEqual(expected, actual)) {
    throw new ManifestRewriteError("VERIFY_FAILED", path, "the rewritten file differs from the plan");
  }
  return next;
}

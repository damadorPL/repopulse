/** `pyproject.toml` rewrite: span edits inside the located strings, then a full TOML structural comparison. */
import { parse as parseToml } from "smol-toml";
import { parsePyproject } from "../manifests/pyproject.js";
import { deepEqual, isRecord, normalizePypiName } from "../util.js";
import { applyReplacements, assertSafeSpec, ManifestRewriteError, type ManifestEdit, type SpanReplacement } from "./common.js";

function setAtPath(root: unknown, path: ReadonlyArray<string | number>, update: (value: string) => string): boolean {
  let node: unknown = root;
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i] as string | number;
    if (Array.isArray(node) && typeof key === "number") node = node[key];
    else if (isRecord(node) && typeof key === "string") node = node[key];
    else return false;
  }
  const last = path.at(-1);
  if (Array.isArray(node) && typeof last === "number" && typeof node[last] === "string") {
    node[last] = update(node[last] as string);
    return true;
  }
  if (isRecord(node) && typeof last === "string" && typeof node[last] === "string") {
    node[last] = update(node[last] as string);
    return true;
  }
  return false;
}

/**
 * Applies `edits` to a `pyproject.toml` (PEP 621 / PEP 735 / uv / Poetry tables). Every dependency matching name
 * (normalized), kind, group and `from` is changed. Throws {@link ManifestRewriteError} when one is missing, stale
 * or not rewritable, or when the re-parsed TOML differs from the original in anything but the planned specs.
 */
export function rewritePyproject(text: string, edits: readonly ManifestEdit[], path = "pyproject.toml"): string {
  const manifest = parsePyproject(text, path);
  const replacements: SpanReplacement[] = [];
  const planned: Array<{ valuePath: Array<string | number>; start: number; end: number; to: string }> = [];
  for (const edit of edits) {
    assertSafeSpec(edit.to, path, /["'\\\n\r]/);
    const name = normalizePypiName(edit.name);
    const byKey = manifest.dependencies.filter(
      (dependency) => dependency.name === name && dependency.kind === edit.kind && dependency.group === edit.group,
    );
    if (byKey.length === 0) throw new ManifestRewriteError("NOT_FOUND", path, `${edit.name} (${edit.kind}${edit.group ? `/${edit.group}` : ""}) not found`);
    const matching = byKey.filter((dependency) => dependency.declared === edit.from && dependency.supported);
    if (matching.length === 0) {
      throw new ManifestRewriteError("STALE", path, `${edit.name} is "${byKey[0]?.declared}", expected "${edit.from}"`);
    }
    for (const dependency of matching) {
      if (!dependency.span) throw new ManifestRewriteError("NOT_REWRITABLE", path, `${edit.name} cannot be rewritten`);
      replacements.push({ span: dependency.span, text: edit.to });
      planned.push({ valuePath: dependency.valuePath, ...dependency.valueOffset, to: edit.to });
    }
  }
  const next = applyReplacements(text, replacements, path);

  const strip = (value: string): string => (value.charCodeAt(0) === 0xfeff ? value.slice(1) : value);
  const expected = parseToml(strip(text));
  let actual: unknown;
  try {
    actual = parseToml(strip(next));
  } catch {
    throw new ManifestRewriteError("VERIFY_FAILED", path, "the rewritten file is not valid TOML");
  }
  // Several edits may touch one string only through distinct dependencies; apply right-to-left per string.
  for (const change of [...planned].sort((a, b) => b.start - a.start)) {
    const applied = setAtPath(expected, change.valuePath, (value) => value.slice(0, change.start) + change.to + value.slice(change.end));
    if (!applied) throw new ManifestRewriteError("VERIFY_FAILED", path, `value at ${change.valuePath.join(".")} not found`);
  }
  if (!deepEqual(expected, actual)) {
    throw new ManifestRewriteError("VERIFY_FAILED", path, "the rewritten file differs from the plan");
  }
  return next;
}

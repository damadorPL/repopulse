/**
 * requirements file rewrite: span edits of specifiers and, for hashed lines, the `--hash` set replaced with the
 * sha256 of every file of the target version, keeping the continuation layout (Slice 08 §3.9 step 4).
 */
import { parseRequirements, type RequirementDependency } from "../manifests/requirements.js";
import { normalizePypiName } from "../util.js";
import { applyReplacements, assertSafeSpec, ManifestRewriteError, type ManifestEdit, type SpanReplacement } from "./common.js";

/** `"ABC…"` / `"sha256:abc…"` → `"sha256:abc…"`, unique and sorted (what `pip-compile --generate-hashes` emits). */
export function normalizeSha256Hashes(hashes: readonly string[]): string[] {
  const out = new Set<string>();
  for (const hash of hashes) {
    const digest = hash.trim().toLowerCase().replace(/^sha256:/, "");
    if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error(`invalid sha256 digest ${JSON.stringify(hash)}`);
    out.add(`sha256:${digest}`);
  }
  return [...out].sort();
}

/** Builds the replacement of a line's `--hash` block, keeping the option style and the separator layout. */
function hashBlock(text: string, dependency: RequirementDependency, hashes: string[]): SpanReplacement {
  const first = dependency.hashes[0];
  const last = dependency.hashes.at(-1);
  if (!first || !last) throw new Error("no hashes");
  let separator: string;
  const second = dependency.hashes[1];
  if (second) separator = text.slice(first.span.end, second.span.start);
  else {
    let start = first.span.start;
    while (start > 0 && /[ \t\\\r\n]/.test(text[start - 1] as string)) start--;
    separator = text.slice(start, first.span.start) || " ";
  }
  const optionText = text.slice(first.span.start, first.span.end);
  const prefix = /^--hash(?:=|\s+)/.exec(optionText)?.[0] ?? "--hash=";
  return { span: { start: first.span.start, end: last.span.end }, text: hashes.map((hash) => `${prefix}${hash}`).join(separator) };
}

/**
 * Applies `edits` to one requirements file (`kind`/`group` are ignored: every requirement is `PROD`). All lines of
 * the named requirement whose spec equals `from` are changed. Throws {@link ManifestRewriteError} when a
 * requirement is missing or stale, a hashed line gets no hashes, or the re-parse shows any other change.
 */
export function rewriteRequirements(text: string, edits: readonly ManifestEdit[], path = "requirements.txt"): string {
  const parsed = parseRequirements(text, path);
  const replacements: SpanReplacement[] = [];
  const planned = new Map<number, { to: string; hashes: string[] | null }>();

  for (const edit of edits) {
    assertSafeSpec(edit.to, path, /[#;\\\n\r]|\s--/);
    const name = normalizePypiName(edit.name);
    const byName = parsed.dependencies.filter((dependency) => dependency.name === name && dependency.supported);
    if (byName.length === 0) throw new ManifestRewriteError("NOT_FOUND", path, `${edit.name} not found`);
    const matching = byName.filter((dependency) => dependency.declared === edit.from);
    if (matching.length === 0) {
      throw new ManifestRewriteError("STALE", path, `${edit.name} is "${byName[0]?.declared}", expected "${edit.from}"`);
    }
    for (const dependency of matching) {
      if (!dependency.span || dependency.span.end === dependency.span.start) {
        throw new ManifestRewriteError("NOT_REWRITABLE", path, `${edit.name} (line ${dependency.line}) cannot be rewritten`);
      }
      replacements.push({ span: dependency.span, text: edit.to });
      let hashes: string[] | null = null;
      if (dependency.hashes.length > 0) {
        if (!edit.hashes || edit.hashes.length === 0) {
          throw new ManifestRewriteError("HASHES_REQUIRED", path, `${edit.name} (line ${dependency.line}) needs the target's hashes`);
        }
        try {
          hashes = normalizeSha256Hashes(edit.hashes);
        } catch (error) {
          throw new ManifestRewriteError("INVALID_VALUE", path, error instanceof Error ? error.message : String(error));
        }
        replacements.push(hashBlock(text, dependency, hashes));
      }
      planned.set(parsed.dependencies.indexOf(dependency), { to: edit.to, hashes });
    }
  }

  const next = applyReplacements(text, replacements, path);
  const reparsed = parseRequirements(next, path);
  const fail = (detail: string): never => {
    throw new ManifestRewriteError("VERIFY_FAILED", path, `the rewritten file differs from the plan (${detail})`);
  };
  if (reparsed.dependencies.length !== parsed.dependencies.length) fail("requirement count");
  if (JSON.stringify(reparsed.includes) !== JSON.stringify(parsed.includes)) fail("includes");
  if (reparsed.indexUrl !== parsed.indexUrl || reparsed.extraIndexUrls.join() !== parsed.extraIndexUrls.join()) fail("index");
  parsed.dependencies.forEach((before, index) => {
    const after = reparsed.dependencies[index] as RequirementDependency;
    if (after.name !== before.name || after.marker !== before.marker || after.extras.join() !== before.extras.join()) {
      fail(`line ${before.line}`);
    }
    const plan = planned.get(index);
    const expectedDeclared = plan ? plan.to : before.declared;
    const expectedHashes = plan?.hashes ?? before.hashes.map((hash) => hash.value);
    if (after.declared !== expectedDeclared) fail(`${before.rawName} spec`);
    if (after.hashes.map((hash) => hash.value).join() !== expectedHashes.join()) fail(`${before.rawName} hashes`);
  });
  return next;
}

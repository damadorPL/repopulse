/** `pnpm-lock.yaml` reader (v6 – v9 importer layout, plus the older `specifiers` layout and pnpm 11+ multi-document streams). */
import { parseAllDocuments } from "yaml";
import { isRecord } from "../util.js";
import { guardLockfile, type LockfileVersions } from "./common.js";

const DEPENDENCY_KEYS = ["dependencies", "devDependencies", "optionalDependencies"] as const;
const MAX_PNPM_LOCK_DOCUMENTS = 10;
const MAX_ALIAS_COUNT = 100;

/** `1.2.3(react@18.2.0)` / `1.2.3_react@18.2.0` → `1.2.3`; `link:` / `file:` → `null`. */
export function stripPnpmVersionSuffix(version: string): string | null {
  if (/^(?:link|file|workspace|git|https?):/.test(version)) return null;
  const withoutPeers = version.replace(/\(.*$/, "");
  const underscore = withoutPeers.indexOf("_");
  return underscore === -1 ? withoutPeers : withoutPeers.slice(0, underscore);
}

/**
 * Resolved versions of the direct dependencies of `importer` (path relative to the lockfile directory; `"."` or
 * `""` = root). Lockfiles without `importers` (single project, pnpm < 7) are read from the top level.
 * Multi-document lockfiles (pnpm 11+ boot/env doc followed by the project lockfile) read the final document.
 */
export function readPnpmLock(text: string, importer = ".", path = "pnpm-lock.yaml"): LockfileVersions {
  return guardLockfile(text, path, () => {
    const docs = parseAllDocuments(text, { uniqueKeys: false });
    if (docs.length === 0) throw new Error("not a YAML mapping");
    if (docs.length > MAX_PNPM_LOCK_DOCUMENTS) throw new Error("too many YAML documents");
    const parsedDocs: Record<string, unknown>[] = [];
    for (const doc of docs) {
      if (doc.errors.length > 0) throw doc.errors[0]!;
      const parsed: unknown = doc.toJS({ maxAliasCount: MAX_ALIAS_COUNT });
      if (!isRecord(parsed)) throw new Error("not a YAML mapping");
      parsedDocs.push(parsed);
    }
    const data = parsedDocs[parsedDocs.length - 1]!;
    const formatVersion = data.lockfileVersion === undefined ? null : String(data.lockfileVersion);
    const importerKey = importer === "" ? "." : importer;
    let entry: unknown;
    if (isRecord(data.importers)) entry = data.importers[importerKey];
    else if (importerKey === ".") entry = data;
    const versions = new Map<string, string>();
    if (isRecord(entry)) {
      for (const key of DEPENDENCY_KEYS) {
        const section = entry[key];
        if (!isRecord(section)) continue;
        for (const [name, value] of Object.entries(section)) {
          const raw = typeof value === "string" ? value : isRecord(value) && typeof value.version === "string" ? value.version : null;
          const version = raw === null ? null : stripPnpmVersionSuffix(raw);
          if (version) versions.set(name, version);
        }
      }
    }
    return { versions, formatVersion, warnings: [] };
  });
}

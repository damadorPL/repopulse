/** `pnpm-lock.yaml` reader (v6 – v9 importer layout, plus the older `specifiers` layout). */
import { parse as parseYaml } from "yaml";
import { isRecord } from "../util.js";
import { guardLockfile, type LockfileVersions } from "./common.js";

const DEPENDENCY_KEYS = ["dependencies", "devDependencies", "optionalDependencies"] as const;

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
 */
export function readPnpmLock(text: string, importer = ".", path = "pnpm-lock.yaml"): LockfileVersions {
  return guardLockfile(text, path, () => {
    const data: unknown = parseYaml(text, { maxAliasCount: -1, uniqueKeys: false });
    if (!isRecord(data)) throw new Error("not a YAML mapping");
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

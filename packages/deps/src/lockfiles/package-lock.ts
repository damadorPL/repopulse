/** `package-lock.json` / `npm-shrinkwrap.json` (v1, v2, v3) reader. */
import { isRecord } from "../util.js";
import { guardLockfile, type LockfileVersions } from "./common.js";

const DEPENDENCY_KEYS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"] as const;

/**
 * Resolved versions of the direct dependencies of `importer` (the manifest's directory relative to the lockfile's,
 * `""` = root). Workspace members resolve `<importer>/node_modules/<name>` first, then the hoisted
 * `node_modules/<name>`. Linked (workspace) packages are skipped.
 */
export function readPackageLock(text: string, importer = "", path = "package-lock.json"): LockfileVersions {
  return guardLockfile(text, path, () => {
    const data: unknown = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
    if (!isRecord(data)) throw new Error("not a JSON object");
    const formatVersion = data.lockfileVersion === undefined ? null : String(data.lockfileVersion);
    const versions = new Map<string, string>();
    const packages = isRecord(data.packages) ? data.packages : null;

    if (packages) {
      const importerEntry = packages[importer];
      const names = new Set<string>();
      if (isRecord(importerEntry)) {
        for (const key of DEPENDENCY_KEYS) {
          const section = importerEntry[key];
          if (isRecord(section)) for (const name of Object.keys(section)) names.add(name);
        }
      }
      for (const name of names) {
        const candidates = importer === "" ? [`node_modules/${name}`] : [`${importer}/node_modules/${name}`, `node_modules/${name}`];
        for (const key of candidates) {
          const entry = packages[key];
          if (!isRecord(entry)) continue;
          if (entry.link === true) break;
          if (typeof entry.version === "string") {
            versions.set(name, entry.version);
            break;
          }
        }
      }
    } else if (importer === "" && isRecord(data.dependencies)) {
      // lockfileVersion 1: no importer list; every top-level entry is reported (callers look up direct names).
      for (const [name, entry] of Object.entries(data.dependencies)) {
        if (isRecord(entry) && typeof entry.version === "string" && !entry.version.startsWith("file:")) {
          versions.set(name, entry.version);
        }
      }
    }
    return { versions, formatVersion, warnings: [] };
  });
}

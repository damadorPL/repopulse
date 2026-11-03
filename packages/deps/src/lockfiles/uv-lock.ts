/** `uv.lock` reader (TOML `[[package]]`). */
import { parse as parseToml } from "smol-toml";
import { isRecord, normalizePypiName } from "../util.js";
import { comparePep440 } from "../versions/pep440.js";
import { guardLockfile, type LockfileVersions } from "./common.js";

/**
 * Resolved versions of registry packages, keyed by normalized name. With `names`, only those are returned.
 * Editable / virtual / path / git sources are skipped. A package locked at several versions (forked resolution)
 * reports the highest. `formatVersion` = `"<version>/<revision>"`.
 */
export function readUvLock(text: string, names?: Iterable<string>, path = "uv.lock"): LockfileVersions {
  return guardLockfile(text, path, () => {
    const data = parseToml(text) as Record<string, unknown>;
    const formatVersion =
      data.version === undefined ? null : `${String(data.version)}/${data.revision === undefined ? "0" : String(data.revision)}`;
    const wanted = names ? new Set([...names].map(normalizePypiName)) : null;
    const versions = new Map<string, string>();
    const packages = Array.isArray(data.package) ? data.package : [];
    for (const entry of packages) {
      if (!isRecord(entry) || typeof entry.name !== "string" || typeof entry.version !== "string") continue;
      const source = isRecord(entry.source) ? entry.source : {};
      if (!("registry" in source)) continue;
      const name = normalizePypiName(entry.name);
      if (wanted && !wanted.has(name)) continue;
      const existing = versions.get(name);
      if (!existing || comparePep440(entry.version, existing) > 0) versions.set(name, entry.version);
    }
    return { versions, formatVersion, warnings: [] };
  });
}

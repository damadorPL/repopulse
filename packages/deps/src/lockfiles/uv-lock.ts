/** `uv.lock` reader (TOML `[[package]]`). */
import { parse as parseToml } from "smol-toml";
import { isRecord, normalizePypiName } from "../util.js";
import { comparePep440 } from "../versions/pep440.js";
import { formatLockfileVersion, guardPrepareLockfile, type LockfileVersions, type PreparedLockfile } from "./common.js";

/** Parses `uv.lock` once and filters by each manifest's requested names without re-parsing TOML. */
export function prepareUvLock(text: string, path = "uv.lock"): PreparedLockfile {
  return guardPrepareLockfile(text, path, () => {
    const data = parseToml(text) as Record<string, unknown>;
    const ver = formatLockfileVersion(data.version);
    const rev = formatLockfileVersion(data.revision);
    const formatVersion = ver === null ? null : `${ver}/${rev ?? "0"}`;
    const allVersions = new Map<string, string>();
    const packages = Array.isArray(data.package) ? data.package : [];
    for (const entry of packages) {
      if (!isRecord(entry) || typeof entry.name !== "string" || typeof entry.version !== "string") continue;
      const source = isRecord(entry.source) ? entry.source : {};
      if (!("registry" in source)) continue;
      const name = normalizePypiName(entry.name);
      const existing = allVersions.get(name);
      if (!existing || comparePep440(entry.version, existing) > 0) allVersions.set(name, entry.version);
    }

    return {
      readFor(_importer, dependencies) {
        const versions = new Map<string, string>();
        for (const dep of dependencies) {
          const name = normalizePypiName(dep.name);
          const version = allVersions.get(name);
          if (version) versions.set(name, version);
        }
        return { versions, formatVersion, warnings: [] };
      },
    };
  });
}

/**
 * Resolved versions of registry packages, keyed by normalized name. With `names`, only those are returned.
 * Editable / virtual / path / git sources are skipped. A package locked at several versions (forked resolution)
 * reports the highest. `formatVersion` = `"<version>/<revision>"`.
 */
export function readUvLock(text: string, names?: Iterable<string>, path = "uv.lock"): LockfileVersions {
  const prepared = prepareUvLock(text, path);
  if (names) {
    return prepared.readFor(
      "",
      [...names].map((name) => ({ name, declared: "" })),
    );
  }
  return guardPrepareLockfile(text, path, () => {
    const data = parseToml(text) as Record<string, unknown>;
    const packages = Array.isArray(data.package) ? data.package : [];
    const allNames: Array<{ name: string; declared: string }> = [];
    for (const entry of packages) {
      if (isRecord(entry) && typeof entry.name === "string") allNames.push({ name: entry.name, declared: "" });
    }
    return { readFor: () => prepared.readFor("", allNames) };
  }).readFor("", []);
}

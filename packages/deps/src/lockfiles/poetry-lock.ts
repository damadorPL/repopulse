/** `poetry.lock` reader (TOML `[[package]]`, `[metadata] lock-version`). */
import { parse as parseToml } from "smol-toml";

import { isRecord, normalizePypiName } from "../util.js";
import { comparePep440 } from "../versions/pep440.js";
import { formatLockfileVersion, guardPrepareLockfile, type LockfileVersions, type PreparedLockfile } from "./common.js";

/** Parses `poetry.lock` once and filters by each manifest's requested names without re-parsing TOML. */
export function preparePoetryLock(text: string, path = "poetry.lock"): PreparedLockfile {
  return guardPrepareLockfile(text, path, () => {
    const data = parseToml(text) as Record<string, unknown>;
    const metadata = isRecord(data.metadata) ? data.metadata : {};
    const formatVersion = formatLockfileVersion(metadata["lock-version"]);
    const allVersions = new Map<string, string>();
    const packages = Array.isArray(data.package) ? data.package : [];
    for (const entry of packages) {
      if (!isRecord(entry) || typeof entry.name !== "string" || typeof entry.version !== "string") continue;
      if (isRecord(entry.source) && typeof entry.source.type === "string") continue;
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
 * Resolved versions keyed by normalized name (only `names` when given). Packages with a `[package.source]` of type
 * git / directory / file / url are skipped; `legacy` (private index) sources too.
 *
 * @internal Exported for unit tests.
 */
export function readPoetryLock(text: string, names?: Iterable<string>, path = "poetry.lock"): LockfileVersions {
  const prepared = preparePoetryLock(text, path);
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

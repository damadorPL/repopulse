/** `poetry.lock` reader (TOML `[[package]]`, `[metadata] lock-version`). */
import { parse as parseToml } from "smol-toml";
import { isRecord, normalizePypiName } from "../util.js";
import { comparePep440 } from "../versions/pep440.js";
import { guardLockfile, type LockfileVersions } from "./common.js";

/**
 * Resolved versions keyed by normalized name (only `names` when given). Packages with a `[package.source]` of type
 * git / directory / file / url are skipped; `legacy` (private index) sources too.
 */
export function readPoetryLock(text: string, names?: Iterable<string>, path = "poetry.lock"): LockfileVersions {
  return guardLockfile(text, path, () => {
    const data = parseToml(text) as Record<string, unknown>;
    const metadata = isRecord(data.metadata) ? data.metadata : {};
    const lockVersion = metadata["lock-version"];
    const formatVersion = lockVersion === undefined ? null : String(lockVersion);
    const wanted = names ? new Set([...names].map(normalizePypiName)) : null;
    const versions = new Map<string, string>();
    const packages = Array.isArray(data.package) ? data.package : [];
    for (const entry of packages) {
      if (!isRecord(entry) || typeof entry.name !== "string" || typeof entry.version !== "string") continue;
      if (isRecord(entry.source) && typeof entry.source.type === "string") continue;
      const name = normalizePypiName(entry.name);
      if (wanted && !wanted.has(name)) continue;
      const existing = versions.get(name);
      if (!existing || comparePep440(entry.version, existing) > 0) versions.set(name, entry.version);
    }
    return { versions, formatVersion, warnings: [] };
  });
}

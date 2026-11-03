/** Text `bun.lock` reader (Bun ≥ 1.2; JSONC with trailing commas). `bun.lockb` is binary and never read. */
import { parseJsonWithTrailingCommas } from "../manifests/json-locate.js";
import { isRecord } from "../util.js";
import { guardLockfile, splitNameAtVersion, type LockfileVersions } from "./common.js";

const DEPENDENCY_KEYS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"] as const;

/**
 * Resolved versions of the direct dependencies of workspace `importer` (`""` = root, else its path relative to the
 * lockfile, as in the `workspaces` table). `packages[name][0]` is `"name@version"`; a member-specific resolution
 * lives under `"<member name>/<dep>"`.
 */
export function readBunLock(text: string, importer = "", path = "bun.lock"): LockfileVersions {
  return guardLockfile(text, path, () => {
    const data = parseJsonWithTrailingCommas(text);
    if (!isRecord(data)) throw new Error("not a JSON object");
    const formatVersion = data.lockfileVersion === undefined ? null : String(data.lockfileVersion);
    const workspaces = isRecord(data.workspaces) ? data.workspaces : {};
    const packages = isRecord(data.packages) ? data.packages : {};
    const workspace = workspaces[importer];
    const versions = new Map<string, string>();
    if (!isRecord(workspace)) return { versions, formatVersion, warnings: [] };
    const memberName = typeof workspace.name === "string" ? workspace.name : null;
    for (const key of DEPENDENCY_KEYS) {
      const section = workspace[key];
      if (!isRecord(section)) continue;
      for (const name of Object.keys(section)) {
        const entry = (memberName && importer !== "" ? packages[`${memberName}/${name}`] : undefined) ?? packages[name];
        if (!Array.isArray(entry) || typeof entry[0] !== "string") continue;
        const ident = splitNameAtVersion(entry[0]);
        if (!ident || ident.name !== name) continue;
        // `workspace:`, `github:`, `file:` … resolutions are not registry versions.
        if (/^[a-z]+:/i.test(ident.version)) continue;
        versions.set(name, ident.version);
      }
    }
    return { versions, formatVersion, warnings: [] };
  });
}

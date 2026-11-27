/** `yarn.lock` reader: classic (v1, custom format) and Berry (YAML with `resolution`). Check only. */
import { parse as parseYaml } from "yaml";

import { isRecord } from "../util.js";
import { formatLockfileVersion, guardPrepareLockfile, type LockfileVersions, type PreparedLockfile } from "./common.js";

/** Splits a lock key `"name@range"` / `"name@npm:range"` into name and range. */
function splitDescriptor(descriptor: string): { name: string; range: string } | null {
  const value = descriptor.trim().replace(/^"|"$/g, "");
  const at = value.indexOf("@", 1);
  if (at === -1) return null;
  return { name: value.slice(0, at), range: value.slice(at + 1) };
}

/** Reads classic `yarn.lock` blocks into `descriptor → version`. */
function parseClassic(text: string): Map<string, string> {
  const resolved = new Map<string, string>();
  let descriptors: string[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    if (rawLine.trim() === "" || rawLine.trimStart().startsWith("#")) continue;
    if (!/^\s/.test(rawLine)) {
      // `"a@^1.0.0", a@^1.1.0:` header.
      descriptors = rawLine
        .replace(/:\s*$/, "")
        .split(/,\s*/)
        .map((d) => d.trim().replace(/^"|"$/g, ""));
      continue;
    }
    const match = /^\s+version:?\s+"?([^"\s]+)"?/.exec(rawLine);
    if (match && /^\s{2}\S/.test(rawLine))
      for (const descriptor of descriptors) resolved.set(descriptor, match[1] as string);
  }
  return resolved;
}

/** Parses `yarn.lock` once and indexes descriptors by name for O(1) lookup across workspace manifests. */
export function prepareYarnLock(text: string, path = "yarn.lock"): PreparedLockfile {
  return guardPrepareLockfile(text, path, () => {
    const isBerry = /^__metadata:/m.test(text);
    const byDescriptor = new Map<string, string>();
    let formatVersion: string;
    if (isBerry) {
      const data: unknown = parseYaml(text, { maxAliasCount: 100, uniqueKeys: false });
      if (!isRecord(data)) throw new Error("not a YAML mapping");
      const metadata = isRecord(data.__metadata) ? data.__metadata : {};
      formatVersion = `berry/${formatLockfileVersion(metadata.version) ?? "unknown"}`;
      for (const [key, entry] of Object.entries(data)) {
        if (key === "__metadata" || !isRecord(entry)) continue;
        if (typeof entry.version !== "string" && typeof entry.version !== "number") continue;
        const version = String(entry.version);
        for (const descriptor of key.split(/,\s*/)) byDescriptor.set(descriptor.trim(), version);
      }
    } else {
      if (!/#\s*yarn lockfile v1/i.test(text.slice(0, 500))) throw new Error("unknown yarn.lock format");
      formatVersion = "classic";
      for (const [descriptor, version] of parseClassic(text)) byDescriptor.set(descriptor, version);
    }

    // Pre-index registry versions by package name for O(1) fallback lookup.
    const byName = new Map<string, Set<string>>();
    for (const [descriptor, version] of byDescriptor) {
      const parts = splitDescriptor(descriptor);
      if (!parts || /^(?:workspace|patch|portal|link|file|git|https?):/.test(parts.range)) continue;
      let set = byName.get(parts.name);
      if (!set) {
        set = new Set<string>();
        byName.set(parts.name, set);
      }
      set.add(version);
    }

    return {
      readFor(_importer, dependencies) {
        const versions = new Map<string, string>();
        for (const { name, declared } of dependencies) {
          const version = byDescriptor.get(`${name}@${declared}`) ?? byDescriptor.get(`${name}@npm:${declared}`);
          if (version) versions.set(name, version);
        }
        // Fallback: a single entry for the name (range spelled differently, e.g. normalized by Berry).
        for (const { name } of dependencies) {
          if (versions.has(name)) continue;
          const found = byName.get(name);
          if (found?.size === 1) versions.set(name, [...found][0] as string);
        }
        return { versions, formatVersion, warnings: [] };
      },
    };
  });
}

/**
 * Resolved versions of the given direct dependencies. Yarn keys entries by `name@range`, so the declared ranges
 * of the manifest are needed (`declared` = `[{ name, range }]`).
 */
export function readYarnLock(
  text: string,
  declared: ReadonlyArray<{ name: string; range: string }>,
  path = "yarn.lock",
): LockfileVersions {
  return prepareYarnLock(text, path).readFor(
    "",
    declared.map((d) => ({ name: d.name, declared: d.range })),
  );
}

/** `package.json` parser: direct dependencies by type, with the location of each value for span edits. */
import type { DependencyKind, ParsedDependency } from "../types.js";
import { isRecord } from "../util.js";
import { npmUnsupportedReason } from "../versions/npm.js";
import { ManifestParseError } from "./errors.js";
import { jsonPathKey, locateJsonStrings, type JsonLocations } from "./json-locate.js";

/** `package.json` dependency sections and their kinds. */
export const PACKAGE_JSON_SECTIONS: ReadonlyArray<{ key: string; kind: DependencyKind }> = [
  { key: "dependencies", kind: "PROD" },
  { key: "devDependencies", kind: "DEV" },
  { key: "peerDependencies", kind: "PEER" },
  { key: "optionalDependencies", kind: "OPTIONAL" },
];

/** Override tables: listed as `UNSUPPORTED_SOURCE` (kind `PROD`, `group` = the table name), never updated. */
const OVERRIDE_TABLES: ReadonlyArray<{ path: string[]; group: string; reason: string }> = [
  { path: ["overrides"], group: "overrides", reason: "npm override (not updated)" },
  { path: ["pnpm", "overrides"], group: "pnpm.overrides", reason: "pnpm override (not updated)" },
  { path: ["resolutions"], group: "resolutions", reason: "Yarn resolution (not updated)" },
];

export interface PackageJsonManifest {
  name: string | null;
  version: string | null;
  /** The `packageManager` field (`"pnpm@9.12.0"`), or `null`. */
  packageManager: string | null;
  /** `workspaces` globs (array form or `{ packages }`), or `null` when absent. */
  workspaces: string[] | null;
  dependencies: ParsedDependency[];
}

/** Section key of a dependency kind (`PROD` → `dependencies`). */
export function packageJsonSectionOf(kind: DependencyKind): string | null {
  return PACKAGE_JSON_SECTIONS.find((section) => section.kind === kind)?.key ?? null;
}

/**
 * Parses a `package.json`. Unsupported specs (git, file, workspace, catalog, alias, URL, `*`, dist-tags) are kept
 * with `supported: false`. Throws {@link ManifestParseError} when the file is not a JSON object.
 */
export function parsePackageJson(text: string, path = "package.json"): PackageJsonManifest {
  let data: unknown;
  let locations: JsonLocations;
  try {
    locations = locateJsonStrings(text, { maxDepth: 3 }).locations;
    data = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch (error) {
    throw new ManifestParseError(path, `invalid JSON (${error instanceof Error ? error.message : String(error)})`);
  }
  if (!isRecord(data)) throw new ManifestParseError(path, "not a JSON object");

  const dependencies: ParsedDependency[] = [];
  for (const { key, kind } of PACKAGE_JSON_SECTIONS) {
    const section = data[key];
    if (!isRecord(section)) continue;
    for (const [name, value] of Object.entries(section)) {
      const located = locations.get(jsonPathKey([key, name]));
      const declared = typeof value === "string" ? value : "";
      const reason = typeof value === "string" ? npmUnsupportedReason(value) : "Not a version string";
      dependencies.push({
        name,
        rawName: name,
        kind,
        group: "",
        declared,
        rangeSyntax: "npm",
        span: located?.plain ? located.span : null,
        supported: reason === null,
        ...(reason === null ? {} : { unsupportedReason: reason }),
        file: path,
      });
    }
  }

  for (const table of OVERRIDE_TABLES) {
    let section: unknown = data;
    for (const segment of table.path) section = isRecord(section) ? section[segment] : undefined;
    if (!isRecord(section)) continue;
    for (const [name, value] of Object.entries(section)) {
      if (typeof value !== "string") continue;
      dependencies.push({
        name,
        rawName: name,
        kind: "PROD",
        group: table.group,
        declared: value,
        rangeSyntax: "npm",
        span: null,
        supported: false,
        unsupportedReason: table.reason,
        file: path,
      });
    }
  }

  const workspacesField = data.workspaces;
  let workspaces: string[] | null = null;
  if (Array.isArray(workspacesField)) workspaces = workspacesField.filter((g): g is string => typeof g === "string");
  else if (isRecord(workspacesField) && Array.isArray(workspacesField.packages)) {
    workspaces = workspacesField.packages.filter((g): g is string => typeof g === "string");
  }

  return {
    name: typeof data.name === "string" ? data.name : null,
    version: typeof data.version === "string" ? data.version : null,
    packageManager: typeof data.packageManager === "string" ? data.packageManager : null,
    workspaces,
    dependencies,
  };
}

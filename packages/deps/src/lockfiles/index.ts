/** Dispatches to the right lockfile reader for a detected manifest. */
import { readRequirementsPins } from "../manifests/requirements.js";
import type { PackageManager } from "../types.js";
import { basename } from "../util.js";
import { readBunLock } from "./bun-lock.js";
import { emptyLockfile, guardLockfile, type LockfileVersions } from "./common.js";
import { readPackageLock } from "./package-lock.js";
import { readPnpmLock } from "./pnpm-lock.js";
import { readPoetryLock } from "./poetry-lock.js";
import { readUvLock } from "./uv-lock.js";
import { readYarnLock } from "./yarn-lock.js";

export interface ReadLockfileInput {
  packageManager: PackageManager;
  /** Repo-relative lockfile path (its basename selects the format). */
  lockfilePath: string;
  text: string;
  /** Manifest directory relative to the lockfile directory (`""` = same directory). */
  importer: string;
  /** Direct dependencies of the manifest (Yarn needs the ranges; uv / Poetry filter by name). */
  dependencies: ReadonlyArray<{ name: string; declared: string }>;
}

/**
 * Reads the resolved versions of a manifest's direct dependencies from its lockfile. Unknown formats and
 * `bun.lockb` (binary) give an empty map with a warning; an oversize or unparsable file too.
 */
export function readLockfile(input: ReadLockfileInput): LockfileVersions {
  const file = basename(input.lockfilePath);
  const names = input.dependencies.map((dependency) => dependency.name);
  switch (file) {
    case "package-lock.json":
    case "npm-shrinkwrap.json":
      return readPackageLock(input.text, input.importer, input.lockfilePath);
    case "pnpm-lock.yaml":
      return readPnpmLock(input.text, input.importer === "" ? "." : input.importer, input.lockfilePath);
    case "bun.lock":
      return readBunLock(input.text, input.importer, input.lockfilePath);
    case "bun.lockb":
      return emptyLockfile("bun.lockb is binary: switch to the text bun.lock");
    case "yarn.lock":
      return readYarnLock(
        input.text,
        input.dependencies.map((dependency) => ({ name: dependency.name, range: dependency.declared })),
        input.lockfilePath,
      );
    case "uv.lock":
      return readUvLock(input.text, names, input.lockfilePath);
    case "poetry.lock":
      return readPoetryLock(input.text, names, input.lockfilePath);
    default:
      if (input.packageManager === "PIP_TOOLS" || /\.txt$/.test(file)) {
        return guardLockfile(input.text, input.lockfilePath, () => ({
          versions: readRequirementsPins(input.text, input.lockfilePath),
          formatVersion: null,
          warnings: [],
        }));
      }
      return emptyLockfile(`${input.lockfilePath}: unknown lockfile format`);
  }
}

export { readBunLock } from "./bun-lock.js";
export { emptyLockfile, splitNameAtVersion, type LockfileVersions } from "./common.js";
export { readPackageLock } from "./package-lock.js";
export { readPnpmLock, stripPnpmVersionSuffix } from "./pnpm-lock.js";
export { readPoetryLock } from "./poetry-lock.js";
export { readUvLock } from "./uv-lock.js";
export { readYarnLock } from "./yarn-lock.js";

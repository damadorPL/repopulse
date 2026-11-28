/** Dispatches to the right lockfile reader for a detected manifest. */
import { readRequirementsPins } from "../manifests/requirements.js";
import type { PackageManager } from "../types.js";
import { basename } from "../util.js";
import { prepareBunLock } from "./bun-lock.js";
import { emptyLockfile, guardPrepareLockfile, type LockfileVersions, type PreparedLockfile } from "./common.js";
import { preparePackageLock } from "./package-lock.js";
import { preparePnpmLock } from "./pnpm-lock.js";
import { preparePoetryLock } from "./poetry-lock.js";
import { prepareUvLock } from "./uv-lock.js";
import { prepareYarnLock } from "./yarn-lock.js";

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

export interface PrepareLockfileInput {
  packageManager: PackageManager;
  /** Repo-relative lockfile path (its basename selects the format). */
  lockfilePath: string;
  text: string;
}

/**
 * Parses a lockfile once and returns a {@link PreparedLockfile} that can resolve versions for any workspace importer
 * without re-parsing the file.
 */
export function prepareLockfile(input: PrepareLockfileInput): PreparedLockfile {
  const file = basename(input.lockfilePath);
  switch (file) {
    case "package-lock.json":
    case "npm-shrinkwrap.json":
      return preparePackageLock(input.text, input.lockfilePath);
    case "pnpm-lock.yaml":
      return preparePnpmLock(input.text, input.lockfilePath);
    case "bun.lock":
      return prepareBunLock(input.text, input.lockfilePath);
    case "bun.lockb": {
      const result = emptyLockfile("bun.lockb is binary: switch to the text bun.lock");
      return { readFor: () => result };
    }
    case "yarn.lock":
      return prepareYarnLock(input.text, input.lockfilePath);
    case "uv.lock":
      return prepareUvLock(input.text, input.lockfilePath);
    case "poetry.lock":
      return preparePoetryLock(input.text, input.lockfilePath);
    default:
      if (input.packageManager === "PIP_TOOLS" || file.endsWith(".txt")) {
        return guardPrepareLockfile(input.text, input.lockfilePath, () => {
          const versions = readRequirementsPins(input.text, input.lockfilePath);
          return { readFor: () => ({ versions, formatVersion: null, warnings: [] }) };
        });
      }
      return { readFor: () => emptyLockfile(`${input.lockfilePath}: unknown lockfile format`) };
  }
}

/**
 * Reads the resolved versions of a manifest's direct dependencies from its lockfile. Unknown formats and
 * `bun.lockb` (binary) give an empty map with a warning; an oversize or unparsable file too.
 */
export function readLockfile(input: ReadLockfileInput): LockfileVersions {
  return prepareLockfile(input).readFor(input.importer, input.dependencies);
}

export type { LockfileVersions, PreparedLockfile } from "./common.js";

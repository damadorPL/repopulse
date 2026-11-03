import type { DependencyEcosystem } from "../types.js";

/** One published version, normalized across registries. */
export interface RegistryVersion {
  version: string;
  /** npm `time[version]`; PyPI: earliest file `upload-time`. `null` when unknown. */
  publishedAt: Date | null;
  /** npm `deprecated`. */
  deprecated: boolean;
  /** PyPI: every file of the version is yanked. */
  yanked: boolean;
  /**
   * PyPI: distinct `requires-python` values of the version's (non-yanked) files; `null` when some file has none
   * (always compatible). Always `null` for npm.
   */
  requiresPython: string[] | null;
  /** PyPI: sha256 of every (non-yanked) file, sorted (the `--hash` set). Empty for npm. */
  sha256: string[];
}

export interface RegistryPackage {
  ecosystem: DependencyEcosystem;
  /** npm name or PEP 503-normalized PyPI name. */
  name: string;
  /** Ascending by version precedence. */
  versions: RegistryVersion[];
  /** npm `dist-tags.latest`; `null` for PyPI. */
  latestTag: string | null;
  /** `https://github.com/<owner>/<repo>` from registry metadata, for changelog links. */
  sourceRepoUrl: string | null;
}

/** `found: false` → `UNSUPPORTED_SOURCE` ("not on the public registry"). */
export type RegistryLookup = { found: true; package: RegistryPackage } | { found: false; reason: string };

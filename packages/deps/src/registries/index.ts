import type { DependencyEcosystem } from "../types.js";
import { fetchNpmPackage, type NpmFetchOptions } from "./npm.js";
import { fetchPypiPackage, type PypiFetchOptions } from "./pypi.js";
import type { RegistryLookup } from "./types.js";

/** Looks a dependency up on its ecosystem's public registry. */
export function fetchRegistryPackage(
  ecosystem: DependencyEcosystem,
  name: string,
  options: NpmFetchOptions & PypiFetchOptions,
): Promise<RegistryLookup> {
  return ecosystem === "NPM" ? fetchNpmPackage(name, options) : fetchPypiPackage(name, options);
}

export * from "./cache.js";
export * from "./github-url.js";
export * from "./npm.js";
export * from "./pypi.js";
export * from "./types.js";

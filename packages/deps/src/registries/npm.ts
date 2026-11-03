/**
 * npm registry client. Fixed host; the abbreviated packument gives versions, `dist-tags` and `deprecated`. Publish
 * times and `repository` come from the full document, fetched only when the abbreviated `modified` is newer than
 * the cached times (Slice 08 §3.4).
 */
import semver from "semver";
import { isRecord } from "../util.js";
import { cachedGet, registryCacheKey, type RegistryFetchOptions } from "./cache.js";
import { toGitHubRepoUrl } from "./github-url.js";
import type { RegistryLookup, RegistryVersion } from "./types.js";

export const NPM_REGISTRY_URL = "https://registry.npmjs.org";
export const NPM_ABBREVIATED_ACCEPT = "application/vnd.npm.install-v1+json";

const NPM_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9_][a-z0-9._~-]*$/i;

/** `true` for a syntactically valid npm package name (≤ 214 chars). */
export function isValidNpmPackageName(name: string): boolean {
  return name.length <= 214 && NPM_NAME.test(name);
}

/** Registry URL of a package: scoped names are encoded as `@scope%2Fname`. */
export function npmPackageUrl(name: string): string {
  const encoded = name.startsWith("@") ? `@${encodeURIComponent(name.slice(1))}` : encodeURIComponent(name);
  return `${NPM_REGISTRY_URL}/${encoded}`;
}

interface CompactAbbreviated {
  modified: string | null;
  latest: string | null;
  /** version → deprecated */
  versions: Record<string, boolean>;
}

interface CompactTimes {
  time: Record<string, string>;
  repository: string | null;
}

function compactAbbreviated(body: string): string {
  const data: unknown = JSON.parse(body);
  if (!isRecord(data)) throw new Error("packument is not an object");
  const versions: Record<string, boolean> = {};
  if (isRecord(data.versions)) {
    for (const [version, manifest] of Object.entries(data.versions)) {
      if (semver.valid(version) === null) continue;
      versions[version] = isRecord(manifest) && typeof manifest.deprecated === "string" && manifest.deprecated !== "";
    }
  }
  const tags = isRecord(data["dist-tags"]) ? data["dist-tags"] : {};
  const compact: CompactAbbreviated = {
    modified: typeof data.modified === "string" ? data.modified : null,
    latest: typeof tags.latest === "string" ? tags.latest : null,
    versions,
  };
  return JSON.stringify(compact);
}

function compactFull(body: string): string {
  const data: unknown = JSON.parse(body);
  if (!isRecord(data)) throw new Error("packument is not an object");
  const time: Record<string, string> = {};
  if (isRecord(data.time)) {
    for (const [key, value] of Object.entries(data.time)) if (typeof value === "string") time[key] = value;
  }
  const repository = isRecord(data.repository) ? data.repository.url : data.repository;
  const compact: CompactTimes = { time, repository: toGitHubRepoUrl(repository) };
  return JSON.stringify(compact);
}

export interface NpmFetchOptions extends RegistryFetchOptions {
  /** Fetch publish times (needed for `minReleaseAgeDays` and "released"); default `true`. */
  includeTimes?: boolean;
}

/**
 * Looks up an npm package. Throws `RegistryUnavailableError` on 429 / 5xx / network errors; returns
 * `{ found: false }` for 404 and invalid names.
 */
export async function fetchNpmPackage(name: string, options: NpmFetchOptions): Promise<RegistryLookup> {
  if (!isValidNpmPackageName(name)) return { found: false, reason: "Invalid npm package name" };
  const abbreviated = await cachedGet({
    registry: "npm",
    url: npmPackageUrl(name),
    accept: NPM_ABBREVIATED_ACCEPT,
    key: registryCacheKey("npm", name),
    options,
    derive: compactAbbreviated,
  });
  if (!abbreviated.found) return { found: false, reason: "Not on the public npm registry" };
  const packument = JSON.parse(abbreviated.body) as CompactAbbreviated;

  let times: CompactTimes | null = null;
  if (options.includeTimes !== false) {
    const timeKey = registryCacheKey("npm-time", name);
    const cachedTimes = options.cache ? await options.cache.get(timeKey) : null;
    const cachedModified = cachedTimes ? (JSON.parse(cachedTimes.body) as CompactTimes).time.modified : undefined;
    // The cached times are stale when the abbreviated document was modified after them.
    const stale =
      cachedTimes !== null &&
      packument.modified !== null &&
      (cachedModified === undefined || Date.parse(cachedModified) < Date.parse(packument.modified));
    if (cachedTimes !== null && !stale) times = JSON.parse(cachedTimes.body) as CompactTimes;
    else {
      // Stale: bypass the freshness window (the ETag still saves the transfer when nothing changed).
      const full = await cachedGet({
        registry: "npm",
        url: npmPackageUrl(name),
        accept: "application/json",
        key: timeKey,
        options: { ...options, ttlMs: stale ? 0 : options.ttlMs },
        derive: compactFull,
      });
      if (full.found) times = JSON.parse(full.body) as CompactTimes;
    }
  }

  const versions: RegistryVersion[] = Object.entries(packument.versions)
    .map(([version, deprecated]) => {
      const published = times?.time[version];
      const date = published ? new Date(published) : null;
      return {
        version,
        publishedAt: date && !Number.isNaN(date.getTime()) ? date : null,
        deprecated,
        yanked: false,
        requiresPython: null,
        sha256: [],
      };
    })
    .sort((a, b) => semver.compare(a.version, b.version));

  return {
    found: true,
    package: {
      ecosystem: "NPM",
      name,
      versions,
      latestTag: packument.latest,
      sourceRepoUrl: times?.repository ?? null,
    },
  };
}

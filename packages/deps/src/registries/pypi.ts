/**
 * PyPI client. Fixed host; PEP 691 Simple JSON gives the versions and, per file, PEP 700 `upload-time`, `yanked`,
 * `requires-python` and `hashes.sha256`. `/pypi/<name>/json` is read only for `project_urls` (→ `sourceRepoUrl`).
 */
import { isRecord, normalizePypiName } from "../util.js";
import { comparePep440, normalizePep440, parsePep440 } from "../versions/pep440.js";
import { cachedGet, isRegistryUnavailableError, registryCacheKey, type RegistryFetchOptions } from "./cache.js";
import { toGitHubRepoUrl } from "./github-url.js";
import type { RegistryLookup, RegistryVersion } from "./types.js";

export const PYPI_SIMPLE_URL = "https://pypi.org/simple";
export const PYPI_JSON_URL = "https://pypi.org/pypi";
export const PYPI_SIMPLE_ACCEPT = "application/vnd.pypi.simple.v1+json";

const NORMALIZED_NAME = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

const ARCHIVE_EXTENSIONS = [".tar.gz", ".tar.bz2", ".tar.xz", ".tgz", ".zip", ".tar", ".egg", ".exe", ".msi"];

/**
 * Version encoded in a distribution file name: wheels `{name}-{ver}(-{build})?-{py}-{abi}-{plat}.whl`, sdists
 * `{name}-{ver}.tar.gz` (the name may contain `-` in old sdists). `null` when it cannot be determined.
 */
export function versionFromFilename(filename: string, normalizedName: string): string | null {
  if (filename.endsWith(".whl")) {
    const parts = filename.slice(0, -4).split("-");
    return parts.length >= 5 ? (parts[1] ?? null) : null;
  }
  const extension = ARCHIVE_EXTENSIONS.find((ext) => filename.toLowerCase().endsWith(ext));
  if (!extension) return null;
  const stem = filename.slice(0, -extension.length);
  const parts = stem.split("-");
  for (let k = 1; k < parts.length; k++) {
    if (normalizePypiName(parts.slice(0, k).join("-")) === normalizedName) {
      // `.egg` / `.exe` carry a python / platform tag after the version.
      const version = extension === ".egg" || extension === ".exe" || extension === ".msi" ? parts[k] : parts.slice(k).join("-");
      return version && parsePep440(version) ? version : null;
    }
  }
  return null;
}

interface CompactFile {
  v: string;
  t: string | null;
  y: boolean;
  rp: string | null;
  h: string | null;
}

interface CompactSimple {
  versions: string[];
  files: CompactFile[];
}

function compactSimple(normalizedName: string): (body: string) => string {
  return (body) => {
    const data: unknown = JSON.parse(body);
    if (!isRecord(data)) throw new Error("simple index is not an object");
    const files: CompactFile[] = [];
    for (const file of Array.isArray(data.files) ? data.files : []) {
      if (!isRecord(file) || typeof file.filename !== "string") continue;
      const version = versionFromFilename(file.filename, normalizedName);
      if (!version) continue;
      const hashes = isRecord(file.hashes) ? file.hashes : {};
      files.push({
        v: normalizePep440(version),
        t: typeof file["upload-time"] === "string" ? file["upload-time"] : null,
        y: file.yanked === true || (typeof file.yanked === "string" && file.yanked !== "") ,
        rp: typeof file["requires-python"] === "string" && file["requires-python"].trim() !== "" ? file["requires-python"] : null,
        h: typeof hashes.sha256 === "string" ? hashes.sha256.toLowerCase() : null,
      });
    }
    const versions = Array.isArray(data.versions)
      ? data.versions.filter((v): v is string => typeof v === "string")
      : [...new Set(files.map((file) => file.v))];
    const compact: CompactSimple = { versions, files };
    return JSON.stringify(compact);
  };
}

function compactJson(body: string): string {
  const data: unknown = JSON.parse(body);
  const info = isRecord(data) && isRecord(data.info) ? data.info : {};
  const urls: unknown[] = [];
  if (isRecord(info.project_urls)) {
    // Prefer the keys that usually point at the repository.
    const entries = Object.entries(info.project_urls);
    const preferred = /^(source|source code|repository|code|github|homepage|home)$/i;
    urls.push(...entries.filter(([key]) => preferred.test(key.trim())).map(([, url]) => url));
    urls.push(...entries.map(([, url]) => url));
  }
  urls.push(info.home_page);
  const sourceRepoUrl = urls.map(toGitHubRepoUrl).find((url): url is string => url !== null) ?? null;
  return JSON.stringify({ sourceRepoUrl });
}

export interface PypiFetchOptions extends RegistryFetchOptions {
  /** Read `/pypi/<name>/json` for `project_urls`; default `true`. Failures there are ignored. */
  includeProjectUrls?: boolean;
}

/**
 * Looks up a PyPI project (any spelling; normalized per PEP 503). Throws `RegistryUnavailableError` on 429 / 5xx /
 * network errors; `{ found: false }` for 404 and invalid names. A version's release date is its earliest file
 * upload; it is yanked when every file is.
 */
export async function fetchPypiPackage(name: string, options: PypiFetchOptions): Promise<RegistryLookup> {
  const normalized = normalizePypiName(name);
  if (!NORMALIZED_NAME.test(normalized)) return { found: false, reason: "Invalid PyPI project name" };
  const simple = await cachedGet({
    registry: "pypi",
    url: `${PYPI_SIMPLE_URL}/${normalized}/`,
    accept: PYPI_SIMPLE_ACCEPT,
    key: registryCacheKey("pypi", normalized),
    options,
    derive: compactSimple(normalized),
  });
  if (!simple.found) return { found: false, reason: "Not on the public PyPI" };
  const index = JSON.parse(simple.body) as CompactSimple;

  const filesByVersion = new Map<string, CompactFile[]>();
  for (const file of index.files) {
    const list = filesByVersion.get(file.v) ?? [];
    list.push(file);
    filesByVersion.set(file.v, list);
  }
  const versions: RegistryVersion[] = [];
  for (const raw of new Set(index.versions.map(normalizePep440))) {
    if (!parsePep440(raw)) continue;
    const files = filesByVersion.get(raw);
    if (!files || files.length === 0) continue;
    const live = files.filter((file) => !file.y);
    const considered = live.length > 0 ? live : files;
    const times = files.map((file) => (file.t ? Date.parse(file.t) : NaN)).filter((t) => !Number.isNaN(t));
    const requiresPython = considered.some((file) => file.rp === null)
      ? null
      : [...new Set(considered.map((file) => file.rp as string))].sort();
    versions.push({
      version: raw,
      publishedAt: times.length > 0 ? new Date(Math.min(...times)) : null,
      deprecated: false,
      yanked: live.length === 0,
      requiresPython,
      sha256: [...new Set(considered.map((file) => file.h).filter((h): h is string => h !== null))].sort(),
    });
  }
  versions.sort((a, b) => comparePep440(a.version, b.version));

  let sourceRepoUrl: string | null = null;
  if (options.includeProjectUrls !== false) {
    try {
      const meta = await cachedGet({
        registry: "pypi",
        url: `${PYPI_JSON_URL}/${normalized}/json`,
        accept: "application/json",
        key: registryCacheKey("pypi-meta", normalized),
        options,
        derive: compactJson,
      });
      if (meta.found) sourceRepoUrl = (JSON.parse(meta.body) as { sourceRepoUrl: string | null }).sourceRepoUrl;
    } catch (error) {
      if (!isRegistryUnavailableError(error)) throw error;
      // The changelog link is optional: keep the versions.
    }
  }
  return { found: true, package: { ecosystem: "PYPI", name: normalized, versions, latestTag: null, sourceRepoUrl } };
}

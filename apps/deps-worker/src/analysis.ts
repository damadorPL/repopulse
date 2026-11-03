import {
  applyPolicy,
  detectManifests,
  ignoreRulesSchema,
  isManifestParseError,
  MAX_LOCKFILE_BYTES,
  MAX_MANIFEST_BYTES,
  mapWithConcurrency,
  parsePackageJson,
  parsePyproject,
  parseRequirementsTree,
  readLockfile,
  REGISTRY_CONCURRENCY,
  resolveManifestGroups,
  type DependencyEcosystem,
  type DependencyKind,
  type DepsPolicy,
  type DetectedManifest,
  type IgnoreRule,
  type LockfileVersions,
  type ParsedDependency,
  type RegistryLookup,
  type RegistryVersion,
  type RequirementDependency,
  type TargetSelection,
} from "@repopulse/deps";
import type { GitTreeEntry, ReadBlobResult } from "@repopulse/github";
import { lockfileCacheKey, type BlobCache, type LockfileCache } from "./registry-cache";

/**
 * Pure-ish analysis shared by the scan and update processors: read files of a default-branch snapshot (through
 * the content-addressed caches), detect and parse manifests, read current versions from lockfiles, look up the
 * registries once per `(ecosystem, name)` and run the policy. No database access.
 */

// ─── Reading files ─────────────────────────────────────────────────────────

export type BlobReader = (refs: Array<{ path: string; sha: string; size: number | null }>, maxBytes: number) => Promise<ReadBlobResult[]>;

export interface SnapshotReader {
  /** Text of a blob of the snapshot, or `null` (missing, not a blob, larger than `maxBytes`). */
  read(path: string, maxBytes?: number): Promise<string | null>;
  /** Reads several small files with one batched blob request for the uncached ones. */
  readMany(paths: readonly string[], maxBytes?: number): Promise<Map<string, string>>;
  /** Blob SHA of a path, or `null`. */
  sha(path: string): string | null;
  /** Number of blobs downloaded from GitHub (cache misses). */
  readonly downloaded: number;
}

export function createSnapshotReader(entries: readonly GitTreeEntry[], readBlobs: BlobReader, blobCache?: BlobCache | null): SnapshotReader {
  const blobs = new Map(entries.filter((entry) => entry.type === "blob").map((entry) => [entry.path, entry]));
  const memo = new Map<string, string | null>();
  let downloaded = 0;

  const fetchMissing = async (paths: readonly string[], maxBytes: number): Promise<void> => {
    const refs: Array<{ path: string; sha: string; size: number | null }> = [];
    for (const path of paths) {
      if (memo.has(path)) continue;
      const entry = blobs.get(path);
      if (!entry || (entry.size !== null && entry.size > maxBytes)) {
        memo.set(path, null);
        continue;
      }
      const cached = blobCache && maxBytes <= MAX_MANIFEST_BYTES ? await blobCache.get(entry.sha) : null;
      if (cached !== null) memo.set(path, cached);
      else refs.push({ path, sha: entry.sha, size: entry.size });
    }
    if (refs.length === 0) return;
    downloaded += refs.length;
    for (const result of await readBlobs(refs, maxBytes)) {
      memo.set(result.path, result.content);
      if (result.content !== null && blobCache && result.content.length <= MAX_MANIFEST_BYTES) await blobCache.set(result.sha, result.content);
    }
  };

  return {
    async read(path, maxBytes = MAX_MANIFEST_BYTES) {
      await fetchMissing([path], maxBytes);
      return memo.get(path) ?? null;
    },
    async readMany(paths, maxBytes = MAX_MANIFEST_BYTES) {
      await fetchMissing(paths, maxBytes);
      const out = new Map<string, string>();
      for (const path of paths) {
        const text = memo.get(path);
        if (text !== null && text !== undefined) out.set(path, text);
      }
      return out;
    },
    sha: (path) => blobs.get(path)?.sha ?? null,
    get downloaded() {
      return downloaded;
    },
  };
}

// ─── Manifests ─────────────────────────────────────────────────────────────

export interface AnalyzedDependency {
  dependency: ParsedDependency;
  ecosystem: DependencyEcosystem;
  /** From the lockfile / `==` pin / `-c` constraint; `null` when unknown. */
  currentVersion: string | null;
}

export interface AnalyzedManifest {
  detected: DetectedManifest;
  dependencies: AnalyzedDependency[];
  /** `requires-python` of a pyproject (policy input). */
  requiresPython: string | null;
  requiresPythonSyntax: "pep440" | "poetry";
  /** `formatVersion` of the lockfile as read (kept across a regeneration). */
  lockfileFormatVersion: string | null;
  warnings: string[];
}

export interface ProjectAnalysis {
  manifests: AnalyzedManifest[];
  /** Project-level warnings (manifest cap, unreadable files, dependency cap). */
  warnings: string[];
}

/** `name␀kind␀group`: the unique key of a dependency within one manifest. */
export function dependencyKey(name: string, kind: DependencyKind | string, group: string): string {
  return `${name}\u0000${kind}\u0000${group}`;
}

/** `manifestPath␀name␀kind␀group`. */
export function rowKey(manifestPath: string, name: string, kind: DependencyKind | string, group: string): string {
  return `${manifestPath}\u0000${dependencyKey(name, kind, group)}`;
}

async function readCurrentVersions(
  manifest: DetectedManifest,
  dependencies: ReadonlyArray<{ name: string; declared: string }>,
  reader: SnapshotReader,
  lockCache: LockfileCache | null | undefined,
): Promise<LockfileVersions | null> {
  const lockfilePath = manifest.lockfilePath;
  if (!lockfilePath || manifest.packageManager === "PIP" || manifest.packageManager === "NONE") return null;
  const input = { packageManager: manifest.packageManager, lockfilePath, importer: manifest.lockfileImporter, dependencies };
  // Binary: nothing to read (the reader returns the "switch to bun.lock" warning).
  if (lockfilePath.endsWith(".lockb")) return readLockfile({ ...input, text: "" });
  const sha = reader.sha(lockfilePath);
  const key = sha ? lockfileCacheKey(sha, manifest.lockfileImporter, dependencies) : null;
  if (key && lockCache) {
    const cached = await lockCache.get(key);
    if (cached) return cached;
  }
  const text = await reader.read(lockfilePath, MAX_LOCKFILE_BYTES);
  if (text === null) {
    return { versions: new Map(), formatVersion: null, warnings: [`${lockfilePath} could not be read (larger than 20 MiB?): current versions are taken from the declared ranges`] };
  }
  const result = readLockfile({ ...input, text });
  if (key && lockCache) await lockCache.set(key, result);
  return result;
}

/**
 * Detects and parses every manifest of a snapshot. Unchanged files come from the blob cache (by SHA) and unchanged
 * lockfiles from the lockfile cache, so only changed blobs are downloaded; every manifest is re-parsed (cheap),
 * which keeps the results right when only the lockfile, the policy or the registry changed.
 */
export async function analyzeProject(params: {
  entries: readonly GitTreeEntry[];
  manifestPaths: readonly string[];
  reader: SnapshotReader;
  lockCache?: LockfileCache | null;
  truncated?: boolean;
}): Promise<ProjectAnalysis> {
  const { reader } = params;
  const tree = params.entries.map((entry) => ({
    path: entry.path,
    type: entry.type,
    sha: entry.sha,
    ...(entry.size !== null ? { size: entry.size } : {}),
  }));
  const detection = detectManifests(tree, { manifestPaths: params.manifestPaths });
  const files = await reader.readMany(detection.filesToRead, MAX_MANIFEST_BYTES);
  const resolved = resolveManifestGroups(detection, files);
  const warnings = [...resolved.warnings];
  if (params.truncated) warnings.push("The repository tree is too large: only part of it was searched for manifests");
  const manifestPaths = new Set(resolved.manifests.map((manifest) => manifest.path));

  const manifests: AnalyzedManifest[] = [];
  for (const detected of resolved.manifests) {
    const manifestWarnings = [...detected.warnings];
    let parsed: ParsedDependency[] = [];
    let requiresPython: string | null = null;
    let requiresPythonSyntax: "pep440" | "poetry" = "pep440";
    const fallbackVersions = new Map<string, string>();
    const text = files.get(detected.path) ?? (await reader.read(detected.path));
    if (text === null) {
      manifestWarnings.push(`${detected.path} could not be read (larger than 1 MiB?)`);
    } else {
      try {
        if (detected.format === "package.json") parsed = parsePackageJson(text, detected.path).dependencies;
        else if (detected.format === "pyproject") {
          const pyproject = parsePyproject(text, detected.path);
          parsed = pyproject.dependencies;
          requiresPython = pyproject.requiresPython;
          requiresPythonSyntax = pyproject.requiresPythonSyntax;
          manifestWarnings.push(...pyproject.warnings);
        } else {
          const skipPaths = new Set([...manifestPaths].filter((path) => path !== detected.path));
          const tree = await parseRequirementsTree(detected.path, (path) => reader.read(path), { text, skipPaths });
          parsed = tree.dependencies;
          manifestWarnings.push(...tree.warnings);
          for (const dependency of tree.dependencies as RequirementDependency[]) {
            if (dependency.pinnedVersion && !fallbackVersions.has(dependency.name)) fallbackVersions.set(dependency.name, dependency.pinnedVersion);
          }
          for (const [name, version] of tree.constraints) if (!fallbackVersions.has(name)) fallbackVersions.set(name, version);
        }
      } catch (error) {
        if (!isManifestParseError(error)) throw error;
        manifestWarnings.push(error.message);
        parsed = [];
      }
    }

    // One row per (name, kind, group): the first declaration wins (requirements may repeat a name with markers).
    const unique = new Map<string, ParsedDependency>();
    for (const dependency of parsed) {
      const key = dependencyKey(dependency.name, dependency.kind, dependency.group);
      if (!unique.has(key)) unique.set(key, dependency);
    }
    const list = [...unique.values()];
    const lock = await readCurrentVersions(
      detected,
      list.map((d) => ({ name: d.name, declared: d.declared })),
      reader,
      params.lockCache,
    );
    if (lock) manifestWarnings.push(...lock.warnings);

    manifests.push({
      detected,
      dependencies: list.map((dependency) => ({
        dependency,
        ecosystem: detected.ecosystem,
        currentVersion: lock?.versions.get(dependency.name) ?? fallbackVersions.get(dependency.name) ?? null,
      })),
      requiresPython,
      requiresPythonSyntax,
      lockfileFormatVersion: lock?.formatVersion ?? null,
      warnings: [...new Set(manifestWarnings)],
    });
  }
  return { manifests, warnings };
}

/** Keeps at most `max` dependencies across the manifests (in manifest order); adds a warning when some were cut. */
export function capDependencies(analysis: ProjectAnalysis, max: number): ProjectAnalysis {
  const total = analysis.manifests.reduce((sum, manifest) => sum + manifest.dependencies.length, 0);
  if (total <= max) return analysis;
  let left = max;
  const manifests = analysis.manifests.map((manifest) => {
    const kept = manifest.dependencies.slice(0, Math.max(0, left));
    left -= kept.length;
    return { ...manifest, dependencies: kept };
  });
  return {
    manifests,
    warnings: [...analysis.warnings, `${total} dependencies found; only the first ${max} are checked`],
  };
}

// ─── Registries and policy ─────────────────────────────────────────────────

export type RegistryLookupFn = (ecosystem: DependencyEcosystem, name: string, signal?: AbortSignal) => Promise<RegistryLookup>;

export function registryKey(ecosystem: DependencyEcosystem, name: string): string {
  return `${ecosystem}:${name}`;
}

/**
 * Looks every distinct `(ecosystem, name)` up once, at most {@link REGISTRY_CONCURRENCY} in flight. A
 * `RegistryUnavailableError` propagates (the caller retries the job, keeping the previous results).
 */
export async function lookupRegistries(
  items: ReadonlyArray<{ ecosystem: DependencyEcosystem; name: string }>,
  lookup: RegistryLookupFn,
  signal?: AbortSignal,
): Promise<Map<string, RegistryLookup>> {
  const unique = new Map<string, { ecosystem: DependencyEcosystem; name: string }>();
  for (const item of items) unique.set(registryKey(item.ecosystem, item.name), item);
  const keys = [...unique.keys()];
  const results = await mapWithConcurrency(keys, (key) => {
    const item = unique.get(key)!;
    return lookup(item.ecosystem, item.name, signal);
  }, REGISTRY_CONCURRENCY);
  return new Map(keys.map((key, index) => [key, results[index]!]));
}

export interface ProjectPolicySource {
  maxUpdateLevel: DepsPolicy["maxUpdateLevel"];
  includePrereleases: boolean;
  minReleaseAgeDays: number;
  rangeStrategy: DepsPolicy["rangeStrategy"];
  ignoreRules: unknown;
}

/** Stored ignore rules, validated (invalid JSON → no rules). */
export function parseIgnoreRules(value: unknown): IgnoreRule[] {
  const parsed = ignoreRulesSchema.safeParse(value);
  return parsed.success ? parsed.data : [];
}

export interface PlannedDependency extends AnalyzedDependency {
  manifest: AnalyzedManifest;
  selection: TargetSelection;
  lookup: RegistryLookup | null;
  /** Registry entry of the target (PyPI hashes), when OUTDATED. */
  targetRelease: RegistryVersion | null;
  sourceRepoUrl: string | null;
}

/** Runs `selectTarget` for every dependency of the analysis. `dismissed`: rowKey → dismissed target version. */
export function planAnalysis(
  manifests: readonly AnalyzedManifest[],
  lookups: ReadonlyMap<string, RegistryLookup>,
  project: ProjectPolicySource,
  dismissed: ReadonlyMap<string, string>,
  now: Date,
  filter?: (manifest: AnalyzedManifest, dependency: AnalyzedDependency) => boolean,
): PlannedDependency[] {
  const ignoreRules = parseIgnoreRules(project.ignoreRules);
  const out: PlannedDependency[] = [];
  for (const manifest of manifests) {
    const policy: DepsPolicy = {
      maxUpdateLevel: project.maxUpdateLevel,
      includePrereleases: project.includePrereleases,
      minReleaseAgeDays: project.minReleaseAgeDays,
      rangeStrategy: project.rangeStrategy,
      ignoreRules,
      requiresPython: manifest.requiresPython,
      requiresPythonSyntax: manifest.requiresPythonSyntax,
    };
    const items = manifest.dependencies.filter((dependency) => !filter || filter(manifest, dependency));
    const inputs = items.map((item) => {
      const { dependency } = item;
      const lookup = dependency.supported ? (lookups.get(registryKey(item.ecosystem, dependency.name)) ?? null) : null;
      return {
        item,
        lookup,
        input: {
          dependency: {
            ecosystem: item.ecosystem,
            name: dependency.name,
            kind: dependency.kind,
            declared: dependency.declared,
            rangeSyntax: dependency.rangeSyntax,
            currentVersion: item.currentVersion,
            supported: dependency.supported,
            ...(dependency.unsupportedReason ? { unsupportedReason: dependency.unsupportedReason } : {}),
            dismissedVersion: dismissed.get(rowKey(manifest.detected.path, dependency.name, dependency.kind, dependency.group)) ?? null,
          },
          candidates: !dependency.supported ? [] : lookup?.found ? lookup.package.versions : null,
          ...(lookup && !lookup.found ? { notFoundReason: lookup.reason } : {}),
        },
      };
    });
    const selections = applyPolicy(inputs.map((entry) => entry.input), policy, now);
    inputs.forEach(({ item, lookup }, index) => {
      const selection = selections[index]!;
      const pkg = lookup?.found ? lookup.package : null;
      out.push({
        ...item,
        manifest,
        selection,
        lookup,
        targetRelease: selection.targetVersion && pkg ? (pkg.versions.find((v) => v.version === selection.targetVersion) ?? null) : null,
        sourceRepoUrl: pkg?.sourceRepoUrl ?? null,
      });
    });
  }
  return out;
}

/**
 * Manifest detection (Slice 08 §3.2 step 1), in two steps so the worker can batch its GitHub reads:
 *
 * 1. {@link detectManifests}`(tree, opts)` looks at paths only: it picks the candidate manifests (skips, cap,
 *    `manifestPaths` override) and lists in `filesToRead` every file whose text step 2 needs (the candidates, their
 *    ancestor `package.json` / `pnpm-workspace.yaml` / uv workspace `pyproject.toml`, and the `.in` source of a
 *    possible pip-compile output).
 * 2. {@link resolveManifestGroups}`(detection, files)` takes those texts (a `Map` or record; missing entries are
 *    treated as unreadable) and returns the manifests with package manager, lockfile, workspace root and warnings.
 *
 * {@link detectManifestsWithReader} chains both with an async `readFile(path)`.
 */
import { parse as parseToml } from "smol-toml";
import { parse as parseYaml } from "yaml";
import { MAX_MANIFESTS_PER_PROJECT } from "./limits.js";
import { hasPipCompileHeader } from "./manifests/requirements.js";
import type { DependencyEcosystem, PackageManager } from "./types.js";
import { basename, dirname, isRecord, joinPath, matchesWorkspaceGlobs, relativeTo } from "./util.js";

/** One entry of a Git tree (`GET /git/trees/:sha?recursive=1`). Only `blob` entries are considered. */
export interface RepoTreeEntry {
  path: string;
  type: "blob" | "tree" | "commit" | string;
  sha?: string;
  size?: number;
}

export type ManifestFormat = "package.json" | "pyproject" | "requirements";

export interface ManifestCandidate {
  path: string;
  format: ManifestFormat;
  ecosystem: DependencyEcosystem;
  blobSha: string | null;
  size: number | null;
}

export interface ManifestDetection {
  candidates: ManifestCandidate[];
  /** Files whose text {@link resolveManifestGroups} needs (sorted, unique). */
  filesToRead: string[];
  warnings: string[];
  /** Blob paths of the tree → `{ sha, size }` (lockfile lookups in step 2). */
  blobs: ReadonlyMap<string, { sha: string | null; size: number | null }>;
}

export interface DetectedManifest {
  /** Repo-relative manifest path (for pip-tools: the `.in` source when it exists). */
  path: string;
  format: ManifestFormat;
  ecosystem: DependencyEcosystem;
  packageManager: PackageManager;
  /** Lockfile to read current versions from (shared root lockfile for workspace members), or `null`. */
  lockfilePath: string | null;
  /** Manifest directory relative to the lockfile directory (`""` = same directory): the lockfile importer. */
  lockfileImporter: string;
  /** Root manifest path for workspace members, else `null`. */
  workspaceRoot: string | null;
  /** For a workspace root: its member manifest paths (sorted). */
  workspaceMembers: string[];
  /** `pnpm-workspace.yaml` of the workspace, if any (the sandbox needs it). */
  workspaceConfigPath: string | null;
  blobSha: string | null;
  lockfileBlobSha: string | null;
  /** Set when update PRs are impossible for this manifest (Yarn, `bun.lockb`, pip-tools). */
  checkOnlyReason: string | null;
  warnings: string[];
}

export interface DetectOptions {
  /** User override: only these paths (no skips, no cap). Empty / absent = auto-detect. */
  manifestPaths?: readonly string[];
  /** Defaults to {@link MAX_MANIFESTS_PER_PROJECT}. */
  maxManifests?: number;
}

/** Directory names never searched for manifests. */
export const SKIPPED_DIRECTORIES: ReadonlySet<string> = new Set([
  "node_modules",
  ".venv",
  "venv",
  "vendor",
  "dist",
  "build",
  ".git",
  "fixtures",
  "__fixtures__",
  "testdata",
  "examples",
]);

/** npm lockfiles by preference (§3.2: `pnpm-lock.yaml` > `bun.lock` > `bun.lockb` > `yarn.lock` > `package-lock.json`). */
const NPM_LOCKFILES: ReadonlyArray<{ file: string; manager: PackageManager }> = [
  { file: "pnpm-lock.yaml", manager: "PNPM" },
  { file: "bun.lock", manager: "BUN" },
  { file: "bun.lockb", manager: "BUN" },
  { file: "yarn.lock", manager: "YARN" },
  { file: "npm-shrinkwrap.json", manager: "NPM" },
  { file: "package-lock.json", manager: "NPM" },
];

export const BUN_LOCKB_WARNING = "bun.lockb is binary: switch to the text bun.lock";
export const YARN_WARNING = "Yarn: check only (update pull requests are not supported for Yarn)";
export const PIP_TOOLS_WARNING = "pip-compile output: check only (recompile it with pip-compile)";

/** Format of a manifest file name, or `null`. Auto-detect accepts `requirements*.txt`, `requirements/*.txt`, `constraints*.txt`. */
export function manifestFormatOf(path: string, explicit = false): ManifestFormat | null {
  const file = basename(path);
  if (file === "package.json") return "package.json";
  if (file === "pyproject.toml") return "pyproject";
  if (/^requirements.*\.txt$/i.test(file) || /^constraints.*\.txt$/i.test(file)) return "requirements";
  if (/\.txt$/i.test(file) && basename(dirname(path)) === "requirements") return "requirements";
  if (explicit && /\.(?:txt|in)$/i.test(file)) return "requirements";
  return null;
}

function isSkipped(path: string): boolean {
  const segments = path.split("/");
  segments.pop();
  return segments.some((segment) => SKIPPED_DIRECTORIES.has(segment));
}

function depth(path: string): number {
  return path.split("/").length;
}

/** Ancestor directories of `dir`, nearest first, root (`""`) last. Includes `dir` itself when `inclusive`. */
function ancestors(dir: string, inclusive: boolean): string[] {
  const out: string[] = [];
  let current = dir;
  if (inclusive) out.push(current);
  while (current !== "") {
    current = dirname(current);
    out.push(current);
  }
  return out;
}

/** Step 1: candidates and the files to read. Pure, paths only. */
export function detectManifests(tree: readonly RepoTreeEntry[], options: DetectOptions = {}): ManifestDetection {
  const blobs = new Map<string, { sha: string | null; size: number | null }>();
  for (const entry of tree) {
    if (entry.type !== "blob") continue;
    blobs.set(entry.path, { sha: entry.sha ?? null, size: entry.size ?? null });
  }
  const warnings: string[] = [];
  const explicit = (options.manifestPaths ?? []).map((path) => path.trim().replace(/^\/+/, "")).filter(Boolean);
  let candidates: ManifestCandidate[] = [];

  const toCandidate = (path: string, format: ManifestFormat): ManifestCandidate => {
    const blob = blobs.get(path);
    return {
      path,
      format,
      ecosystem: format === "package.json" ? "NPM" : "PYPI",
      blobSha: blob?.sha ?? null,
      size: blob?.size ?? null,
    };
  };

  if (explicit.length > 0) {
    for (const path of [...new Set(explicit)]) {
      const format = manifestFormatOf(path, true);
      if (!format) warnings.push(`${path} is not a supported manifest (package.json, pyproject.toml, requirements .txt / .in)`);
      else if (!blobs.has(path)) warnings.push(`${path} was not found on the default branch`);
      else candidates.push(toCandidate(path, format));
    }
  } else {
    for (const path of blobs.keys()) {
      if (isSkipped(path)) continue;
      const format = manifestFormatOf(path);
      if (format) candidates.push(toCandidate(path, format));
    }
    candidates.sort((a, b) => depth(a.path) - depth(b.path) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const max = options.maxManifests ?? MAX_MANIFESTS_PER_PROJECT;
    if (candidates.length > max) {
      warnings.push(
        `${candidates.length} manifests found; only the ${max} shallowest are checked. Set manifest paths to choose.`,
      );
      candidates = candidates.slice(0, max);
    }
  }
  candidates.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const filesToRead = new Set<string>();
  for (const candidate of candidates) {
    filesToRead.add(candidate.path);
    const dir = dirname(candidate.path);
    if (candidate.format === "package.json") {
      for (const ancestor of ancestors(dir, true)) {
        const pkg = joinPath(ancestor, "package.json");
        const workspace = joinPath(ancestor, "pnpm-workspace.yaml");
        if (blobs.has(pkg)) filesToRead.add(pkg);
        if (blobs.has(workspace)) filesToRead.add(workspace);
      }
    } else if (candidate.format === "pyproject") {
      for (const ancestor of ancestors(dir, false)) {
        const pyproject = joinPath(ancestor, "pyproject.toml");
        if (blobs.has(joinPath(ancestor, "uv.lock")) && blobs.has(pyproject)) filesToRead.add(pyproject);
      }
    } else if (/\.txt$/i.test(candidate.path)) {
      const source = candidate.path.replace(/\.txt$/i, ".in");
      if (blobs.has(source)) filesToRead.add(source);
    }
  }
  return { candidates, filesToRead: [...filesToRead].sort(), warnings, blobs };
}

type FileSource = ReadonlyMap<string, string> | Readonly<Record<string, string>>;

function lookup(files: FileSource, path: string): string | null {
  if (files instanceof Map) return (files as ReadonlyMap<string, string>).get(path) ?? null;
  const record = files as Readonly<Record<string, string>>;
  return Object.prototype.hasOwnProperty.call(record, path) ? (record[path] ?? null) : null;
}

function parseJsonObject(text: string | null): Record<string, unknown> | null {
  if (text === null) return null;
  try {
    const data: unknown = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
    return isRecord(data) ? data : null;
  } catch {
    return null;
  }
}

function parseTomlObject(text: string | null): Record<string, unknown> | null {
  if (text === null) return null;
  try {
    return parseToml(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function workspaceGlobs(pkg: Record<string, unknown> | null): string[] {
  const field = pkg?.workspaces;
  const list = Array.isArray(field) ? field : isRecord(field) && Array.isArray(field.packages) ? field.packages : [];
  return list.filter((glob): glob is string => typeof glob === "string");
}

function pnpmWorkspaceGlobs(text: string | null): string[] {
  if (text === null) return [];
  try {
    const data: unknown = parseYaml(text);
    if (!isRecord(data) || !Array.isArray(data.packages)) return [];
    return data.packages.filter((glob): glob is string => typeof glob === "string");
  } catch {
    return [];
  }
}

/** `"pnpm@9.12.0+sha512…"` → `PNPM`. */
export function packageManagerFromField(field: unknown): PackageManager | null {
  if (typeof field !== "string") return null;
  const name = field.split("@")[0]?.trim().toLowerCase();
  if (name === "pnpm") return "PNPM";
  if (name === "yarn") return "YARN";
  if (name === "npm") return "NPM";
  if (name === "bun") return "BUN";
  return null;
}

interface NpmRootInfo {
  packageManager: PackageManager;
  lockfilePath: string | null;
  warnings: string[];
  checkOnlyReason: string | null;
}

function npmRootInfo(dir: string, pkg: Record<string, unknown> | null, blobs: ManifestDetection["blobs"]): NpmRootInfo {
  const fromField = packageManagerFromField(pkg?.packageManager);
  const present = NPM_LOCKFILES.filter(({ file }) => blobs.has(joinPath(dir, file)));
  let packageManager: PackageManager;
  let lockfile: { file: string; manager: PackageManager } | undefined;
  if (fromField) {
    packageManager = fromField;
    lockfile = present.find((entry) => entry.manager === fromField);
  } else {
    lockfile = present[0];
    packageManager = lockfile?.manager ?? "NONE";
  }
  const warnings: string[] = [];
  let checkOnlyReason: string | null = null;
  if (packageManager === "YARN") {
    warnings.push(YARN_WARNING);
    checkOnlyReason = "Yarn projects are check only: update pull requests are not supported";
  } else if (packageManager === "BUN" && lockfile?.file === "bun.lockb") {
    warnings.push(BUN_LOCKB_WARNING);
    checkOnlyReason = "bun.lockb is binary and cannot be regenerated: switch to the text bun.lock";
  }
  if (fromField && !lockfile && present.length > 0) {
    warnings.push(`packageManager is ${fromField.toLowerCase()} but only ${present.map((p) => p.file).join(", ")} exists`);
  }
  return { packageManager, lockfilePath: lockfile ? joinPath(dir, lockfile.file) : null, warnings, checkOnlyReason };
}

/** Step 2: resolves package managers, lockfiles and workspaces from the texts of `detection.filesToRead`. */
export function resolveManifestGroups(
  detection: ManifestDetection,
  files: FileSource,
): { manifests: DetectedManifest[]; warnings: string[] } {
  const { blobs } = detection;
  const warnings = [...detection.warnings];
  const manifests: DetectedManifest[] = [];
  const sha = (path: string | null): string | null => (path ? (blobs.get(path)?.sha ?? null) : null);
  const pkgCache = new Map<string, Record<string, unknown> | null>();
  const pkgAt = (dir: string): Record<string, unknown> | null => {
    const path = joinPath(dir, "package.json");
    if (!pkgCache.has(path)) pkgCache.set(path, parseJsonObject(lookup(files, path)));
    return pkgCache.get(path) ?? null;
  };

  for (const candidate of detection.candidates) {
    const dir = dirname(candidate.path);
    const text = lookup(files, candidate.path);
    const base = {
      path: candidate.path,
      format: candidate.format,
      ecosystem: candidate.ecosystem,
      blobSha: candidate.blobSha,
      workspaceMembers: [] as string[],
      workspaceConfigPath: null as string | null,
      workspaceRoot: null as string | null,
      lockfileImporter: "",
      checkOnlyReason: null as string | null,
    };
    if (text === null) warnings.push(`${candidate.path} could not be read`);

    if (candidate.format === "package.json") {
      // Workspace membership: nearest ancestor whose package.json `workspaces` or pnpm-workspace.yaml lists it.
      let rootDir: string | null = null;
      let workspaceConfigPath: string | null = null;
      for (const ancestor of ancestors(dir, false)) {
        const relative = relativeTo(dir, ancestor);
        const pnpmPath = joinPath(ancestor, "pnpm-workspace.yaml");
        const pnpmGlobs = pnpmWorkspaceGlobs(lookup(files, pnpmPath));
        if (matchesWorkspaceGlobs(relative, workspaceGlobs(pkgAt(ancestor))) || matchesWorkspaceGlobs(relative, pnpmGlobs)) {
          rootDir = ancestor;
          workspaceConfigPath = blobs.has(pnpmPath) ? pnpmPath : null;
          break;
        }
      }
      const ownPnpm = joinPath(dir, "pnpm-workspace.yaml");
      const lockDir = rootDir ?? dir;
      const info = npmRootInfo(lockDir, pkgAt(lockDir), blobs);
      const rootManifest = rootDir === null ? null : joinPath(rootDir, "package.json");
      manifests.push({
        ...base,
        packageManager: info.packageManager,
        lockfilePath: info.lockfilePath,
        lockfileBlobSha: sha(info.lockfilePath),
        lockfileImporter: relativeTo(dir, lockDir),
        workspaceRoot: rootManifest !== null && blobs.has(rootManifest) ? rootManifest : null,
        workspaceConfigPath: rootDir === null ? (blobs.has(ownPnpm) ? ownPnpm : null) : workspaceConfigPath,
        checkOnlyReason: info.checkOnlyReason,
        warnings: info.warnings,
      });
      continue;
    }

    if (candidate.format === "pyproject") {
      const data = parseTomlObject(text);
      const tool = isRecord(data?.tool) ? data.tool : null;
      const hasPoetry = tool !== null && isRecord(tool.poetry);
      const hasUv = tool !== null && isRecord(tool.uv);
      const manifestWarnings: string[] = [];
      if (text !== null && data === null) manifestWarnings.push(`${candidate.path} is not valid TOML`);
      const poetryLock = joinPath(dir, "poetry.lock");
      const uvLock = joinPath(dir, "uv.lock");
      let packageManager: PackageManager = "NONE";
      let lockfilePath: string | null = null;
      let workspaceRoot: string | null = null;
      let lockfileImporter = "";
      if (hasPoetry || blobs.has(poetryLock)) {
        packageManager = "POETRY";
        lockfilePath = blobs.has(poetryLock) ? poetryLock : null;
      } else if (blobs.has(uvLock)) {
        packageManager = "UV";
        lockfilePath = uvLock;
      } else {
        // uv workspace member: an ancestor with uv.lock whose `[tool.uv.workspace] members` list it.
        for (const ancestor of ancestors(dir, false)) {
          const rootPyproject = joinPath(ancestor, "pyproject.toml");
          const rootLock = joinPath(ancestor, "uv.lock");
          if (!blobs.has(rootLock)) continue;
          const rootData = parseTomlObject(lookup(files, rootPyproject));
          const rootTool = isRecord(rootData?.tool) ? rootData.tool : null;
          const rootUv = rootTool && isRecord(rootTool.uv) ? rootTool.uv : null;
          const workspace = rootUv && isRecord(rootUv.workspace) ? rootUv.workspace : null;
          if (!workspace) continue;
          const strings = (value: unknown): string[] =>
            Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
          const relative = relativeTo(dir, ancestor);
          const excluded = strings(workspace.exclude);
          if (matchesWorkspaceGlobs(relative, strings(workspace.members)) && !matchesWorkspaceGlobs(relative, excluded)) {
            packageManager = "UV";
            lockfilePath = rootLock;
            workspaceRoot = blobs.has(rootPyproject) ? rootPyproject : null;
            lockfileImporter = relative;
            break;
          }
        }
        if (packageManager === "NONE" && hasUv) packageManager = "UV";
      }
      manifests.push({
        ...base,
        packageManager,
        lockfilePath,
        lockfileBlobSha: sha(lockfilePath),
        lockfileImporter,
        workspaceRoot,
        warnings: manifestWarnings,
      });
      continue;
    }

    // requirements
    if (text !== null && /\.txt$/i.test(candidate.path) && hasPipCompileHeader(text)) {
      const source = candidate.path.replace(/\.txt$/i, ".in");
      const hasSource = blobs.has(source);
      manifests.push({
        ...base,
        path: hasSource ? source : candidate.path,
        blobSha: hasSource ? sha(source) : candidate.blobSha,
        packageManager: "PIP_TOOLS",
        lockfilePath: hasSource ? candidate.path : null,
        lockfileBlobSha: hasSource ? candidate.blobSha : null,
        checkOnlyReason: "pip-compile output is check only: recompile it with pip-compile",
        warnings: [PIP_TOOLS_WARNING],
      });
      continue;
    }
    manifests.push({ ...base, packageManager: "PIP", lockfilePath: null, lockfileBlobSha: null, warnings: [] });
  }

  // Workspace roots list their members; a pip-tools `.in` may also be a candidate on its own (explicit paths).
  const byPath = new Map<string, DetectedManifest>();
  for (const manifest of manifests) if (!byPath.has(manifest.path)) byPath.set(manifest.path, manifest);
  for (const manifest of byPath.values()) {
    if (!manifest.workspaceRoot) continue;
    const root = byPath.get(manifest.workspaceRoot);
    if (root) root.workspaceMembers.push(manifest.path);
  }
  for (const manifest of byPath.values()) manifest.workspaceMembers.sort();
  return { manifests: [...byPath.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)), warnings };
}

/** Steps 1 + 2 with an async reader (`null` = missing / unreadable). Reads `filesToRead` concurrently. */
export async function detectManifestsWithReader(
  tree: readonly RepoTreeEntry[],
  readFile: (path: string) => Promise<string | null>,
  options: DetectOptions = {},
): Promise<{ manifests: DetectedManifest[]; warnings: string[]; files: Map<string, string> }> {
  const detection = detectManifests(tree, options);
  const files = new Map<string, string>();
  await Promise.all(
    detection.filesToRead.map(async (path) => {
      const text = await readFile(path);
      if (text !== null) files.set(path, text);
    }),
  );
  return { ...resolveManifestGroups(detection, files), files };
}

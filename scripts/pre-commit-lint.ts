import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { extname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const FORMAT_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  ".css",
  ".md",
  ".yml",
  ".yaml",
]);
const LINT_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const BATCH_SIZE = 100;

export interface StagedLintBuckets {
  formatFiles: string[];
  lintFiles: string[];
}

export type ExecRunner = (toolArgs: readonly string[], cwd: string) => number;

function toPosixPath(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}

function isIgnoredPath(relPath: string): boolean {
  const norm = toPosixPath(relPath).replace(/^\.\//, "");
  return (
    !norm ||
    norm.startsWith("node_modules/") ||
    norm.includes("/node_modules/") ||
    norm.startsWith("dist/") ||
    norm.includes("/dist/") ||
    norm.startsWith(".next/") ||
    norm.includes("/.next/") ||
    norm.startsWith(".turbo/") ||
    norm.includes("/.turbo/") ||
    norm.startsWith("coverage/") ||
    norm.includes("/coverage/") ||
    norm.startsWith("packages/db/src/generated/") ||
    norm === "next-env.d.ts" ||
    norm.endsWith("/next-env.d.ts") ||
    norm === "pnpm-lock.yaml" ||
    norm === "CHANGELOG.md" ||
    norm.startsWith("docs/")
  );
}

/** Partitions staged repository-relative paths into Oxfmt and Oxlint file buckets. */
export function partitionStagedFiles(paths: readonly string[]): StagedLintBuckets {
  const formatFiles: string[] = [];
  const lintFiles: string[] = [];
  const seen = new Set<string>();

  for (const rawPath of paths) {
    const relPath = toPosixPath(rawPath).replace(/^\.\//, "").trim();
    if (!relPath || seen.has(relPath) || isIgnoredPath(relPath)) continue;
    seen.add(relPath);

    const ext = extname(relPath).toLowerCase();
    if (FORMAT_EXTENSIONS.has(ext)) formatFiles.push(relPath);
    if (LINT_EXTENSIONS.has(ext)) lintFiles.push(relPath);
  }

  return { formatFiles, lintFiles };
}

function getStagedFiles(repoRoot: string): string[] {
  const out = execFileSync("git", ["diff", "--cached", "--name-only", "--diff-filter=ACM"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  return out
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && existsSync(resolve(repoRoot, line)));
}

function runPnpmExec(toolArgs: readonly string[], cwd: string): number {
  const npmExecPath = process.env.npm_execpath;
  if (npmExecPath && /\.(?:cjs|mjs|js)$/i.test(npmExecPath)) {
    const res = spawnSync(process.execPath, [npmExecPath, "exec", ...toolArgs], {
      cwd,
      stdio: "inherit",
    });
    return res.status ?? 1;
  }

  if (process.platform === "win32") {
    const res = spawnSync("cmd.exe", ["/d", "/s", "/c", "pnpm", "exec", ...toolArgs], {
      cwd,
      stdio: "inherit",
    });
    return res.status ?? 1;
  }

  const res = spawnSync("pnpm", ["exec", ...toolArgs], {
    cwd,
    stdio: "inherit",
  });
  return res.status ?? 1;
}

function runInBatches(baseArgs: readonly string[], files: readonly string[], cwd: string, runner: ExecRunner): number {
  for (let i = 0; i < files.length; i += BATCH_SIZE) {
    const status = runner([...baseArgs, ...files.slice(i, i + BATCH_SIZE)], cwd);
    if (status !== 0) return status;
  }
  return 0;
}

/** Runs `oxfmt --check` and `oxlint` on staged files, returning exit code `0` on success. */
export function runPreCommitLint(
  deps: {
    cwd?: string;
    getStaged?: (cwd: string) => string[];
    runner?: ExecRunner;
    log?: (msg: string) => void;
  } = {},
): number {
  const cwd = deps.cwd ?? process.cwd();
  const staged = (deps.getStaged ?? getStagedFiles)(cwd);
  const runner = deps.runner ?? runPnpmExec;
  const log = deps.log ?? ((msg: string) => console.log(msg));

  const { formatFiles, lintFiles } = partitionStagedFiles(staged);
  if (formatFiles.length === 0 && lintFiles.length === 0) {
    log("[pre-commit] No staged code or config files to format/lint.");
    return 0;
  }

  if (formatFiles.length > 0) {
    log(`[pre-commit] Checking formatting on ${formatFiles.length} staged file(s)...`);
    const fmtStatus = runInBatches(["oxfmt", "--check"], formatFiles, cwd, runner);
    if (fmtStatus !== 0) return fmtStatus;
  }

  if (lintFiles.length > 0) {
    log(`[pre-commit] Linting ${lintFiles.length} staged file(s)...`);
    const lintStatus = runInBatches(["oxlint"], lintFiles, cwd, runner);
    if (lintStatus !== 0) return lintStatus;
  }

  return 0;
}

function isDirectExecution(metaUrl: string): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  const entryUrl = pathToFileURL(resolve(entry)).href;
  return process.platform === "win32" ? entryUrl.toLowerCase() === metaUrl.toLowerCase() : entryUrl === metaUrl;
}

if (isDirectExecution(import.meta.url)) {
  const exitCode = runPreCommitLint();
  if (exitCode !== 0) {
    process.exit(exitCode);
  }
}

/**
 * One lockfile job (Slice 08 §3.10.2): a fresh temp dir, the uploaded files minus risky config, the package manager
 * with a minimal environment, a hard timeout that kills the whole process group, and the expected lockfile back.
 * The temp dir is always removed.
 *
 * Nothing here holds a secret: the child environment is built from scratch (no inherited variables), so
 * `DEPS_SANDBOX_TOKEN` and any `*_TOKEN` never reach a package manager.
 */
import { spawn as nodeSpawn } from "node:child_process";
import { constants as fsConstants, promises as fs } from "node:fs";
import path from "node:path";
import type { Readable } from "node:stream";
import { MAX_LOCKFILE_BYTES, MAX_SANDBOX_STDERR_TAIL_BYTES } from "@repopulse/deps/limits";
import type {
  LockErrorCode,
  ParsedLockRequest,
  ParsedLockResponse,
  SandboxPackageManager,
} from "@repopulse/deps/sandbox-contract";
import {
  buildCommands,
  checkToolVersions,
  LOCKFILE_NAMES,
  LockJobError,
  lockfileFormat,
  type CommandStep,
  type ToolVersions,
} from "./commands.js";

export const DEFAULT_TIMEOUT_MS = 300_000;
export const DEFAULT_EGRESS_PROXY = "http://deps-egress:3128";
/** Combined stdout + stderr kept per job (rolling: the newest output wins). */
export const MAX_CAPTURED_OUTPUT_BYTES = 1024 * 1024;
const DEFAULT_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

// ---------------------------------------------------------------------------------------------------------------
// Risky repository content
// ---------------------------------------------------------------------------------------------------------------

/** Config files that can redirect registries or run code. Deleted wherever they appear in the tree. */
const RISKY_CONFIG_FILES = new Set([
  ".npmrc",
  ".pnpmfile.cjs",
  ".pnpmfile.mjs",
  "bunfig.toml",
  ".bunfig.toml",
  "pip.conf",
  "pip.ini",
  "poetry.toml",
  "uv.toml",
]);

/** Directories that never belong in a lockfile job (installed code, VCS data, tool plugins). */
const STRIPPED_SEGMENTS = new Set(["node_modules", ".git", ".yarn", ".poetry", ".venv"]);

function isRiskyConfig(basename: string): boolean {
  return (
    RISKY_CONFIG_FILES.has(basename) ||
    basename.startsWith(".yarnrc") ||
    // Bun loads `.env*` files on its own (also passed `--no-env-file`).
    basename === ".env" ||
    basename.startsWith(".env.")
  );
}

const DEFAULT_REGISTRY_HOSTS = new Set([
  "registry.npmjs.org",
  "registry.npmjs.com",
  "registry.yarnpkg.com",
  "pypi.org",
  "files.pythonhosted.org",
]);

/** Whether a config value points at a default public registry (anything else counts as a custom registry). */
function isDefaultRegistryValue(value: string): boolean {
  const match = /https?:\/\/[^\s"',}\]]+/i.exec(value);
  if (!match) return false;
  try {
    return DEFAULT_REGISTRY_HOSTS.has(new URL(match[0]).hostname.toLowerCase());
  } catch {
    return false;
  }
}

/** Registry / index settings in a stripped config file (returns what was found, for the stderr tail). */
export function findConfigRegistries(basename: string, text: string): string[] {
  const found: string[] = [];
  const lines = text.split(/\r?\n/).filter((line) => !/^\s*[#;]/.test(line));
  const valueCheck = (re: RegExp, label: string) => {
    for (const line of lines) {
      const match = re.exec(line);
      if (match && !isDefaultRegistryValue(match[match.length - 1] ?? "")) {
        found.push(label);
        return;
      }
    }
  };
  const presence = (re: RegExp, label: string) => {
    if (lines.some((line) => re.test(line))) found.push(label);
  };

  if (basename === ".npmrc") {
    valueCheck(/^\s*(?:@[^:=\s]+:)?registry\s*=\s*(.*)$/i, "registry");
  } else if (basename === ".yarnrc") {
    valueCheck(/^\s*"?registry"?\s+(.*)$/i, "registry");
  } else if (basename.startsWith(".yarnrc")) {
    valueCheck(/^\s*npmRegistryServer\s*:\s*(.*)$/, "npmRegistryServer");
    presence(/^\s*npmScopes\s*:/, "npmScopes");
  } else if (basename === "bunfig.toml" || basename === ".bunfig.toml") {
    valueCheck(/^\s*registry\s*=\s*(.*)$/, "install.registry");
    presence(/^\s*\[\s*install\s*\.\s*scopes\s*\]/, "install.scopes");
  } else if (basename === "pip.conf" || basename === "pip.ini" || basename === "uv.toml") {
    valueCheck(/^\s*(index-url|extra-index-url|find-links)\s*=\s*(.*)$/, "index-url");
    presence(/^\s*\[\[?\s*index\s*\]\]?/, "[[index]]");
    presence(/^\s*index\s*=/, "index");
  } else if (basename === "poetry.toml") {
    presence(/^\s*\[\s*repositories\b/, "repositories");
  }
  return found;
}

/** Remove a TOML `#` comment that is not inside a basic or literal string. */
function stripTomlComment(line: string): string {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quote) {
      if (ch === "\\" && quote === '"') i++;
      else if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === "#") {
      return line.slice(0, i);
    }
  }
  return line;
}

function normalizeTomlKey(key: string): string {
  return key
    .split(".")
    .map((part) => part.trim().replace(/^["']|["']$/g, ""))
    .join(".");
}

/**
 * Custom indexes in a pyproject.toml: `[tool.uv.index]` / `[[tool.uv.index]]`, `[[tool.poetry.source]]`,
 * `[tool.uv] index-url / extra-index-url / find-links` (non-default), and inline-table forms of those.
 * Line-based on purpose (no TOML parser dependency): it errs towards reporting, and the egress proxy blocks any
 * non-allowlisted host it might miss.
 */
export function findPyprojectRegistries(text: string): string[] {
  const found = new Set<string>();
  let table = "";
  let multiline: string | null = null;
  const check = (key: string, value: string) => {
    if (/^tool\.uv\.index(?:\.|$)/.test(key)) found.add("[tool.uv.index]");
    else if (/^tool\.poetry\.source(?:\.|$)/.test(key)) found.add("[[tool.poetry.source]]");
    else if (/^tool\.uv(?:\.pip)?\.(?:index-url|extra-index-url|find-links)$/.test(key)) {
      if (!isDefaultRegistryValue(value)) found.add(key);
    } else if (
      /^tool(?:\.uv(?:\.pip)?|\.poetry)?$/.test(key) &&
      /\b(?:index|index-url|extra-index-url|find-links|source)\s*=/.test(value)
    ) {
      found.add(`${key} (inline table)`);
    }
  };

  for (const rawLine of text.split(/\r?\n/)) {
    if (multiline) {
      // Inside a multi-line string: nothing here is a table or key.
      if (rawLine.includes(multiline)) multiline = null;
      continue;
    }
    const line = stripTomlComment(rawLine).trim();
    if (!line) continue;
    const header = /^\[\[?\s*([^[\]]+?)\s*\]\]?$/.exec(line);
    if (header) {
      table = normalizeTomlKey(header[1]!);
      check(table, "");
      continue;
    }
    const kv = /^([A-Za-z0-9_."' -]+?)\s*=\s*(.*)$/.exec(line);
    if (!kv) continue;
    const value = kv[2]!;
    for (const delimiter of ['"""', "'''"]) {
      if (value.split(delimiter).length === 2) multiline = delimiter; // opened, not closed on this line
    }
    check((table ? `${table}.` : "") + normalizeTomlKey(kv[1]!), value);
  }
  return [...found];
}

/** Top-level `registry` / `registries` keys in pnpm-workspace.yaml (pnpm ≥ 10 reads settings from it). */
export function findPnpmWorkspaceRegistries(text: string): string[] {
  const found: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^(registry|registries)\s*:\s*(.*)$/.exec(line);
    if (!match) continue;
    if (match[1] === "registries" || !isDefaultRegistryValue(match[2] ?? "")) found.push(match[1]!);
  }
  return found;
}

export interface DecodedFile {
  path: string;
  content: Buffer;
}

export interface PreparedFiles {
  files: DecodedFile[];
  /** Repo-relative paths that were dropped (risky config or stripped directories). */
  stripped: string[];
  /** `path: what` for each custom registry / index found. Non-empty → `UNSUPPORTED_REGISTRY`. */
  registries: string[];
}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** Decode the uploaded files, drop risky config and directories, and collect custom registry settings. */
export function prepareFiles(files: readonly { path: string; contentBase64: string }[]): PreparedFiles {
  const out: PreparedFiles = { files: [], stripped: [], registries: [] };
  const seen = new Set<string>();
  for (const file of files) {
    if (file.contentBase64.length % 4 !== 0 || !BASE64.test(file.contentBase64)) {
      throw new LockJobError("BAD_REQUEST", "file content is not valid base64");
    }
    if (seen.has(file.path)) throw new LockJobError("BAD_REQUEST", "duplicate file path");
    seen.add(file.path);

    const segments = file.path.split("/");
    const basename = segments[segments.length - 1]!;
    const content = Buffer.from(file.contentBase64, "base64");
    if (segments.some((segment) => STRIPPED_SEGMENTS.has(segment))) {
      out.stripped.push(file.path);
      continue;
    }
    if (isRiskyConfig(basename)) {
      out.stripped.push(file.path);
      for (const what of findConfigRegistries(basename, content.toString("utf8"))) {
        out.registries.push(`${file.path}: ${what}`);
      }
      continue;
    }
    if (basename === "pyproject.toml") {
      for (const what of findPyprojectRegistries(content.toString("utf8"))) out.registries.push(`${file.path}: ${what}`);
    } else if (basename === "pnpm-workspace.yaml") {
      for (const what of findPnpmWorkspaceRegistries(content.toString("utf8"))) {
        out.registries.push(`${file.path}: ${what}`);
      }
    }
    out.files.push({ path: file.path, content });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Environment and output
// ---------------------------------------------------------------------------------------------------------------

export interface SandboxEnvOptions {
  /** Egress proxy URL, or `null` for none (tests). */
  proxy: string | null;
  /** `PATH` for the child (the server's own PATH). */
  path?: string;
}

/**
 * The complete child environment. Built from scratch: nothing is inherited, so no `*_TOKEN`, no
 * `DEPS_SANDBOX_TOKEN`, no `npm_config_*` from the server. Every cache and config dir is inside the job dir.
 */
export function buildSandboxEnv(jobDir: string, opts: SandboxEnvOptions): Record<string, string> {
  const home = path.join(jobDir, "home");
  const cache = path.join(jobDir, "cache");
  const env: Record<string, string> = {
    HOME: home,
    PATH: opts.path || DEFAULT_PATH,
    TMPDIR: path.join(jobDir, "tmp"),
    LANG: "C.UTF-8",
    CI: "1",
    NO_COLOR: "1",
    FORCE_COLOR: "0",
    DO_NOT_TRACK: "1",
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_CACHE_HOME: cache,
    XDG_DATA_HOME: path.join(home, ".local", "share"),
    XDG_STATE_HOME: path.join(home, ".local", "state"),
    // npm (pnpm also reads npm_config_*): no scripts, no user / global npmrc, cache in the job dir.
    npm_config_ignore_scripts: "true",
    npm_config_userconfig: path.join(home, ".npmrc"),
    npm_config_globalconfig: path.join(home, "npmrc-global"),
    npm_config_cache: path.join(cache, "npm"),
    npm_config_update_notifier: "false",
    npm_config_audit: "false",
    npm_config_fund: "false",
    // pnpm: never download another pnpm version for the `packageManager` field; store in the job dir.
    npm_config_manage_package_manager_versions: "false",
    pnpm_config_manage_package_manager_versions: "false",
    pnpm_config_store_dir: path.join(cache, "pnpm-store"),
    pnpm_config_cache_dir: path.join(cache, "pnpm"),
    // Bun
    BUN_INSTALL_CACHE_DIR: path.join(cache, "bun"),
    // uv: never build source distributions or download a Python.
    UV_NO_BUILD: "1",
    UV_PYTHON_DOWNLOADS: "never",
    UV_NO_PROGRESS: "1",
    UV_CACHE_DIR: path.join(cache, "uv"),
    // Poetry
    POETRY_NO_INTERACTION: "1",
    POETRY_CACHE_DIR: path.join(cache, "poetry"),
    POETRY_CONFIG_DIR: path.join(home, ".config", "pypoetry"),
    POETRY_DATA_DIR: path.join(home, ".local", "share", "pypoetry"),
    POETRY_VIRTUALENVS_CREATE: "false",
    // The image's rootfs is read-only.
    PYTHONDONTWRITEBYTECODE: "1",
  };
  if (opts.proxy) {
    env.HTTP_PROXY = opts.proxy;
    env.HTTPS_PROXY = opts.proxy;
    env.http_proxy = opts.proxy;
    env.https_proxy = opts.proxy;
  }
  return env;
}

/** Keeps the newest `limit` bytes of everything pushed into it. */
export class TailBuffer {
  private chunks: Buffer[] = [];
  private size = 0;

  constructor(private readonly limit = MAX_CAPTURED_OUTPUT_BYTES) {}

  push(chunk: Buffer | string): void {
    let buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    if (buf.length >= this.limit) {
      this.chunks = [buf.subarray(buf.length - this.limit)];
      this.size = this.limit;
      return;
    }
    this.chunks.push(buf);
    this.size += buf.length;
    while (this.size > this.limit) {
      buf = this.chunks[0]!;
      const excess = this.size - this.limit;
      if (buf.length <= excess) {
        this.chunks.shift();
        this.size -= buf.length;
      } else {
        this.chunks[0] = buf.subarray(excess);
        this.size -= excess;
      }
    }
  }

  get byteLength(): number {
    return this.size;
  }

  toString(): string {
    return Buffer.concat(this.chunks).toString("utf8");
  }
}

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|\u001b[@-Z\\-_]/g;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;
const KNOWN_TOKENS =
  /\b(?:npm_[A-Za-z0-9]{36}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|pypi-[A-Za-z0-9_-]{40,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|sk-[A-Za-z0-9_-]{20,})\b/g;
const SECRET_ASSIGNMENT =
  /\b([A-Za-z0-9_.:/-]*(?:_authToken|_auth|_password|token|secret|password|passwd|api[_-]?key|credentials?)[A-Za-z0-9_.-]*)(\s*[=:]\s*)("[^"]*"|'[^']*'|\S+)/gi;

/**
 * Make tool output safe for the job log: strip ANSI escapes and control characters, redact credentials in URLs,
 * bearer tokens, `token=` / `_authToken=` style assignments, well-known token shapes and long opaque strings,
 * replace the job dir with `<job>`, and keep the last {@link MAX_SANDBOX_STDERR_TAIL_BYTES} bytes.
 */
export function sanitizeOutput(raw: string, jobDir?: string, maxBytes = MAX_SANDBOX_STDERR_TAIL_BYTES): string {
  let text = raw.replace(ANSI, "").replace(/\r\n?/g, "\n").replace(CONTROL, "");
  if (jobDir) text = text.split(jobDir).join("<job>");
  text = text
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, "$1***@")
    .replace(/\b(Bearer|Basic|token)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 ***")
    .replace(KNOWN_TOKENS, "***")
    .replace(SECRET_ASSIGNMENT, "$1$2***")
    .replace(/\b[a-f0-9]{32,}\b/gi, "***")
    .replace(/[A-Za-z0-9+_-]{40,}={0,2}/g, (s) => (/\d/.test(s) && /[A-Za-z]/.test(s) ? "***" : s));
  text = text.replace(/\n{3,}/g, "\n\n").trim();

  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return text;
  // Cut on a byte boundary, then drop a partial leading character and the partial first line.
  let tail = buf.subarray(buf.length - maxBytes).toString("utf8").replace(/^�+/, "");
  const newline = tail.indexOf("\n");
  if (newline !== -1 && newline < 200) tail = tail.slice(newline + 1);
  return tail;
}

// ---------------------------------------------------------------------------------------------------------------
// Process control
// ---------------------------------------------------------------------------------------------------------------

/** The part of a ChildProcess the runner uses (lets tests pass fakes). */
export interface SpawnedProcess {
  readonly pid?: number | undefined;
  readonly stdout: Readable | null;
  readonly stderr: Readable | null;
  on(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  on(event: "error", listener: (err: Error) => void): unknown;
  kill(signal?: NodeJS.Signals | number): boolean;
}

export interface SpawnOptions {
  cwd: string;
  env: Record<string, string>;
  /** POSIX: start a new process group so a timeout can kill everything the tool started. */
  detached: boolean;
}

export type SpawnFn = (command: string, args: readonly string[], options: SpawnOptions) => SpawnedProcess;

export const defaultSpawn: SpawnFn = (command, args, options) =>
  nodeSpawn(command, [...args], {
    cwd: options.cwd,
    env: options.env,
    detached: options.detached,
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
    windowsHide: true,
  });

/** SIGKILL the child's process group (POSIX), falling back to the child itself. Never throws. */
export function killProcessTree(child: SpawnedProcess): void {
  if (child.pid && process.platform !== "win32") {
    try {
      process.kill(-child.pid, "SIGKILL");
      return;
    } catch {
      // ESRCH: the group is already gone; fall through to the child itself.
    }
  }
  try {
    child.kill("SIGKILL");
  } catch {
    // already exited
  }
}

type StepOutcome = { kind: "exit"; code: number | null; signal: NodeJS.Signals | null } | { kind: "timeout" } | {
  kind: "aborted";
} | { kind: "spawn-error"; message: string };

interface StepRun {
  step: CommandStep;
  cwd: string;
  env: Record<string, string>;
  output: TailBuffer;
  deadline: number;
  spawn: SpawnFn;
  killTree: (child: SpawnedProcess) => void;
  signal?: AbortSignal | undefined;
}

function runStep(run: StepRun): Promise<StepOutcome> {
  return new Promise<StepOutcome>((resolve) => {
    if (run.signal?.aborted) {
      resolve({ kind: "aborted" });
      return;
    }
    const remaining = run.deadline - Date.now();
    if (remaining <= 0) {
      resolve({ kind: "timeout" });
      return;
    }

    let child: SpawnedProcess;
    try {
      child = run.spawn(run.step.command, run.step.args, {
        cwd: run.cwd,
        env: run.env,
        detached: process.platform !== "win32",
      });
    } catch (err) {
      resolve({ kind: "spawn-error", message: err instanceof Error ? err.message : String(err) });
      return;
    }

    let reason: "timeout" | "aborted" | null = null;
    let settled = false;
    const finish = (outcome: StepOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      run.signal?.removeEventListener("abort", onAbort);
      // Reap anything the tool left behind in its process group.
      run.killTree(child);
      resolve(outcome);
    };
    const stop = (why: "timeout" | "aborted") => {
      if (reason) return;
      reason = why;
      run.killTree(child);
      // If the child never reports `close` (stuck pipes held by a grandchild), give up after a grace period.
      setTimeout(() => finish({ kind: why }), 5_000).unref();
    };
    const onAbort = () => stop("aborted");
    const timer = setTimeout(() => stop("timeout"), remaining);
    run.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout?.on("data", (chunk: Buffer) => run.output.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => run.output.push(chunk));
    child.on("error", (err) => finish(reason ? { kind: reason } : { kind: "spawn-error", message: err.message }));
    child.on("close", (code, signal) => finish(reason ? { kind: reason } : { kind: "exit", code, signal }));
  });
}

// ---------------------------------------------------------------------------------------------------------------
// The job
// ---------------------------------------------------------------------------------------------------------------

export interface RunLockOptions {
  /** Parent of the per-job temp dirs (a tmpfs in the container). */
  tmpRoot: string;
  timeoutMs?: number;
  /** Egress proxy URL; `null` disables it (tests only). */
  proxy: string | null;
  tools: ToolVersions;
  /** `PATH` for the child; defaults to the server's PATH. */
  pathEnv?: string;
  spawn?: SpawnFn;
  killTree?: (child: SpawnedProcess) => void;
  /** Aborts the running command (server shutdown). */
  signal?: AbortSignal;
  /** Test hook: called after the files are written, before the first command. */
  onPrepared?: (info: { jobDir: string; treeRoot: string; cwd: string }) => void | Promise<void>;
}

function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function resolveInside(root: string, relPath: string): string {
  const target = path.resolve(root, ...relPath.split("/"));
  if (!isInside(root, target)) throw new LockJobError("BAD_REQUEST", "path escapes the job directory");
  return target;
}

function failure(code: LockErrorCode, stderrTail = ""): ParsedLockResponse {
  return { ok: false, code, stderrTail };
}

function joinPath(dir: string, name: string): string {
  return dir === "" ? name : `${dir}/${name}`;
}

/** Write the prepared files under `treeRoot`, refusing anything that would land outside it. */
async function writeTree(treeRoot: string, files: readonly DecodedFile[]): Promise<void> {
  const realRoot = await fs.realpath(treeRoot);
  for (const file of files) {
    const target = resolveInside(treeRoot, file.path);
    try {
      await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      const realParent = await fs.realpath(path.dirname(target));
      if (realParent !== realRoot && !isInside(realRoot, realParent)) {
        throw new LockJobError("BAD_REQUEST", "path escapes the job directory");
      }
      // `wx`: O_CREAT | O_EXCL never follows or replaces an existing entry (symlink, directory, duplicate).
      await fs.writeFile(target, file.content, { flag: "wx", mode: 0o600 });
    } catch (err) {
      if (err instanceof LockJobError) throw err;
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EEXIST" || code === "ENOTDIR" || code === "EISDIR") {
        throw new LockJobError("BAD_REQUEST", "conflicting file paths in the upload");
      }
      throw err;
    }
  }
}

/** Read the expected lockfile: a regular file (no symlink) inside the tree, at most MAX_LOCKFILE_BYTES. */
async function readLockfile(treeRoot: string, relPath: string): Promise<Buffer | "missing" | "too-large"> {
  const target = resolveInside(treeRoot, relPath);
  let stat;
  try {
    stat = await fs.lstat(target);
  } catch {
    return "missing";
  }
  if (!stat.isFile()) return "missing";
  const realRoot = await fs.realpath(treeRoot);
  const realParent = await fs.realpath(path.dirname(target));
  if (realParent !== realRoot && !isInside(realRoot, realParent)) return "missing";
  if (stat.size > MAX_LOCKFILE_BYTES) return "too-large";

  const noFollow = (fsConstants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
  const handle = await fs.open(target, fsConstants.O_RDONLY | noFollow);
  try {
    const fstat = await handle.stat();
    if (!fstat.isFile()) return "missing";
    if (fstat.size > MAX_LOCKFILE_BYTES) return "too-large";
    const buf = Buffer.alloc(fstat.size);
    let offset = 0;
    while (offset < buf.length) {
      const { bytesRead } = await handle.read(buf, offset, buf.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    return buf.subarray(0, offset);
  } finally {
    await handle.close();
  }
}

function lockfileMatches(pm: SandboxPackageManager, relPath: string): void {
  const basename = relPath.split("/").pop()!;
  if (pm === "BUN" && basename === "bun.lockb") {
    throw new LockJobError("UNSUPPORTED_TOOL_VERSION", "binary bun.lockb is not supported; switch to bun.lock");
  }
  if (!LOCKFILE_NAMES[pm].includes(basename)) {
    throw new LockJobError("BAD_REQUEST", `expectLockfile must be one of ${LOCKFILE_NAMES[pm].join(", ")}`);
  }
}

function hasWorkspaces(packageJson: Buffer | undefined): boolean {
  if (!packageJson) return false;
  try {
    const parsed: unknown = JSON.parse(packageJson.toString("utf8"));
    return typeof parsed === "object" && parsed !== null && "workspaces" in parsed;
  } catch {
    return false;
  }
}

/**
 * Run one lockfile job. Never throws for job-level problems: every outcome is a {@link ParsedLockResponse}.
 * Unexpected errors (fs failures) are returned as `INTERNAL` without details.
 */
export async function runLock(request: ParsedLockRequest, options: RunLockOptions): Promise<ParsedLockResponse> {
  const spawn = options.spawn ?? defaultSpawn;
  const killTree = options.killTree ?? killProcessTree;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pm = request.packageManager;
  let jobDir: string | null = null;

  try {
    lockfileMatches(pm, request.expectLockfile);
    const prepared = prepareFiles(request.files);
    if (prepared.registries.length > 0) {
      return failure(
        "UNSUPPORTED_REGISTRY",
        sanitizeOutput(`custom package registry configured: ${prepared.registries.join("; ")}`),
      );
    }

    const byPath = new Map(prepared.files.map((f) => [f.path, f.content]));
    const python = pm === "UV" || pm === "POETRY";
    const manifestPath = joinPath(request.workdir, python ? "pyproject.toml" : "package.json");
    const manifest = byPath.get(manifestPath);
    if (!manifest) throw new LockJobError("BAD_REQUEST", `${manifestPath} is missing from the upload`);
    const inputLockfile = byPath.get(request.expectLockfile);

    checkToolVersions(
      {
        packageManager: pm,
        packageJson: python ? undefined : manifest.toString("utf8"),
        lockfile: inputLockfile?.toString("utf8"),
      },
      options.tools,
    );

    const workspace =
      pm === "PNPM"
        ? byPath.has(joinPath(request.workdir, "pnpm-workspace.yaml"))
        : pm === "BUN"
          ? hasWorkspaces(manifest)
          : false;
    const steps = buildCommands(
      { packageManager: pm, upgrade: request.upgrade, lockfileOnly: request.lockfileOnly },
      { workspace },
    );

    // ---- temp dir
    await fs.mkdir(options.tmpRoot, { recursive: true });
    jobDir = await fs.mkdtemp(path.join(options.tmpRoot, "lock-"));
    const treeRoot = path.join(jobDir, "repo");
    for (const dir of [treeRoot, path.join(jobDir, "home"), path.join(jobDir, "tmp"), path.join(jobDir, "cache")]) {
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    }
    await writeTree(treeRoot, prepared.files);
    const cwd = request.workdir === "" ? treeRoot : resolveInside(treeRoot, request.workdir);

    const env = buildSandboxEnv(jobDir, { proxy: options.proxy, path: options.pathEnv ?? process.env.PATH });
    await options.onPrepared?.({ jobDir, treeRoot, cwd });

    // ---- run
    const output = new TailBuffer();
    const deadline = Date.now() + timeoutMs;
    const manifests = prepared.files.filter((f) => f.path === "package.json" || f.path.endsWith("/package.json"));
    for (const step of steps) {
      if (step.restoreManifests) {
        for (const file of manifests) {
          // Remove first: never follow a symlink the tool may have left in place of the manifest.
          const target = resolveInside(treeRoot, file.path);
          await fs.rm(target, { force: true });
          await fs.writeFile(target, file.content, { flag: "wx", mode: 0o600 });
        }
      }
      const outcome = await runStep({ step, cwd, env, output, deadline, spawn, killTree, signal: options.signal });
      const tail = () => sanitizeOutput(output.toString(), jobDir ?? undefined);
      if (outcome.kind === "timeout") return failure("TIMEOUT", tail());
      if (outcome.kind === "aborted") return failure("BUSY", "sandbox is shutting down");
      if (outcome.kind === "spawn-error") {
        return failure("UNSUPPORTED_TOOL_VERSION", sanitizeOutput(`${step.command} could not be started`));
      }
      if (outcome.code !== 0) return failure("COMMAND_FAILED", tail());
    }

    // ---- result
    const lockfile = await readLockfile(treeRoot, request.expectLockfile);
    if (lockfile === "missing") return failure("LOCKFILE_MISSING", sanitizeOutput(output.toString(), jobDir));
    if (lockfile === "too-large") return failure("TOO_LARGE", "generated lockfile exceeds the size cap");

    const outputFormat = lockfileFormat(pm, lockfile.toString("utf8"));
    const inputFormat = inputLockfile ? lockfileFormat(pm, inputLockfile.toString("utf8")) : null;
    if (outputFormat === null || (inputFormat !== null && outputFormat !== inputFormat)) {
      return failure(
        "UNSUPPORTED_TOOL_VERSION",
        `lockfile format changed (${inputFormat ?? "none"} → ${outputFormat ?? "unknown"})`,
      );
    }

    return { ok: true, lockfile: { path: request.expectLockfile, contentBase64: lockfile.toString("base64") } };
  } catch (err) {
    if (err instanceof LockJobError) return failure(err.code, sanitizeOutput(err.message));
    console.error(`[deps-sandbox] job failed: ${err instanceof Error ? err.message : String(err)}`);
    return failure("INTERNAL");
  } finally {
    if (jobDir) {
      await fs.rm(jobDir, { recursive: true, force: true, maxRetries: 3 }).catch((err: unknown) => {
        console.error(`[deps-sandbox] could not remove ${jobDir}: ${err instanceof Error ? err.message : err}`);
      });
    }
  }
}

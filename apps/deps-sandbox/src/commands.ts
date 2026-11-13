/**
 * Command lines per package manager (Slice 08 §3.10.3) and the tool-version checks that run before them.
 *
 * Pure: no I/O. Every command is an argument array (never a shell string), and every package name that reaches a
 * command line is validated first, so nothing from the request can be parsed as a flag.
 *
 * Every command below was run end to end in the built image (npm 12.2.2, pnpm 12.16.1, Bun 1.4.4, uv 0.13.7,
 * Poetry 2.5.1, see the Dockerfile pins) through the egress proxy. Re-check them when bumping a pin.
 */
import type { LockErrorCode, SandboxPackageManager } from "@repopulse/deps/sandbox-contract";

export const TOOL_NAMES = ["npm", "pnpm", "bun", "uv", "poetry"] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

/** Installed tool versions (`"missing"` when the binary is absent or `--version` failed). */
export type ToolVersions = Record<ToolName, string>;

export const MISSING = "missing";

export const TOOL_FOR: Record<SandboxPackageManager, ToolName> = {
  NPM: "npm",
  PNPM: "pnpm",
  BUN: "bun",
  UV: "uv",
  POETRY: "poetry",
};

/** Lockfile basenames each package manager reads and writes. */
export const LOCKFILE_NAMES: Record<SandboxPackageManager, readonly string[]> = {
  NPM: ["package-lock.json", "npm-shrinkwrap.json"],
  PNPM: ["pnpm-lock.yaml"],
  BUN: ["bun.lock"],
  UV: ["uv.lock"],
  POETRY: ["poetry.lock"],
};

/**
 * Lockfile formats the pinned tools keep. A lockfile outside these is refused up front, and a run whose output
 * format differs from the input is refused afterwards (the worker requires the input format to be kept).
 */
/** npm 7+ keeps v2 and v3 and silently upgrades v1, so v1 is refused. */
export const NPM_LOCKFILE_VERSIONS = ["2", "3"] as const;
/** pnpm 9 through 12 write `lockfileVersion: '9.0'`. */
export const PNPM_LOCKFILE_MAJOR = 9;
/** Bun 1.2 / 1.3 write text `bun.lock` v1, Bun 1.4 writes v2 for new lockfiles and keeps v1. */
export const BUN_LOCKFILE_VERSIONS = ["1", "2"] as const;
/** uv.lock `version = 1` (uv ≥ 0.3). */
export const UV_LOCKFILE_VERSION = "1";
/** Poetry 2 reads and writes `lock-version = "2.x"`. */
export const POETRY_LOCK_MAJOR = 2;

/** A failed precondition: the job ends with `code` and `message` as the stderr tail. */
export class LockJobError extends Error {
  constructor(
    readonly code: LockErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "LockJobError";
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Names and versions
// ---------------------------------------------------------------------------------------------------------------

/**
 * npm package name (validate-npm-package-name rules, legacy uppercase allowed): optional `@scope/`, then a name
 * that starts with a letter or digit (never `-`, `.` or `_`) and uses only URL-safe characters. ≤ 214 chars.
 */
const NPM_NAME_PART = "[A-Za-z0-9][A-Za-z0-9._~-]*";
const NPM_NAME = new RegExp(`^(?:@${NPM_NAME_PART}/)?${NPM_NAME_PART}$`);

export function isValidNpmName(name: string): boolean {
  return name.length <= 214 && NPM_NAME.test(name);
}

/** PEP 508 distribution name: letters / digits, with `.`, `_`, `-` only between them. */
const PYTHON_NAME = /^(?:[A-Za-z0-9]|[A-Za-z0-9][A-Za-z0-9._-]*[A-Za-z0-9])$/;

export function isValidPythonName(name: string): boolean {
  return name.length <= 214 && PYTHON_NAME.test(name);
}

/** A version token (npm semver or PEP 440 public / local version). Starts with a digit or `v`, no spaces. */
const VERSION = /^v?[0-9][A-Za-z0-9.+!_-]*$/;

export function isValidVersion(version: string): boolean {
  return version.length <= 128 && VERSION.test(version);
}

export interface Upgrade {
  name: string;
  version: string;
}

/** Validate every upgrade for the ecosystem of `pm` and drop duplicates (first one wins). */
export function validateUpgrades(pm: SandboxPackageManager, upgrades: readonly Upgrade[]): Upgrade[] {
  const python = pm === "UV" || pm === "POETRY";
  const seen = new Set<string>();
  const out: Upgrade[] = [];
  for (const upgrade of upgrades) {
    const validName = python ? isValidPythonName(upgrade.name) : isValidNpmName(upgrade.name);
    if (!validName) throw new LockJobError("BAD_REQUEST", "invalid package name in upgrade list");
    if (!isValidVersion(upgrade.version)) throw new LockJobError("BAD_REQUEST", "invalid version in upgrade list");
    // PEP 503 normalization for Python names, exact match for npm.
    const key = python ? upgrade.name.toLowerCase().replace(/[-_.]+/g, "-") : upgrade.name;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name: upgrade.name, version: upgrade.version });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------------------------------------------

export interface CommandStep {
  command: ToolName;
  args: string[];
  /** Rewrite every uploaded `package.json` to its original content before this step (Bun `LOCKFILE_ONLY`). */
  restoreManifests?: boolean;
}

export interface CommandContext {
  /** The workdir has a `pnpm-workspace.yaml` (pnpm) or a root `package.json` with `workspaces` (Bun). */
  workspace: boolean;
}

export interface CommandInput {
  packageManager: SandboxPackageManager;
  upgrade: readonly Upgrade[];
  lockfileOnly: boolean;
}

/**
 * The command(s) to run in the workdir. Names must already be validated ({@link validateUpgrades}); this
 * function validates them again so it is safe on its own.
 */
export function buildCommands(input: CommandInput, ctx: CommandContext): CommandStep[] {
  const upgrades = validateUpgrades(input.packageManager, input.upgrade);
  const names = upgrades.map((u) => u.name);
  const needsNames = input.lockfileOnly && input.packageManager !== "UV";
  if (needsNames && names.length === 0) {
    throw new LockJobError("BAD_REQUEST", "lockfileOnly needs at least one package in the upgrade list");
  }

  switch (input.packageManager) {
    case "NPM": {
      const flags = ["--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"];
      // `npm update` keeps package.json ranges (it saves only with `--save`) and updates the lockfile in place.
      // Never add `--no-save`: with npm it also stops package-lock.json from being written.
      if (input.lockfileOnly) return [{ command: "npm", args: ["update", ...flags, ...names] }];
      return [{ command: "npm", args: ["install", ...flags] }];
    }
    case "PNPM": {
      const flags = ["--lockfile-only", "--ignore-scripts", "--ignore-pnpmfile"];
      if (input.lockfileOnly) {
        // `--no-save` keeps the package.json ranges (and so the lockfile specifiers) unchanged. pnpm 12's
        // `update` rejects `--no-frozen-lockfile` (verified against 12.16.1).
        const recursive = ctx.workspace ? ["--recursive"] : [];
        return [{ command: "pnpm", args: ["update", ...recursive, "--no-save", ...flags, ...names] }];
      }
      // pnpm defaults to `--frozen-lockfile` when CI is set, so `install` turns it off explicitly.
      return [{ command: "pnpm", args: ["install", "--no-frozen-lockfile", ...flags] }];
    }
    case "BUN": {
      // `--no-env-file`: Bun would otherwise load `.env*` files from the tree.
      const flags = ["--lockfile-only", "--ignore-scripts", "--no-env-file"];
      const install: CommandStep = { command: "bun", args: ["install", ...flags] };
      if (!input.lockfileOnly) return [install];
      // `bun update <name>` bumps within the range but also rewrites the package.json range (and the specifier in
      // bun.lock); `--no-save` would skip the lockfile too. So: update, restore the manifests, then install, which
      // keeps the newer locked versions (they still satisfy the original ranges) and restores the specifiers.
      const recursive = ctx.workspace ? ["--recursive"] : [];
      return [
        { command: "bun", args: ["update", ...recursive, ...flags, ...names] },
        { ...install, restoreManifests: true },
      ];
    }
    case "UV": {
      // One `--upgrade-package name==version` per planned upgrade; the rest of uv.lock stays as locked.
      const args = ["lock"];
      for (const u of upgrades) args.push("--upgrade-package", `${u.name}==${u.version}`);
      return [{ command: "uv", args }];
    }
    case "POETRY": {
      // Global options first. `--no-plugins` also skips `[tool.poetry.requires-plugins]` project plugins.
      const global = ["--no-plugins", "--no-interaction", "--no-ansi"];
      // Poetry 2 `lock` keeps unrelated locked versions; `update --lock <names>` refreshes only those packages.
      if (input.lockfileOnly) return [{ command: "poetry", args: [...global, "update", "--lock", ...names] }];
      return [{ command: "poetry", args: [...global, "lock"] }];
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Tool versions
// ---------------------------------------------------------------------------------------------------------------

/** Major of a version string such as `12.2.1`, `v1.4.3` or `0.13.1`; `null` when unparsable. */
export function majorOf(version: string): number | null {
  const match = /^v?(\d+)(?:\.|$)/.exec(version.trim());
  return match ? Number(match[1]) : null;
}

/**
 * Whether a semver range admits the given major (coarse: only the leading comparator of each `||` alternative and
 * an optional `<N` upper bound are looked at). Unparsable ranges are accepted; the post-run format check still
 * protects the lockfile.
 */
export function rangeAllowsMajor(range: string, major: number): boolean {
  return range.split("||").some((raw) => {
    const alt = raw.trim();
    if (alt === "" || alt === "*" || /^[xX]$/.test(alt) || alt === "latest") return true;
    const lower = /^>=?\s*v?(\d+)/.exec(alt);
    if (lower) {
      if (Number(lower[1]) > major) return false;
      const upper = /<(=?)\s*v?(\d+)((?:\.\d+)*)/.exec(alt);
      if (!upper) return true;
      const bound = Number(upper[2]);
      // `<=N`, `<N.1` admit major N; `<N` / `<N.0.0` do not.
      const inclusive = upper[1] === "=" || /[1-9]/.test(upper[3] ?? "");
      return inclusive ? major <= bound : major < bound;
    }
    const exact = /^(?:[\^~=]|~>)?\s*v?(\d+)/.exec(alt);
    if (exact) return Number(exact[1]) === major;
    return true;
  });
}

/** The lockfile format version, `null` when it can't be read. */
export function lockfileFormat(pm: SandboxPackageManager, content: string): string | null {
  const head = content.slice(0, 64 * 1024);
  let match: RegExpExecArray | null;
  switch (pm) {
    case "NPM":
      match = /"lockfileVersion"\s*:\s*(\d+)/.exec(head);
      break;
    case "PNPM": {
      const matches = [...content.matchAll(/^lockfileVersion:[ \t]*['"]?([0-9][0-9.]*)['"]?[ \t]*$/gm)];
      if (matches.length === 0) return null;
      const first = matches[0]![1]!;
      return matches.every((m) => m[1] === first) ? first : null;
    }
    case "BUN":
      match = /"lockfileVersion"\s*:\s*(\d+)/.exec(head);
      break;
    case "UV":
      match = /^version\s*=\s*(\d+)\s*$/m.exec(head);
      break;
    case "POETRY":
      // `[metadata]` is at the end of poetry.lock: search the whole file.
      match = /^lock-version\s*=\s*["']([0-9][0-9.]*)["']\s*$/m.exec(content);
      break;
  }
  return match?.[1] ?? null;
}

/** Throws `UNSUPPORTED_TOOL_VERSION` when the pinned tools would write the lockfile in another format. */
export function checkLockfileFormat(pm: SandboxPackageManager, content: string): void {
  const format = lockfileFormat(pm, content);
  if (format === null) throw new LockJobError("UNSUPPORTED_TOOL_VERSION", "unrecognized lockfile format");
  const ok = (() => {
    switch (pm) {
      case "NPM":
        return (NPM_LOCKFILE_VERSIONS as readonly string[]).includes(format);
      case "PNPM":
        return majorOf(format) === PNPM_LOCKFILE_MAJOR;
      case "BUN":
        return (BUN_LOCKFILE_VERSIONS as readonly string[]).includes(format);
      case "UV":
        return format === UV_LOCKFILE_VERSION;
      case "POETRY":
        return majorOf(format) === POETRY_LOCK_MAJOR;
    }
  })();
  if (!ok) {
    throw new LockJobError(
      "UNSUPPORTED_TOOL_VERSION",
      `lockfile format ${format} is not supported by the sandbox's ${TOOL_FOR[pm]}`,
    );
  }
}

interface PackageManagerSpec {
  name: string;
  version: string;
}

/** `packageManager` (`pnpm@10.12.1+sha512…`) and `devEngines.packageManager` entries of a package.json. */
export function declaredPackageManagers(packageJson: string): PackageManagerSpec[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(packageJson);
  } catch {
    throw new LockJobError("BAD_REQUEST", "package.json is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null) return [];
  const pkg = parsed as Record<string, unknown>;
  const out: PackageManagerSpec[] = [];
  if (typeof pkg.packageManager === "string") {
    const match = /^(@?[^@\s]+)@([^+\s]+)/.exec(pkg.packageManager.trim());
    if (match) out.push({ name: match[1]!, version: match[2]! });
  }
  const devEngines = pkg.devEngines;
  if (typeof devEngines === "object" && devEngines !== null) {
    const pmField = (devEngines as Record<string, unknown>).packageManager;
    const entries = Array.isArray(pmField) ? pmField : pmField ? [pmField] : [];
    for (const entry of entries) {
      if (typeof entry !== "object" || entry === null) continue;
      const { name, version } = entry as Record<string, unknown>;
      if (typeof name === "string") out.push({ name, version: typeof version === "string" ? version : "*" });
    }
  }
  return out;
}

export interface ToolCheckInput {
  packageManager: SandboxPackageManager;
  /** Content of `<workdir>/package.json` (npm, pnpm, Bun), when uploaded. */
  packageJson?: string;
  /** Content of the current lockfile, when uploaded. */
  lockfile?: string;
}

/**
 * Refuse with `UNSUPPORTED_TOOL_VERSION` when the tool is missing, when the project pins another major of the tool
 * (`packageManager` / `devEngines.packageManager`), or when its lockfile has a format the pinned tool would change.
 */
export function checkToolVersions(input: ToolCheckInput, tools: ToolVersions): void {
  const tool = TOOL_FOR[input.packageManager];
  const installed = tools[tool];
  const installedMajor = installed === MISSING ? null : majorOf(installed);
  if (installedMajor === null) {
    throw new LockJobError("UNSUPPORTED_TOOL_VERSION", `${tool} is not available in the sandbox`);
  }

  if (input.packageJson !== undefined && tool !== "uv" && tool !== "poetry") {
    for (const spec of declaredPackageManagers(input.packageJson)) {
      if (spec.name !== tool) {
        // A project managed by another tool (e.g. `yarn@4`) must not be re-locked with this one.
        if (["npm", "pnpm", "bun", "yarn"].includes(spec.name)) {
          throw new LockJobError("UNSUPPORTED_TOOL_VERSION", `package.json declares ${spec.name}, not ${tool}`);
        }
        continue;
      }
      if (!rangeAllowsMajor(spec.version, installedMajor)) {
        throw new LockJobError(
          "UNSUPPORTED_TOOL_VERSION",
          `package.json requires ${tool} ${spec.version}; the sandbox has ${tool} ${installed}`,
        );
      }
    }
  }

  if (input.lockfile !== undefined) checkLockfileFormat(input.packageManager, input.lockfile);
}

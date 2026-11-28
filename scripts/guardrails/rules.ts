import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

import type {
  FileEvaluationInput,
  GitChangeStatus,
  GuardrailRuleId,
  GuardrailViolation,
  ParsedIgnoreDirective,
  StagedStatusEntry,
} from "./types.ts";

const IGNORE_DIRECTIVE_RE = /guardrail-ignore:\s*([a-z0-9-]+(?:\/[a-z0-9-]+)+)\s*(?:—|--)\s*(.+?)(?:\*\/|$)/i;

const DEPENDENCY_SECTIONS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"] as const;

const MIGRATION_BASELINE_TIMESTAMP = "20261128000000";
const MIGRATION_FOLDER_RE = /^\d{14}_[a-z0-9_]+$/;
const MIGRATION_SQL_PATH_RE = /^packages\/db\/prisma\/migrations\/([^/]+)\/migration\.sql$/;
const MIGRATION_ANY_PATH_RE = /^packages\/db\/prisma\/migrations\/([^/]+)\/.+$/;
const PEM_PRIVATE_KEY_RE = /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/;
const GITHUB_TOKEN_RE = /\b(?:ghp|gho|ghs|ghu)_[A-Za-z0-9]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b/;
const FORBIDDEN_ENV_FILE_RE = /(?:^|\/)\.env(?:\..+)?$/;
const UI_PLACEHOLDER_PEM_RE =
  /\bplaceholder\s*=\s*\{?\s*["'`].*-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----.*(?:…|\.\.\.).*-----END/;

/**
 * Documented bootstrap DDL exception: `bootstrap-app-role.ts` creates/alters the runtime
 * PostgreSQL role using parameterized `set_config` and static `DO $do$` DDL statements.
 */
const RAW_SQL_UNSAFE_ALLOWLIST = new Set(["packages/db/src/bootstrap-app-role.ts"]);

export function toPosixPath(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}

export function isGeneratedOrVendorPath(relPath: string): boolean {
  const norm = toPosixPath(relPath);
  return (
    norm.includes("/node_modules/") ||
    norm.startsWith("node_modules/") ||
    norm.includes("/dist/") ||
    norm.includes("/.next/") ||
    norm.includes("/.turbo/") ||
    norm.includes("/coverage/") ||
    norm.includes("/generated/") ||
    norm === "apps/web/next-env.d.ts" ||
    norm === "next-env.d.ts"
  );
}

function isTestFilePath(relPath: string): boolean {
  const norm = toPosixPath(relPath);
  return (
    norm.includes("/tests/") ||
    norm.startsWith("e2e/") ||
    /\.test\.(ts|tsx|js|jsx|mts|cts)$/.test(norm) ||
    /\.spec\.(ts|tsx|js|jsx|mts|cts)$/.test(norm) ||
    /\.test-data\.(ts|tsx|js|jsx)$/.test(norm)
  );
}

function isGuardrailSelfPath(relPath: string): boolean {
  const norm = toPosixPath(relPath);
  return (
    norm === "scripts/guardrails.ts" || norm.startsWith("scripts/guardrails/") || norm.startsWith("scripts/tests/")
  );
}

/**
 * Parse a `guardrail-ignore: <rule-id> — <reason>` (or `--`) directive from a line.
 * Requires a reason containing at least 5 non-whitespace characters.
 */
export function parseIgnoreDirective(line: string): ParsedIgnoreDirective | null {
  const match = line.match(IGNORE_DIRECTIVE_RE);
  if (!match) return null;
  const ruleId = match[1]?.trim() ?? "";
  const reason = match[2]?.trim() ?? "";
  if (!ruleId || reason.replace(/\s+/g, "").length < 5) {
    return null;
  }
  return { ruleId, reason };
}

/**
 * Check whether `ruleId` is suppressed for `lineIndex` via an inline comment on the
 * same line, the immediately preceding line, or 2 lines above inside a JSX opening tag.
 */
export function isLineIgnored(lines: readonly string[], lineIndex: number, ruleId: GuardrailRuleId): boolean {
  const candidates = [lineIndex, lineIndex - 1, lineIndex - 2];
  for (const idx of candidates) {
    if (idx < 0 || idx >= lines.length) continue;
    if (idx === lineIndex - 2) {
      const between = lines[lineIndex - 1]?.trim() ?? "";
      if (
        between.length > 0 &&
        !between.startsWith("<") &&
        !between.startsWith("className=") &&
        !between.startsWith("aria-")
      ) {
        continue;
      }
    }
    const parsed = parseIgnoreDirective(lines[idx] ?? "");
    if (parsed?.ruleId === ruleId) {
      return true;
    }
  }
  return false;
}

function addViolation(
  out: GuardrailViolation[],
  lines: readonly string[],
  violation: Omit<GuardrailViolation, "severity">,
): void {
  if (violation.line !== undefined && isLineIgnored(lines, violation.line - 1, violation.ruleId)) {
    return;
  }
  out.push({ ...violation, severity: "error" });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJsonObject(content: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(content);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function findPackagePropertyLine(lines: readonly string[], pkgName: string, specifier?: string): number | undefined {
  const quotedKey = `"${pkgName}"`;
  const quotedSpec = specifier !== undefined ? `"${specifier}"` : null;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (!line.includes(quotedKey)) continue;
    if (quotedSpec === null || line.includes(quotedSpec)) {
      return i + 1;
    }
  }
  return undefined;
}

function isUnpinnedRangeSpecifier(specifier: string): boolean {
  const trimmed = specifier.trim();
  if (!trimmed) return false;
  if (trimmed === "workspace:*" || /^catalog:(?:[A-Za-z0-9_.-]+)?$/.test(trimmed)) {
    return false;
  }
  const normalized = trimmed.replace(/^npm:(?:@[^@/]+\/)?[^@]+@/, "");
  return (
    normalized === "*" ||
    normalized === "latest" ||
    normalized.includes("^") ||
    normalized.includes("~") ||
    /(?:>=|<=|>|<|\|\|| - )/.test(normalized) ||
    /(?:^|\.)[xX*](?:\b|$)/.test(normalized)
  );
}

function stripYamlScalarQuotes(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  const inlineComment = trimmed.indexOf(" #");
  return (inlineComment >= 0 ? trimmed.slice(0, inlineComment) : trimmed).trim();
}

function checkPnpmWorkspaceYaml(relPath: string, lines: readonly string[]): GuardrailViolation[] {
  if (relPath !== "pnpm-workspace.yaml") return [];

  const violations: GuardrailViolation[] = [];
  let section: "catalog" | "catalogs" | "overrides" | null = null;
  let subCatalog = false;

  for (let i = 0; i < lines.length; i += 1) {
    const rawLine = lines[i] ?? "";
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const indent = rawLine.length - rawLine.trimStart().length;
    if (indent === 0) {
      subCatalog = false;
      if (trimmed === "catalog:") section = "catalog";
      else if (trimmed === "catalogs:") section = "catalogs";
      else if (trimmed === "overrides:") section = "overrides";
      else section = null;
      continue;
    }

    if (section === null) continue;
    if (section === "catalogs" && indent <= 2 && trimmed.endsWith(":")) {
      subCatalog = true;
      continue;
    }
    if (section === "catalogs" && !subCatalog) continue;

    const colonIdx = trimmed.indexOf(": ");
    if (colonIdx === -1) continue;
    const depName = stripYamlScalarQuotes(trimmed.slice(0, colonIdx));
    const specifier = stripYamlScalarQuotes(trimmed.slice(colonIdx + 2));
    if (isUnpinnedRangeSpecifier(specifier)) {
      addViolation(violations, lines, {
        ruleId: "deps/pinned-versions",
        filePath: relPath,
        line: i + 1,
        message: `Unpinned dependency range "${depName}": "${specifier}" in pnpm-workspace.yaml (${section}).`,
        remediation: "Pin an exact version in `pnpm-workspace.yaml` `catalog:` / `overrides:`.",
      });
    }
  }

  return violations;
}

/**
 * Rule 1: `deps/pinned-versions`
 * Enforce exact dependency versions across root, workspace manifests, and `pnpm-workspace.yaml`.
 */
function checkPinnedVersions(relPath: string, content: string, lines: readonly string[]): GuardrailViolation[] {
  if (relPath === "pnpm-workspace.yaml") {
    return checkPnpmWorkspaceYaml(relPath, lines);
  }
  if (relPath !== "package.json" && !/^(?:apps|packages)\/[^/]+\/package\.json$/.test(relPath)) {
    return [];
  }

  const pkg = parseJsonObject(content);
  if (!pkg) return [];

  const violations: GuardrailViolation[] = [];
  for (const sectionName of DEPENDENCY_SECTIONS) {
    const rawSection = pkg[sectionName];
    if (typeof rawSection !== "object" || rawSection === null || Array.isArray(rawSection)) {
      continue;
    }
    for (const [depName, rawVersion] of Object.entries(rawSection)) {
      if (typeof rawVersion !== "string") continue;
      if (isUnpinnedRangeSpecifier(rawVersion)) {
        const line = findPackagePropertyLine(lines, depName, rawVersion);
        addViolation(violations, lines, {
          ruleId: "deps/pinned-versions",
          filePath: relPath,
          ...(line !== undefined ? { line } : {}),
          message: `Unpinned dependency range "${depName}": "${rawVersion}" in ${sectionName}.`,
          remediation: 'Pin an exact version (e.g. `pnpm add -E`) or use `"workspace:*"` / `"catalog:"`.',
        });
      }
    }
  }
  return violations;
}

/**
 * Rule 2: `security/no-raw-sql-unsafe`
 * Forbid `$queryRawUnsafe` and `$executeRawUnsafe` in `apps/**` and `packages/**` `.ts`/`.tsx` files.
 */
function checkNoRawSqlUnsafe(relPath: string, lines: readonly string[]): GuardrailViolation[] {
  if (!/^(?:apps|packages)\/.+\.(?:ts|tsx)$/.test(relPath)) return [];
  if (relPath.endsWith(".d.ts") || isTestFilePath(relPath) || relPath.includes("/generated/")) {
    return [];
  }
  if (RAW_SQL_UNSAFE_ALLOWLIST.has(relPath)) return [];

  const violations: GuardrailViolation[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) {
      continue;
    }
    if (/\$(?:queryRawUnsafe|executeRawUnsafe)\b/.test(line)) {
      addViolation(violations, lines, {
        ruleId: "security/no-raw-sql-unsafe",
        filePath: relPath,
        line: i + 1,
        message: "Avoid `$queryRawUnsafe` / `$executeRawUnsafe` in application or package source.",
        remediation:
          "Use tagged template `$queryRaw` / `$executeRaw` with `Prisma.sql`, or add `guardrail-ignore: security/no-raw-sql-unsafe — <reason>` for static DDL.",
      });
    }
  }
  return violations;
}

/**
 * Rule 3: `security/no-hardcoded-secrets`
 * Forbid committed PEM private key blocks and GitHub API tokens outside tests and UI placeholders.
 */
function checkNoHardcodedSecrets(relPath: string, lines: readonly string[]): GuardrailViolation[] {
  if (isTestFilePath(relPath) || isGuardrailSelfPath(relPath)) return [];

  const violations: GuardrailViolation[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (PEM_PRIVATE_KEY_RE.test(line) && !UI_PLACEHOLDER_PEM_RE.test(line)) {
      addViolation(violations, lines, {
        ruleId: "security/no-hardcoded-secrets",
        filePath: relPath,
        line: i + 1,
        message: "Hardcoded PEM private key material detected.",
        remediation: "Load private keys from encrypted database settings, environment variables, or secret mounts.",
      });
    }
    if (GITHUB_TOKEN_RE.test(line)) {
      addViolation(violations, lines, {
        ruleId: "security/no-hardcoded-secrets",
        filePath: relPath,
        line: i + 1,
        message: "Hardcoded GitHub token literal detected.",
        remediation:
          "Load GitHub tokens from environment variables or encrypted database settings, never source files.",
      });
    }
  }
  return violations;
}

/**
 * Rule 3b: `security/no-env-files`
 * Forbid staging `.env*` files (except `.env.example`).
 */
export function evaluateStagedEnvPaths(entries: readonly StagedStatusEntry[]): GuardrailViolation[] {
  const violations: GuardrailViolation[] = [];
  for (const entry of entries) {
    if (entry.status === "D") continue;
    const norm = toPosixPath(entry.path).replace(/^\.\//, "");
    if (norm === ".env.example" || norm.endsWith("/.env.example")) continue;
    if (!FORBIDDEN_ENV_FILE_RE.test(norm)) continue;
    violations.push({
      ruleId: "security/no-env-files",
      severity: "error",
      filePath: norm,
      message: `Staged environment file "${norm}" must never be committed.`,
      remediation: "Unstage the `.env*` file (`git reset HEAD <file>`); only `.env.example` belongs in Git.",
    });
  }
  return violations;
}

/**
 * Rule 4 (file-level): `migrations/folder-naming`
 * Validate the migration directory segment for files under `packages/db/prisma/migrations/`.
 */
function checkMigrationFolderNaming(relPath: string, lines: readonly string[]): GuardrailViolation[] {
  const match = relPath.match(MIGRATION_ANY_PATH_RE);
  if (!match) return [];

  const folder = match[1] ?? "";
  if (MIGRATION_FOLDER_RE.test(folder)) return [];

  const violations: GuardrailViolation[] = [];
  addViolation(violations, lines, {
    ruleId: "migrations/folder-naming",
    filePath: relPath,
    message: `Prisma migration folder "${folder}" must match \`YYYYMMDDHHMMSS_snake_case\` (^\\d{14}_[a-z0-9_]+$).`,
    remediation: "Rename the migration directory to `<14-digit-timestamp>_<snake_case_name>`.",
  });
  return violations;
}

/**
 * Rule 4 (directory scan): `migrations/folder-naming`
 * Check every subdirectory under `packages/db/prisma/migrations/`, skipping non-directories
 * such as `migration_lock.toml`.
 */
export function evaluateRepoMigrationsDir(repoRoot: string): GuardrailViolation[] {
  const migrationsRel = "packages/db/prisma/migrations";
  const migrationsAbs = resolve(repoRoot, migrationsRel);
  if (!existsSync(migrationsAbs)) return [];

  const violations: GuardrailViolation[] = [];
  for (const entry of readdirSync(migrationsAbs, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (!MIGRATION_FOLDER_RE.test(entry.name)) {
      violations.push({
        ruleId: "migrations/folder-naming",
        severity: "error",
        filePath: `${migrationsRel}/${entry.name}`,
        message: `Prisma migration folder "${entry.name}" must match \`YYYYMMDDHHMMSS_snake_case\` (^\\d{14}_[a-z0-9_]+$).`,
        remediation: "Rename the migration directory to `<14-digit-timestamp>_<snake_case_name>`.",
      });
    }
  }
  return violations;
}

/**
 * Parse `git diff --cached --name-status` output into normalized staged status entries.
 */
function toGitChangeStatus(char: string): GitChangeStatus {
  switch (char) {
    case "A":
    case "M":
    case "D":
    case "R":
    case "C":
    case "T":
    case "U":
      return char;
    default:
      return "M";
  }
}

export function parseGitNameStatus(output: string): StagedStatusEntry[] {
  const entries: StagedStatusEntry[] = [];
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const parts = line.split("\t");
    const rawCode = parts[0] ?? "";
    const statusChar = toGitChangeStatus(rawCode.charAt(0));

    if (statusChar === "R" || statusChar === "C") {
      const previousPath = toPosixPath(parts[1] ?? "");
      const nextPath = toPosixPath(parts[2] ?? "");
      if (nextPath) {
        entries.push({ status: statusChar, path: nextPath, previousPath });
      }
      continue;
    }

    const filePath = toPosixPath(parts[1] ?? "");
    if (filePath) {
      entries.push({ status: statusChar, path: filePath });
    }
  }
  return entries;
}

function isPreBaselineMigrationPath(filePath: string): boolean {
  const match = filePath.match(MIGRATION_SQL_PATH_RE);
  if (!match) return false;
  const folder = match[1] ?? "";
  if (!MIGRATION_FOLDER_RE.test(folder)) return false;
  return folder.slice(0, 14) < MIGRATION_BASELINE_TIMESTAMP;
}

/**
 * Rule 5: `migrations/no-shipped-migration-edits`
 * Forbid modifying (`M`), deleting (`D`), or renaming (`R`) existing `migration.sql` files.
 * Newly added (`A`) migrations and retiring pre-baseline (`< 20261128000000`) migrations are permitted.
 */
export function evaluateStagedMigrationEntries(entries: readonly StagedStatusEntry[]): GuardrailViolation[] {
  const violations: GuardrailViolation[] = [];

  for (const entry of entries) {
    if (entry.status === "A") continue;

    if (entry.status === "M" || entry.status === "D") {
      if (MIGRATION_SQL_PATH_RE.test(entry.path)) {
        if (entry.status === "D" && isPreBaselineMigrationPath(entry.path)) {
          continue;
        }
        const verb = entry.status === "M" ? "Modified" : "Deleted";
        violations.push({
          ruleId: "migrations/no-shipped-migration-edits",
          severity: "error",
          filePath: entry.path,
          message: `${verb} existing migration "${entry.path}". Shipped migrations are immutable.`,
          remediation:
            "Revert changes to shipped migrations and create a new migration under `packages/db/prisma/migrations/`.",
        });
      }
      continue;
    }

    if (entry.status === "R") {
      const isBaselineSquashRename =
        entry.previousPath !== undefined &&
        isPreBaselineMigrationPath(entry.previousPath) &&
        MIGRATION_SQL_PATH_RE.test(entry.path) &&
        !isPreBaselineMigrationPath(entry.path);
      if (isBaselineSquashRename) {
        continue;
      }

      const touchesShipped =
        (entry.previousPath !== undefined && MIGRATION_SQL_PATH_RE.test(entry.previousPath)) ||
        MIGRATION_SQL_PATH_RE.test(entry.path);
      if (touchesShipped) {
        violations.push({
          ruleId: "migrations/no-shipped-migration-edits",
          severity: "error",
          filePath: entry.previousPath ?? entry.path,
          message: `Renamed existing migration "${entry.previousPath ?? entry.path}" -> "${entry.path}". Shipped migrations are immutable.`,
          remediation:
            "Keep shipped migration paths unchanged and create a new migration if schema changes are needed.",
        });
      }
    }
  }

  return violations;
}

interface IsolationRule {
  forbiddenExact: readonly string[];
  forbiddenPrefixes: readonly string[];
  reason: string;
}

const WORKSPACE_ISOLATION_RULES: Readonly<Record<string, IsolationRule>> = {
  "packages/deps/package.json": {
    forbiddenExact: ["@repopulse/db"],
    forbiddenPrefixes: ["@octokit/"],
    reason: "@repopulse/deps must never depend on @repopulse/db or @octokit/*.",
  },
  "packages/notifications/package.json": {
    forbiddenExact: ["@repopulse/db"],
    forbiddenPrefixes: [],
    reason: "@repopulse/notifications must never depend on @repopulse/db.",
  },
  "apps/worker/package.json": {
    forbiddenExact: ["@repopulse/deps-worker"],
    forbiddenPrefixes: [],
    reason: "apps/worker and apps/deps-worker must never depend on each other.",
  },
  "apps/deps-worker/package.json": {
    forbiddenExact: ["@repopulse/worker"],
    forbiddenPrefixes: [],
    reason: "apps/worker and apps/deps-worker must never depend on each other.",
  },
  "apps/deps-sandbox/package.json": {
    forbiddenExact: ["@repopulse/db", "@repopulse/github", "@repopulse/notifications"],
    forbiddenPrefixes: [],
    reason: "apps/deps-sandbox runs isolated and must never depend on db, github, or notifications.",
  },
};

const APP_PACKAGE_NAMES = new Set([
  "@repopulse/web",
  "@repopulse/worker",
  "@repopulse/deps-worker",
  "@repopulse/deps-sandbox",
]);

function isolationRulesFor(relPath: string): IsolationRule[] {
  const rules: IsolationRule[] = [];
  const exact = WORKSPACE_ISOLATION_RULES[relPath];
  if (exact) rules.push(exact);
  if (/^packages\/[^/]+\/package\.json$/.test(relPath)) {
    rules.push({
      forbiddenExact: [...APP_PACKAGE_NAMES],
      forbiddenPrefixes: [],
      reason: "packages/* must never depend on apps/*.",
    });
  }
  return rules;
}

/**
 * Rule 6: `arch/workspace-dep-isolation`
 * Verify forbidden cross-package dependencies are absent in package manifests.
 */
function checkWorkspaceDepIsolation(relPath: string, content: string, lines: readonly string[]): GuardrailViolation[] {
  const rules = isolationRulesFor(relPath);
  if (rules.length === 0) return [];

  const pkg = parseJsonObject(content);
  if (!pkg) return [];

  const violations: GuardrailViolation[] = [];
  for (const sectionName of DEPENDENCY_SECTIONS) {
    const rawSection = pkg[sectionName];
    if (typeof rawSection !== "object" || rawSection === null || Array.isArray(rawSection)) {
      continue;
    }
    for (const depName of Object.keys(rawSection)) {
      for (const rule of rules) {
        const isForbidden =
          rule.forbiddenExact.includes(depName) || rule.forbiddenPrefixes.some((prefix) => depName.startsWith(prefix));
        if (!isForbidden) continue;

        const line = findPackagePropertyLine(lines, depName);
        addViolation(violations, lines, {
          ruleId: "arch/workspace-dep-isolation",
          filePath: relPath,
          ...(line !== undefined ? { line } : {}),
          message: `Forbidden dependency "${depName}" in ${sectionName}: ${rule.reason}`,
          remediation: `Remove "${depName}" from ${relPath} to preserve package boundaries.`,
        });
      }
    }
  }
  return violations;
}

/** Evaluate a single repository file against all file-level guardrail rules. */
export function evaluateFile(input: FileEvaluationInput): GuardrailViolation[] {
  const relPath = toPosixPath(input.relPath).replace(/^\.\//, "");
  if (!relPath || isGeneratedOrVendorPath(relPath)) {
    return [];
  }

  const lines = input.content.split(/\r?\n/);
  return [
    ...checkPinnedVersions(relPath, input.content, lines),
    ...checkNoRawSqlUnsafe(relPath, lines),
    ...checkNoHardcodedSecrets(relPath, lines),
    ...checkMigrationFolderNaming(relPath, lines),
    ...checkWorkspaceDepIsolation(relPath, input.content, lines),
  ];
}

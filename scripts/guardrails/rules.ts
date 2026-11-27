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

const MIGRATION_FOLDER_RE = /^\d{14}_[a-z0-9_]+$/;
const MIGRATION_SQL_PATH_RE = /^packages\/db\/prisma\/migrations\/([^/]+)\/migration\.sql$/;
const MIGRATION_ANY_PATH_RE = /^packages\/db\/prisma\/migrations\/([^/]+)\/.+$/;
const PEM_PRIVATE_KEY_RE = /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/;
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

export function isTestFilePath(relPath: string): boolean {
  const norm = toPosixPath(relPath);
  return (
    norm.includes("/tests/") ||
    norm.startsWith("e2e/") ||
    /\.test\.(ts|tsx|js|jsx|mts|cts)$/.test(norm) ||
    /\.spec\.(ts|tsx|js|jsx|mts|cts)$/.test(norm) ||
    /\.test-data\.(ts|tsx|js|jsx)$/.test(norm)
  );
}

export function isGuardrailSelfPath(relPath: string): boolean {
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

function parseJsonObject(content: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(content);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
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
  if (trimmed === "workspace:*" || trimmed === "catalog:" || trimmed.startsWith("catalog:")) {
    return trimmed.includes("^") || trimmed.includes("~");
  }
  return trimmed.includes("^") || trimmed.includes("~");
}

/**
 * Rule 1: `deps/pinned-versions`
 * Enforce exact dependency versions (forbid `^` and `~` ranges) across root and workspace manifests.
 */
export function checkPinnedVersions(relPath: string, content: string, lines: readonly string[]): GuardrailViolation[] {
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
        addViolation(violations, lines, {
          ruleId: "deps/pinned-versions",
          filePath: relPath,
          line: findPackagePropertyLine(lines, depName, rawVersion),
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
export function checkNoRawSqlUnsafe(relPath: string, lines: readonly string[]): GuardrailViolation[] {
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
 * Forbid committed PEM private key blocks outside test files and UI placeholder examples.
 */
export function checkNoHardcodedSecrets(relPath: string, lines: readonly string[]): GuardrailViolation[] {
  if (isTestFilePath(relPath) || isGuardrailSelfPath(relPath)) return [];

  const violations: GuardrailViolation[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (!PEM_PRIVATE_KEY_RE.test(line)) continue;
    if (UI_PLACEHOLDER_PEM_RE.test(line)) continue;

    addViolation(violations, lines, {
      ruleId: "security/no-hardcoded-secrets",
      filePath: relPath,
      line: i + 1,
      message: "Hardcoded PEM private key material detected.",
      remediation: "Load private keys from encrypted database settings, environment variables, or secret mounts.",
    });
  }
  return violations;
}

/**
 * Rule 4 (file-level): `migrations/folder-naming`
 * Validate the migration directory segment for files under `packages/db/prisma/migrations/`.
 */
export function checkMigrationFolderNaming(relPath: string, lines: readonly string[]): GuardrailViolation[] {
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
export function parseGitNameStatus(output: string): StagedStatusEntry[] {
  const entries: StagedStatusEntry[] = [];
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const parts = line.split("\t");
    const rawCode = parts[0] ?? "";
    const statusChar = rawCode.charAt(0) as GitChangeStatus;

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

/**
 * Rule 5: `migrations/no-shipped-migration-edits`
 * Forbid modifying (`M`), deleting (`D`), or renaming (`R`) existing `migration.sql` files.
 * Newly added (`A`) migrations are permitted.
 */
export function evaluateStagedMigrationEntries(entries: readonly StagedStatusEntry[]): GuardrailViolation[] {
  const violations: GuardrailViolation[] = [];

  for (const entry of entries) {
    if (entry.status === "A") continue;

    if (entry.status === "M" || entry.status === "D") {
      if (MIGRATION_SQL_PATH_RE.test(entry.path)) {
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
};

/**
 * Rule 6: `arch/workspace-dep-isolation`
 * Verify forbidden cross-package dependencies are absent in package manifests.
 */
export function checkWorkspaceDepIsolation(
  relPath: string,
  content: string,
  lines: readonly string[],
): GuardrailViolation[] {
  const rule = WORKSPACE_ISOLATION_RULES[relPath];
  if (!rule) return [];

  const pkg = parseJsonObject(content);
  if (!pkg) return [];

  const violations: GuardrailViolation[] = [];
  for (const sectionName of DEPENDENCY_SECTIONS) {
    const rawSection = pkg[sectionName];
    if (typeof rawSection !== "object" || rawSection === null || Array.isArray(rawSection)) {
      continue;
    }
    for (const depName of Object.keys(rawSection)) {
      const isForbidden =
        rule.forbiddenExact.includes(depName) || rule.forbiddenPrefixes.some((prefix) => depName.startsWith(prefix));
      if (!isForbidden) continue;

      addViolation(violations, lines, {
        ruleId: "arch/workspace-dep-isolation",
        filePath: relPath,
        line: findPackagePropertyLine(lines, depName),
        message: `Forbidden dependency "${depName}" in ${sectionName}: ${rule.reason}`,
        remediation: `Remove "${depName}" from ${relPath} to preserve package boundaries.`,
      });
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

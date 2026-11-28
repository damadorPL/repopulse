import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  evaluateFile,
  evaluateRepoMigrationsDir,
  evaluateStagedEnvPaths,
  evaluateStagedMigrationEntries,
  isGeneratedOrVendorPath,
  parseGitNameStatus,
  toPosixPath,
} from "./guardrails/rules.ts";
import type { GuardrailViolation } from "./guardrails/types.ts";

function getGitFileList(repoRoot: string, args: string[]): string[] {
  const out = execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" });
  return out
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map(toPosixPath);
}

function getStagedNameStatus(repoRoot: string): string {
  return execFileSync("git", ["diff", "--cached", "--name-status"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
}

function getBaseDiffNameStatus(repoRoot: string, baseRef: string): string {
  return execFileSync("git", ["diff", "--name-status", `${baseRef}...HEAD`], {
    cwd: repoRoot,
    encoding: "utf8",
  });
}

function parseBaseArg(argv: readonly string[]): { stagedOnly: boolean; baseRef: string | null } {
  let stagedOnly = false;
  let baseRef: string | null = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--staged") {
      stagedOnly = true;
    } else if (arg === "--base") {
      baseRef = argv[++i] ?? null;
    } else if (arg.startsWith("--base=")) {
      baseRef = arg.slice("--base=".length) || null;
    }
  }
  return { stagedOnly, baseRef };
}

function isBinaryContent(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
  return sample.includes(0);
}

function deduplicateViolations(violations: readonly GuardrailViolation[]): GuardrailViolation[] {
  const seen = new Set<string>();
  const unique: GuardrailViolation[] = [];

  for (const violation of violations) {
    if (violation.ruleId === "migrations/folder-naming") {
      const folderMatch = violation.filePath.match(/^packages\/db\/prisma\/migrations\/([^/]+)/);
      const folderKey = folderMatch ? `migrations/folder-naming:${folderMatch[1]}` : null;
      if (folderKey) {
        if (seen.has(folderKey)) continue;
        seen.add(folderKey);
        unique.push(violation);
        continue;
      }
    }

    const key = `${violation.ruleId}\0${violation.filePath}\0${violation.line ?? ""}\0${violation.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(violation);
  }

  return unique;
}

/** Run all repository guardrails across either staged files (`--staged`) or the workspace. */
export function runGuardrailsCli(
  argv: readonly string[] = process.argv.slice(2),
  repoRoot: string = process.cwd(),
): number {
  const { stagedOnly, baseRef } = parseBaseArg(argv);

  const candidateFiles = stagedOnly
    ? getGitFileList(repoRoot, ["diff", "--cached", "--name-only", "--diff-filter=ACM"])
    : getGitFileList(repoRoot, ["ls-files", "--cached", "--others", "--exclude-standard"]);

  const violations: GuardrailViolation[] = [];
  let checkedCount = 0;

  for (const relPath of candidateFiles) {
    if (isGeneratedOrVendorPath(relPath)) continue;
    const absPath = resolve(repoRoot, relPath);
    if (!existsSync(absPath)) continue;

    const raw = readFileSync(absPath);
    if (isBinaryContent(raw)) continue;

    checkedCount += 1;
    const content = raw.toString("utf8");
    violations.push(...evaluateFile({ repoRoot, relPath, content }));
  }

  if (stagedOnly) {
    const stagedEntries = parseGitNameStatus(getStagedNameStatus(repoRoot));
    violations.push(...evaluateStagedMigrationEntries(stagedEntries));
    violations.push(...evaluateStagedEnvPaths(stagedEntries));
  }

  if (baseRef) {
    const baseEntries = parseGitNameStatus(getBaseDiffNameStatus(repoRoot, baseRef));
    violations.push(...evaluateStagedMigrationEntries(baseEntries));
  }

  violations.push(...evaluateRepoMigrationsDir(repoRoot));

  const uniqueViolations = deduplicateViolations(violations);

  if (uniqueViolations.length > 0) {
    console.error(`[guardrails] ${uniqueViolations.length} violation(s) detected:`);
    for (const v of uniqueViolations) {
      const loc = v.line !== undefined ? `${v.filePath}:${v.line}` : v.filePath;
      console.error(`  - [${v.ruleId}] ${loc} — ${v.message}`);
      console.error(`    Fix: ${v.remediation}`);
    }
    return 1;
  }

  console.log(`[guardrails] OK (${checkedCount} ${stagedOnly ? "staged " : ""}files passed all checks).`);
  return 0;
}

function isDirectExecution(metaUrl: string): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  const entryUrl = pathToFileURL(resolve(entry)).href;
  return process.platform === "win32" ? entryUrl.toLowerCase() === metaUrl.toLowerCase() : entryUrl === metaUrl;
}

if (isDirectExecution(import.meta.url)) {
  const exitCode = runGuardrailsCli();
  if (exitCode !== 0) {
    process.exit(exitCode);
  }
}

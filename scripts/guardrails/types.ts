export type GuardrailRuleId =
  | "deps/pinned-versions"
  | "security/no-raw-sql-unsafe"
  | "security/no-hardcoded-secrets"
  | "security/no-env-files"
  | "migrations/folder-naming"
  | "migrations/no-shipped-migration-edits"
  | "arch/workspace-dep-isolation";

export type GuardrailSeverity = "error";

export interface GuardrailViolation {
  ruleId: GuardrailRuleId;
  severity: GuardrailSeverity;
  filePath: string;
  line?: number;
  message: string;
  remediation: string;
}

export interface FileEvaluationInput {
  repoRoot: string;
  relPath: string;
  content: string;
}

export type GitChangeStatus = "A" | "M" | "D" | "R" | "C" | "T" | "U";

export interface StagedStatusEntry {
  status: GitChangeStatus;
  path: string;
  previousPath?: string;
}

export interface ParsedIgnoreDirective {
  ruleId: string;
  reason: string;
}

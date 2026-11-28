import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const MAX_HEADER_LENGTH = 100;
const CONVENTIONAL_HEADER_RE =
  /^(feat|fix|docs|chore|refactor|perf|test|ci|build|style|revert)(?:\([a-z0-9._/-]+\))?!?:\s+\S/;
const RELEASE_HEADER_RE = /^chore(?:\([^)]+\))?:\s+release\b/i;
const EXEMPT_HEADER_RE = /^(?:Merge\b|Revert "|(?:fixup|squash|amend)!\s)/;
const SCISSORS_LINE_RE = /^# -{20,} >8 -{20,}$/;

interface CommitMsgValidationResult {
  ok: boolean;
  errors: string[];
}

interface CommitMsgLintDeps {
  cwd?: string;
  messageFilePath?: string;
  getStagedFileCount?: (cwd: string) => number;
  logError?: (msg: string) => void;
}

/** Strips Git scissors sections, comment lines, and surrounding blank lines from a raw commit message. */
export function stripCommitComments(raw: string): string[] {
  const normalized = raw.replace(/\r\n?/g, "\n");
  const lines: string[] = [];

  for (const line of normalized.split("\n")) {
    if (SCISSORS_LINE_RE.test(line)) break;
    if (line.startsWith("#")) continue;
    lines.push(line);
  }

  while (lines.length > 0 && lines.at(0)?.trim() === "") {
    lines.shift();
  }
  while (lines.length > 0 && lines.at(-1)?.trim() === "") {
    lines.pop();
  }

  return lines;
}

/** Validates a commit message against Conventional Commits and RepoPulse's body rules. */
export function validateCommitMessage(
  rawMessage: string,
  options: { stagedFileCount: number },
): CommitMsgValidationResult {
  const lines = stripCommitComments(rawMessage);
  const header = lines.at(0);
  if (!header) {
    return { ok: false, errors: ["Commit message cannot be empty."] };
  }

  if (EXEMPT_HEADER_RE.test(header)) {
    return { ok: true, errors: [] };
  }

  const errors: string[] = [];

  if (!CONVENTIONAL_HEADER_RE.test(header)) {
    errors.push(
      "Subject must follow Conventional Commits: <type>(<optional scope>): <summary> (e.g. feat(web): add filter).",
    );
  }

  if (header.length > MAX_HEADER_LENGTH) {
    errors.push(`Subject is ${header.length} characters (maximum is ${MAX_HEADER_LENGTH}).`);
  }

  const secondLine = lines.at(1);
  if (secondLine !== undefined && secondLine.trim().length > 0) {
    errors.push("Separate the commit subject from the body with a blank line.");
  }

  const isReleaseCommit = RELEASE_HEADER_RE.test(header);
  const requiresBody = isReleaseCommit || options.stagedFileCount >= 2;
  const bodyLines = lines.slice(1).filter((line) => line.trim().length > 0);

  if (requiresBody && bodyLines.length === 0) {
    const reason = isReleaseCommit ? "release commits" : `commits touching ${options.stagedFileCount} staged files`;
    errors.push(
      `A descriptive commit body is required for ${reason}. Include why/context, grouped changes by workspace/area, and operational impact (Migration:, Env:, Deploy:, BREAKING CHANGE:) when applicable (or set SKIP_COMMIT_MSG_HOOK=1 to bypass).`,
    );
  }

  return { ok: errors.length === 0, errors };
}

function getStagedFileCount(cwd: string): number {
  try {
    const out = execFileSync("git", ["diff", "--cached", "--name-only"], {
      cwd,
      encoding: "utf8",
    });
    return out
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0).length;
  } catch {
    return 0;
  }
}

/** Reads the commit message file and validates it, returning exit code `0` on success. */
export function runCommitMsgLint(deps: CommitMsgLintDeps = {}): number {
  const cwd = deps.cwd ?? process.cwd();
  const messageFilePath = deps.messageFilePath ?? process.argv[2];
  const logError = deps.logError ?? ((msg: string) => console.error(msg));

  if (!messageFilePath) {
    logError("[commit-msg] Missing path to commit message file.");
    return 1;
  }

  const rawMessage = readFileSync(resolve(cwd, messageFilePath), "utf8");
  const stagedFileCount = (deps.getStagedFileCount ?? getStagedFileCount)(cwd);
  const result = validateCommitMessage(rawMessage, { stagedFileCount });

  if (!result.ok) {
    logError("[commit-msg] Commit message validation failed:");
    for (const err of result.errors) {
      logError(`  - ${err}`);
    }
    return 1;
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
  const exitCode = runCommitMsgLint();
  if (exitCode !== 0) {
    process.exit(exitCode);
  }
}

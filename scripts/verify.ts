import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export type VerifyStepId =
  | "guardrails"
  | "manifests"
  | "packages-build"
  | "format-fix"
  | "typecheck"
  | "lint"
  | "css"
  | "knip"
  | "knip-strict"
  | "format"
  | "doctor"
  | "test"
  | "docs"
  | "web-build";

export interface VerifyStep {
  id: VerifyStepId;
  label: string;
  pnpmArgs: readonly string[];
  required?: boolean;
}

export interface VerifyCliOptions {
  fix: boolean;
  skipBuild: boolean;
  failFast: boolean;
  only: VerifyStepId[] | null;
  help: boolean;
}

export interface VerifyStepResult {
  id: VerifyStepId;
  label: string;
  status: "PASS" | "FAIL" | "SKIP";
  durationMs: number;
  exitCode: number;
}

export type CommandRunner = (pnpmArgs: readonly string[], cwd: string) => number;

export const DEFAULT_VERIFY_STEPS: readonly VerifyStep[] = [
  { id: "guardrails", label: "check:guardrails", pnpmArgs: ["run", "check:guardrails"] },
  { id: "manifests", label: "lint:manifests", pnpmArgs: ["run", "lint:manifests"] },
  {
    id: "packages-build",
    label: "packages:build",
    pnpmArgs: ["exec", "turbo", "run", "build", "--filter=./packages/*"],
    required: true,
  },
  { id: "typecheck", label: "typecheck", pnpmArgs: ["typecheck"] },
  { id: "lint", label: "lint", pnpmArgs: ["lint"] },
  { id: "css", label: "lint:css", pnpmArgs: ["run", "lint:css"] },
  { id: "knip", label: "knip", pnpmArgs: ["run", "knip"] },
  { id: "knip-strict", label: "knip:strict", pnpmArgs: ["run", "knip:strict"] },
  { id: "format", label: "format:check", pnpmArgs: ["format:check"] },
  { id: "doctor", label: "doctor", pnpmArgs: ["run", "doctor"] },
  { id: "test", label: "test", pnpmArgs: ["test"] },
  { id: "docs", label: "docs:check", pnpmArgs: ["run", "docs:check"] },
  { id: "web-build", label: "web:build", pnpmArgs: ["--filter", "@repopulse/web", "build"] },
];

const SELECTABLE_STEP_IDS = new Set<VerifyStepId>(DEFAULT_VERIFY_STEPS.map((step) => step.id));

export function parseVerifyArgs(argv: readonly string[]): VerifyCliOptions {
  let fix = false;
  let skipBuild = false;
  let failFast = false;
  let help = false;
  let only: VerifyStepId[] | null = null;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--fix") {
      fix = true;
    } else if (arg === "--skip-build") {
      skipBuild = true;
    } else if (arg === "--fail-fast") {
      failFast = true;
    } else if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg === "--only" || arg.startsWith("--only=")) {
      const rawValue = arg === "--only" ? (argv[++i] ?? "") : arg.slice("--only=".length);
      const parsed = rawValue
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (parsed.length === 0) {
        throw new Error("--only requires a comma-separated list of step IDs.");
      }
      const validated: VerifyStepId[] = [];
      for (const candidate of parsed) {
        const match = DEFAULT_VERIFY_STEPS.find((step) => step.id === candidate);
        if (!match) {
          throw new Error(`Unknown verify step "${candidate}". Valid steps: ${[...SELECTABLE_STEP_IDS].join(", ")}`);
        }
        validated.push(match.id);
      }
      only = validated;
    } else {
      throw new Error(`Unknown flag "${arg}". Run with --help for usage.`);
    }
  }

  return { fix, skipBuild, failFast, only, help };
}

export function buildVerifyPlan(options: VerifyCliOptions): VerifyStep[] {
  let steps: VerifyStep[] = [...DEFAULT_VERIFY_STEPS];

  if (options.only) {
    const allow = new Set(options.only);
    steps = steps.filter((step) => allow.has(step.id));
  }

  if (options.skipBuild) {
    steps = steps.filter((step) => step.id !== "packages-build" && step.id !== "web-build");
  }

  if (options.fix) {
    steps = [{ id: "format-fix", label: "format", pnpmArgs: ["format"] }, ...steps];
  }

  return steps;
}

function runPnpmCommand(pnpmArgs: readonly string[], cwd: string): number {
  const npmExecPath = process.env.npm_execpath;
  if (npmExecPath && /\.(?:cjs|mjs|js)$/i.test(npmExecPath)) {
    const res = spawnSync(process.execPath, [npmExecPath, ...pnpmArgs], {
      cwd,
      stdio: "inherit",
    });
    return res.status ?? 1;
  }

  if (process.platform === "win32") {
    const res = spawnSync("cmd.exe", ["/d", "/s", "/c", "pnpm", ...pnpmArgs], {
      cwd,
      stdio: "inherit",
    });
    return res.status ?? 1;
  }

  const res = spawnSync("pnpm", [...pnpmArgs], {
    cwd,
    stdio: "inherit",
  });
  return res.status ?? 1;
}

export function formatVerifySummary(results: readonly VerifyStepResult[]): string {
  const lines: string[] = ["", "=== Verification Summary ==="];
  const nameWidth = Math.max(16, ...results.map((r) => r.label.length + 2));

  for (const r of results) {
    const secs = `${(r.durationMs / 1000).toFixed(2)}s`;
    const icon = r.status === "PASS" ? "[PASS]" : r.status === "SKIP" ? "[SKIP]" : "[FAIL]";
    lines.push(`${icon} ${r.label.padEnd(nameWidth)} ${secs.padStart(8)}`);
  }

  const failed = results.filter((r) => r.status === "FAIL");
  const skipped = results.filter((r) => r.status === "SKIP");
  const totalMs = results.reduce((sum, r) => sum + r.durationMs, 0);
  lines.push(
    `Total: ${results.length - skipped.length} ran, ${failed.length} failed, ${skipped.length} skipped (${(totalMs / 1000).toFixed(2)}s)`,
  );
  return lines.join("\n");
}

export function runVerify(
  options: VerifyCliOptions,
  deps: {
    cwd?: string;
    runner?: CommandRunner;
    log?: (msg: string) => void;
    now?: () => number;
  } = {},
): { exitCode: number; results: VerifyStepResult[] } {
  const cwd = deps.cwd ?? process.cwd();
  const runner = deps.runner ?? runPnpmCommand;
  const log = deps.log ?? ((msg: string) => console.log(msg));
  const now = deps.now ?? (() => Date.now());

  const plan = buildVerifyPlan(options);
  const results: VerifyStepResult[] = [];
  let aborted = false;

  for (const step of plan) {
    if (aborted) {
      results.push({
        id: step.id,
        label: step.label,
        status: "SKIP",
        durationMs: 0,
        exitCode: 0,
      });
      continue;
    }

    log(`\n>>> [verify] Running ${step.label} (pnpm ${step.pnpmArgs.join(" ")})...`);
    const started = now();
    const exitCode = runner(step.pnpmArgs, cwd);
    const durationMs = Math.max(0, now() - started);
    const passed = exitCode === 0;

    results.push({
      id: step.id,
      label: step.label,
      status: passed ? "PASS" : "FAIL",
      durationMs,
      exitCode,
    });

    if (!passed && (options.failFast || step.required)) {
      aborted = true;
    }
  }

  log(formatVerifySummary(results));
  const hasFailure = results.some((r) => r.status === "FAIL");
  return { exitCode: hasFailure ? 1 : 0, results };
}

function printHelp(): void {
  console.log(`Usage: node scripts/verify.ts [options]

Options:
  --fix                Run format before verification checks
  --skip-build         Skip packages:build and web:build (reuse existing dist/.next outputs)
  --fail-fast          Stop immediately on the first failed check
  --only <steps>       Comma-separated step IDs: ${[...SELECTABLE_STEP_IDS].join(", ")}
  -h, --help           Show this help message
`);
}

function isDirectExecution(metaUrl: string): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  const entryUrl = pathToFileURL(resolve(entry)).href;
  return process.platform === "win32" ? entryUrl.toLowerCase() === metaUrl.toLowerCase() : entryUrl === metaUrl;
}

if (isDirectExecution(import.meta.url)) {
  try {
    const options = parseVerifyArgs(process.argv.slice(2));
    if (options.help) {
      printHelp();
      process.exit(0);
    }
    const { exitCode } = runVerify(options);
    process.exit(exitCode);
  } catch (err) {
    console.error(`[verify] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }
}

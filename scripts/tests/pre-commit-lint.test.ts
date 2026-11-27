import { describe, expect, it } from "vitest";

import { partitionStagedFiles, runPreCommitLint } from "../pre-commit-lint.ts";

describe("pre-commit-lint", () => {
  it("partitions staged files into format and lint buckets while skipping ignored paths", () => {
    const result = partitionStagedFiles([
      "apps/web/src/app/page.tsx",
      "apps/web/src/app/globals.css",
      ".oxlintrc.json",
      "README.md",
      "docs/CODING_STANDARDS.md",
      "CHANGELOG.md",
      "pnpm-lock.yaml",
      "packages/db/src/generated/prisma/index.ts",
      "apps/web/next-env.d.ts",
      "apps/web/public/logo.png",
      "packages/db/prisma/migrations/20261127_init/migration.sql",
      "./scripts/verify.ts",
      "scripts/verify.ts",
    ]);

    expect(result).toEqual({
      formatFiles: [
        "apps/web/src/app/page.tsx",
        "apps/web/src/app/globals.css",
        ".oxlintrc.json",
        "README.md",
        "scripts/verify.ts",
      ],
      lintFiles: ["apps/web/src/app/page.tsx", "scripts/verify.ts"],
    });
  });

  it("skips tool execution when no staged files match", () => {
    const calls: Array<readonly string[]> = [];
    const logs: string[] = [];
    const exitCode = runPreCommitLint({
      cwd: "/repo",
      getStaged: () => ["docs/README.md", "CHANGELOG.md"],
      runner: (args) => {
        calls.push(args);
        return 0;
      },
      log: (msg) => logs.push(msg),
    });

    expect(exitCode).toBe(0);
    expect(calls).toEqual([]);
    expect(logs).toEqual(["[pre-commit] No staged code or config files to format/lint."]);
  });

  it("runs oxfmt --check then oxlint on matching staged files and stops on failure", () => {
    const calls: Array<readonly string[]> = [];
    const ok = runPreCommitLint({
      cwd: "/repo",
      getStaged: () => ["apps/web/src/app/page.tsx", "apps/web/src/app/globals.css"],
      runner: (args) => {
        calls.push(args);
        return 0;
      },
      log: () => {},
    });
    expect(ok).toBe(0);
    expect(calls).toEqual([
      ["oxfmt", "--check", "apps/web/src/app/page.tsx", "apps/web/src/app/globals.css"],
      ["oxlint", "apps/web/src/app/page.tsx"],
    ]);

    const failCalls: Array<readonly string[]> = [];
    const failed = runPreCommitLint({
      cwd: "/repo",
      getStaged: () => ["apps/web/src/app/page.tsx", "apps/web/src/app/globals.css"],
      runner: (args) => {
        failCalls.push(args);
        return 1;
      },
      log: () => {},
    });
    expect(failed).toBe(1);
    expect(failCalls).toHaveLength(1);
  });
});

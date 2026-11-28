import { describe, expect, it } from "vitest";

import { partitionStagedFiles, runPreCommitLint } from "../pre-commit-lint.ts";

describe("pre-commit-lint", () => {
  it("partitions staged files into format, lint, and React Doctor buckets while skipping ignored paths", () => {
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
      doctorMode: "staged",
    });

    expect(partitionStagedFiles(["doctor.config.json"]).doctorMode).toBe("full");
    expect(partitionStagedFiles(["scripts/verify.ts"]).doctorMode).toBe("none");
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

  it("runs oxfmt --check, oxlint, and staged React Doctor on web files and skips doctor for non-web files", () => {
    const webCalls: Array<readonly string[]> = [];
    const webOk = runPreCommitLint({
      cwd: "/repo",
      getStaged: () => ["apps/web/src/app/page.tsx", "apps/web/src/app/globals.css"],
      runner: (args) => {
        webCalls.push(args);
        return 0;
      },
      log: () => {},
    });
    expect(webOk).toBe(0);
    expect(webCalls).toEqual([
      ["oxfmt", "--check", "apps/web/src/app/page.tsx", "apps/web/src/app/globals.css"],
      ["oxlint", "apps/web/src/app/page.tsx"],
      ["react-doctor", "--no-telemetry", "--staged", "--verbose", "."],
    ]);

    const configCalls: Array<readonly string[]> = [];
    const configOk = runPreCommitLint({
      cwd: "/repo",
      getStaged: () => ["doctor.config.json"],
      runner: (args) => {
        configCalls.push(args);
        return 0;
      },
      log: () => {},
    });
    expect(configOk).toBe(0);
    expect(configCalls).toEqual([
      ["oxfmt", "--check", "doctor.config.json"],
      ["react-doctor", "--no-telemetry", "--verbose", "."],
    ]);

    const scriptCalls: Array<readonly string[]> = [];
    const scriptOk = runPreCommitLint({
      cwd: "/repo",
      getStaged: () => ["scripts/verify.ts"],
      runner: (args) => {
        scriptCalls.push(args);
        return 0;
      },
      log: () => {},
    });
    expect(scriptOk).toBe(0);
    expect(scriptCalls).toEqual([
      ["oxfmt", "--check", "scripts/verify.ts"],
      ["oxlint", "scripts/verify.ts"],
    ]);

    const failCalls: Array<readonly string[]> = [];
    const failed = runPreCommitLint({
      cwd: "/repo",
      getStaged: () => ["apps/web/src/app/page.tsx", "apps/web/src/app/globals.css"],
      runner: (args) => {
        failCalls.push(args);
        return args[0] === "react-doctor" ? 1 : 0;
      },
      log: () => {},
    });
    expect(failed).toBe(1);
    expect(failCalls).toHaveLength(3);
  });
});

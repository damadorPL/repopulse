import { describe, expect, it } from "vitest";

import { buildVerifyPlan, formatVerifySummary, parseVerifyArgs, runVerify } from "../verify.ts";

describe("verify script", () => {
  it("parses CLI flags and validates step IDs", () => {
    expect(parseVerifyArgs([])).toEqual({
      fix: false,
      skipBuild: false,
      failFast: false,
      only: null,
      help: false,
    });

    expect(parseVerifyArgs(["--fix", "--skip-build", "--fail-fast", "--only", "lint,test"])).toEqual({
      fix: true,
      skipBuild: true,
      failFast: true,
      only: ["lint", "test"],
      help: false,
    });

    expect(parseVerifyArgs(["--only=typecheck,knip,web-build"]).only).toEqual(["typecheck", "knip", "web-build"]);
    expect(parseVerifyArgs(["-h"]).help).toBe(true);
    expect(() => parseVerifyArgs(["--only"])).toThrow(/--only requires/);
    expect(() => parseVerifyArgs(["--only", "unknown-step"])).toThrow(/Unknown verify step/);
    expect(() => parseVerifyArgs(["--bogus"])).toThrow(/Unknown flag/);
  });

  it("builds verify plan with --fix and --skip-build", () => {
    const defaultPlan = buildVerifyPlan({
      fix: false,
      skipBuild: false,
      failFast: false,
      only: null,
      help: false,
    });
    expect(defaultPlan.map((s) => s.id)).toEqual([
      "guardrails",
      "manifests",
      "packages-build",
      "typecheck",
      "lint",
      "css",
      "knip",
      "knip-strict",
      "format",
      "doctor",
      "test",
      "docs",
      "web-build",
    ]);

    const fixPlan = buildVerifyPlan({
      fix: true,
      skipBuild: false,
      failFast: false,
      only: null,
      help: false,
    });
    expect(fixPlan[0]?.id).toBe("format-fix");
    expect(fixPlan.map((s) => s.id)).toContain("packages-build");
    expect(fixPlan.map((s) => s.id)).toContain("web-build");

    const skipBuildPlan = buildVerifyPlan({
      fix: true,
      skipBuild: true,
      failFast: false,
      only: ["packages-build", "lint", "docs", "web-build"],
      help: false,
    });
    expect(skipBuildPlan.map((s) => s.id)).toEqual(["format-fix", "lint", "docs"]);
  });

  it("aborts immediately when required packages-build fails, but collects post-build failures by default", () => {
    const logs: string[] = [];
    const buildFailRun = runVerify(
      { fix: false, skipBuild: false, failFast: false, only: null, help: false },
      {
        log: (m) => {
          logs.push(m);
        },
        runner: (args) => (args.includes("build") && args.includes("turbo") ? 1 : 0),
      },
    );
    expect(buildFailRun.exitCode).toBe(1);
    expect(buildFailRun.results.find((r) => r.id === "guardrails")?.status).toBe("PASS");
    expect(buildFailRun.results.find((r) => r.id === "packages-build")?.status).toBe("FAIL");
    expect(buildFailRun.results.find((r) => r.id === "typecheck")?.status).toBe("SKIP");
    expect(buildFailRun.results.find((r) => r.id === "web-build")?.status).toBe("SKIP");

    const postBuildRun = runVerify(
      { fix: false, skipBuild: true, failFast: false, only: null, help: false },
      {
        log: () => {},
        runner: (args) => (args[0] === "lint" || args[1] === "knip" ? 1 : 0),
      },
    );
    expect(postBuildRun.exitCode).toBe(1);
    expect(postBuildRun.results.filter((r) => r.status === "FAIL").map((r) => r.id)).toEqual(["lint", "knip"]);
    expect(postBuildRun.results.filter((r) => r.status === "SKIP")).toHaveLength(0);
  });

  it("honors --fail-fast and formats verification summary cleanly", () => {
    const failFastRun = runVerify(
      { fix: false, skipBuild: true, failFast: true, only: null, help: false },
      {
        log: () => {},
        runner: (args) => (args[0] === "typecheck" ? 1 : 0),
      },
    );
    expect(failFastRun.exitCode).toBe(1);
    expect(failFastRun.results.find((r) => r.id === "typecheck")?.status).toBe("FAIL");
    expect(failFastRun.results.find((r) => r.id === "lint")?.status).toBe("SKIP");

    const summary = formatVerifySummary([
      {
        id: "guardrails",
        label: "check:guardrails",
        status: "PASS",
        durationMs: 1200,
        exitCode: 0,
      },
      { id: "lint", label: "lint", status: "FAIL", durationMs: 500, exitCode: 1 },
      { id: "test", label: "test", status: "SKIP", durationMs: 0, exitCode: 0 },
    ]);
    expect(summary).toContain("[PASS] check:guardrails");
    expect(summary).toContain("[FAIL] lint");
    expect(summary).toContain("[SKIP] test");
    expect(summary).toContain("2 ran, 1 failed, 1 skipped");
  });
});

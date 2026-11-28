import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { runCommitMsgLint, stripCommitComments, validateCommitMessage } from "../commit-msg-lint.ts";

describe("commit-msg-lint", () => {
  it("strips comment lines, scissors diffs, and surrounding blank lines", () => {
    const raw = [
      "",
      "feat(web): add filter",
      "# comment inside message",
      "",
      "Explain why this filter exists.",
      "# ------------------------ >8 ------------------------",
      "diff --git a/foo.ts b/foo.ts",
      "+const ignored = true;",
      "",
    ].join("\n");

    expect(stripCommitComments(raw)).toEqual(["feat(web): add filter", "", "Explain why this filter exists."]);
  });

  it("allows single-file Conventional Commits without a body", () => {
    const res = validateCommitMessage("docs: fix typo in README", { stagedFileCount: 1 });
    expect(res).toEqual({ ok: true, errors: [] });
  });

  it("requires a body when 2 or more files are staged", () => {
    const fail = validateCommitMessage("feat(web): update toolbar", { stagedFileCount: 2 });
    expect(fail.ok).toBe(false);
    expect(fail.errors[0]).toContain("2 staged files");

    const pass = validateCommitMessage(
      [
        "feat(web): update toolbar",
        "",
        "Keep search and filter controls aligned on narrow viewports.",
        "",
        "- web: consolidate toolbar spacing in repo and dependency lists",
      ].join("\n"),
      { stagedFileCount: 2 },
    );
    expect(pass).toEqual({ ok: true, errors: [] });
  });

  it("requires a body on release commits even with a single staged file", () => {
    const fail = validateCommitMessage("chore: release 0.9.9 — commit workflow updates", { stagedFileCount: 1 });
    expect(fail.ok).toBe(false);
    expect(fail.errors[0]).toContain("release commits");

    const pass = validateCommitMessage(
      [
        "chore: release 0.9.9 — commit workflow updates",
        "",
        "Remove obsolete PRD folder and enforce descriptive commit messages.",
        "",
        "- docs: make docs/ the sole source of truth",
      ].join("\n"),
      { stagedFileCount: 1 },
    );
    expect(pass).toEqual({ ok: true, errors: [] });
  });

  it("rejects invalid headers, overly long subjects, and missing blank lines before bodies", () => {
    const empty = validateCommitMessage("# only comments\n", { stagedFileCount: 1 });
    expect(empty.ok).toBe(false);

    const invalidType = validateCommitMessage("update: something", { stagedFileCount: 1 });
    expect(invalidType.ok).toBe(false);
    expect(invalidType.errors[0]).toContain("Conventional Commits");

    const tooLong = validateCommitMessage(`feat(web): ${"a".repeat(95)}`, { stagedFileCount: 1 });
    expect(tooLong.ok).toBe(false);
    expect(tooLong.errors[0]).toContain("maximum is 100");

    const noBlankLine = validateCommitMessage("fix(worker): retry timeout\nMissing blank line", {
      stagedFileCount: 2,
    });
    expect(noBlankLine.ok).toBe(false);
    expect(noBlankLine.errors[0]).toContain("blank line");
  });

  it("exempts Merge, Revert, fixup!, squash!, and amend! commits", () => {
    expect(validateCommitMessage("Merge branch 'main' of origin", { stagedFileCount: 5 })).toEqual({
      ok: true,
      errors: [],
    });
    expect(validateCommitMessage('Revert "feat: old feature"', { stagedFileCount: 4 })).toEqual({
      ok: true,
      errors: [],
    });
    expect(validateCommitMessage("fixup! feat(web): previous commit", { stagedFileCount: 3 })).toEqual({
      ok: true,
      errors: [],
    });
    expect(validateCommitMessage("squash! fix: adjust spacing", { stagedFileCount: 3 })).toEqual({
      ok: true,
      errors: [],
    });
  });

  it("does not treat comments or scissors diff content as a commit body", () => {
    const raw = [
      "refactor(deps): simplify planner",
      "# Why / Context:",
      "# ------------------------ >8 ------------------------",
      "diff --git a/a.ts b/a.ts",
    ].join("\n");

    const res = validateCommitMessage(raw, { stagedFileCount: 3 });
    expect(res.ok).toBe(false);
    expect(res.errors[0]).toContain("3 staged files");
  });

  it("runs end-to-end against a commit message file", () => {
    const dir = mkdtempSync(join(tmpdir(), "repopulse-commit-msg-"));
    try {
      const msgFile = join(dir, "COMMIT_EDITMSG");
      writeFileSync(msgFile, "docs: update guide\n", "utf8");

      const errors: string[] = [];
      const okCode = runCommitMsgLint({
        cwd: dir,
        messageFilePath: msgFile,
        getStagedFileCount: () => 1,
        logError: (msg) => {
          errors.push(msg);
        },
      });
      expect(okCode).toBe(0);
      expect(errors).toEqual([]);

      const failCode = runCommitMsgLint({
        cwd: dir,
        messageFilePath: msgFile,
        getStagedFileCount: () => 2,
        logError: (msg) => {
          errors.push(msg);
        },
      });
      expect(failCode).toBe(1);
      expect(errors.length).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

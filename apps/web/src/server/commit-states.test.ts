import { describe, expect, it } from "vitest";
import { needsPathImport, planCommitStates } from "./commit-states";

const commit = (id: string, ...changedPaths: string[]) => ({ id, changedPaths });

describe("planCommitStates", () => {
  it("seeds matching commits (newest unread, older read), keeps existing states and prunes non-matching ones", () => {
    const commits = [
      commit("c5", "packages/db/schema.prisma"),
      commit("c4", "README.md"),
      commit("c3", "packages/db/a.ts", "docs/x.md"),
      commit("c2", "packages/db"),
      commit("c1", "packages/dbx/y.ts"),
    ];
    expect(planCommitStates(commits, ["packages/db"], new Set(["c4", "c3"]), 2)).toEqual({
      unread: ["c5"],
      read: ["c2"],
      prune: ["c4"],
      matching: 3,
    });
  });

  it("does nothing for a user whose states already match", () => {
    expect(planCommitStates([commit("c1", "docs/a.md")], ["docs"], new Set(["c1"]))).toEqual({ unread: [], read: [], prune: [], matching: 1 });
  });
});

describe("needsPathImport", () => {
  it("is needed for never-polled repositories and paths", () => {
    expect(needsPathImport(["docs"], { polledPaths: [], lastPathsPolledAt: null })).toBe(true);
    expect(needsPathImport(["docs", "src"], { polledPaths: ["docs"], lastPathsPolledAt: new Date() })).toBe(true);
    expect(needsPathImport(["docs"], { polledPaths: ["docs", "src"], lastPathsPolledAt: new Date() })).toBe(false);
  });
});

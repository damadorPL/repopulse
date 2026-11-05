import { describe, expect, it, vi } from "vitest";
import { needsPathImport, planCommitStates, syncCommitStates } from "./commit-states";

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

describe("syncCommitStates", () => {
  it("prunes non-matching states and creates unread/read states inside the transaction", async () => {
    const tx = {
      release: {
        findMany: vi.fn(async () => [
          commit("c3", "packages/db/index.ts"),
          commit("c2", "README.md"),
          commit("c1", "packages/db/schema.prisma"),
        ]),
      },
      userReleaseState: {
        findMany: vi.fn(async () => [{ releaseId: "c2" }]),
        deleteMany: vi.fn(),
        createMany: vi.fn(),
      },
    };

    const plan = await syncCommitStates(tx as never, "u1", "repo1", ["packages/db"]);
    expect(plan).toEqual({
      unread: ["c3", "c1"],
      read: [],
      prune: ["c2"],
      matching: 2,
    });
    expect(tx.userReleaseState.deleteMany).toHaveBeenCalledWith({
      where: { userId: "u1", releaseId: { in: ["c2"] } },
    });
    expect(tx.userReleaseState.createMany).toHaveBeenCalledWith({
      data: [
        { userId: "u1", releaseId: "c3", isRead: false },
        { userId: "u1", releaseId: "c1", isRead: false },
      ],
      skipDuplicates: true,
    });
  });
});

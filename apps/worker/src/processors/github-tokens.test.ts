import { describe, expect, it, vi } from "vitest";

vi.mock("@repopulse/db", () => ({
  decryptToken: (value: string) => {
    if (value === "corrupt") throw new Error("bad key");
    return `plain:${value}`;
  },
}));

const { MAX_TOKEN_CANDIDATES, tokenCandidates } = await import("./github-tokens");

function fakePrisma(rows: Array<[string, string]>) {
  return {
    userSubscription: {
      findMany: vi.fn(async () =>
        rows.map(([userId, enc]) => ({
          userId,
          user: { githubAccessTokenEncrypted: enc },
        })),
      ),
    },
  };
}

describe("tokenCandidates", () => {
  it("returns only the anonymous candidate when no subscriber has a token", async () => {
    const prisma = fakePrisma([]);
    const res = await tokenCandidates(prisma as never, "repo1", undefined);
    expect(res).toEqual([{ userId: null, token: undefined }]);
    expect(prisma.userSubscription.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: MAX_TOKEN_CANDIDATES + 1 }),
    );
  });

  it("caps at MAX_TOKEN_CANDIDATES user tokens plus the trailing anonymous candidate", async () => {
    const prisma = fakePrisma([
      ["u1", "t1"],
      ["u2", "t2"],
      ["u3", "t3"],
      ["u4", "t4"],
    ]);
    const res = await tokenCandidates(prisma as never, "repo1", undefined);
    expect(res).toEqual([
      { userId: "u1", token: "plain:t1" },
      { userId: "u2", token: "plain:t2" },
      { userId: "u3", token: "plain:t3" },
      { userId: null, token: undefined },
    ]);
  });

  it("skips a corrupt token while still filling 3 valid tokens from the MAX_TOKEN_CANDIDATES + 1 query", async () => {
    const prisma = fakePrisma([
      ["u1", "t1"],
      ["u2", "corrupt"],
      ["u3", "t3"],
      ["u4", "t4"],
    ]);
    const res = await tokenCandidates(prisma as never, "repo1", undefined);
    expect(res).toEqual([
      { userId: "u1", token: "plain:t1" },
      { userId: "u3", token: "plain:t3" },
      { userId: "u4", token: "plain:t4" },
      { userId: null, token: undefined },
    ]);
  });

  it("promotes preferredUserId to index 0 while preserving order of remaining candidates", async () => {
    const prisma = fakePrisma([
      ["u1", "t1"],
      ["u2", "t2"],
      ["u3", "t3"],
    ]);
    const res = await tokenCandidates(prisma as never, "repo1", "u3");
    expect(res).toEqual([
      { userId: "u3", token: "plain:t3" },
      { userId: "u1", token: "plain:t1" },
      { userId: "u2", token: "plain:t2" },
      { userId: null, token: undefined },
    ]);
  });
});

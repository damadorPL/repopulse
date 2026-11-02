import { beforeEach, describe, expect, it, vi } from "vitest";

const prisma = {
  repository: { findFirst: vi.fn() },
  userSubscription: { findMany: vi.fn() },
  release: { findMany: vi.fn(), groupBy: vi.fn(), count: vi.fn(), aggregate: vi.fn() },
  tag: { findMany: vi.fn() },
};

vi.mock("@repopulse/db", () => ({ prisma }));
vi.mock("@/server/backfill-settings", () => ({ getBackfillConfig: vi.fn(async () => ({ hardCap: 1000 })) }));

const { getRepositoryActivity, getRepositorySettings, parseRepoSegment } = await import("./repository-settings");
const { visibleReleasesWhere } = await import("./feed");

const USER = "user_1";

function subscriptionRow(extra: Record<string, unknown> = {}) {
  return {
    id: "sub_1",
    includePrereleases: false,
    trackMode: "RELEASES",
    trackPaths: false,
    watchedPaths: [],
    isPinned: true,
    note: "Blocked on v16",
    notificationLevel: "MAJOR_ONLY",
    snoozedUntil: null,
    currentVersion: null,
    createdAt: new Date("2026-10-01T00:00:00Z"),
    tags: [],
    repository: {
      id: "repo_1",
      owner: "vercel",
      name: "next.js",
      fullName: "vercel/next.js",
      avatarUrl: null,
      htmlUrl: "https://github.com/vercel/next.js",
      description: null,
      starsCount: 1,
      lastPolledAt: null,
      pollStatus: "IDLE",
      backfillStatus: "DONE",
      backfillNextPage: null,
      backfillTarget: 100,
      _count: { releases: 2 },
      releases: [
        { id: "r2", tagName: "v16.0.0", semverType: "MAJOR", publishedAt: new Date("2026-10-20T00:00:00Z"), isPrerelease: false, source: "RELEASE" },
      ],
    },
    ...extra,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  prisma.repository.findFirst.mockResolvedValue({ id: "repo_1" });
  prisma.userSubscription.findMany.mockResolvedValue([subscriptionRow()]);
  prisma.release.groupBy.mockResolvedValue([]);
  prisma.release.findMany.mockResolvedValue([]);
  prisma.tag.findMany.mockResolvedValue([
    { id: "t2", name: "zeta", slug: "zeta", colorHex: "#000000" },
    { id: "t1", name: "Alpha", slug: "alpha", colorHex: "#FFFFFF" },
  ]);
});

describe("parseRepoSegment", () => {
  it("accepts GitHub names and decodes percent-encoding", () => {
    expect(parseRepoSegment("next.js")).toBe("next.js");
    expect(parseRepoSegment("my%2Drepo")).toBe("my-repo");
  });

  it("rejects anything else", () => {
    expect(parseRepoSegment("..")).toBeNull();
    expect(parseRepoSegment("a%2Fb")).toBeNull();
    expect(parseRepoSegment("%E0%A4%A")).toBeNull();
    expect(parseRepoSegment("x".repeat(101))).toBeNull();
  });
});

describe("getRepositorySettings", () => {
  it("resolves the repository case-insensitively, then only the signed-in user's subscription", async () => {
    const settings = await getRepositorySettings(USER, "Vercel", "Next.js");

    expect(prisma.repository.findFirst).toHaveBeenCalledWith({
      where: { fullName: { equals: "Vercel/Next.js", mode: "insensitive" } },
      select: { id: true },
    });
    expect(prisma.userSubscription.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { repositoryId: "repo_1", userId: USER } }),
    );
    expect(prisma.tag.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: USER } }));
    expect(settings).toMatchObject({
      subscriptionId: "sub_1",
      isPinned: true,
      note: "Blocked on v16",
      notificationLevel: "MAJOR_ONLY",
      hardCap: 1000,
      repository: { fullName: "vercel/next.js" },
      latestRelease: { id: "r2" },
      latestActivityAt: new Date("2026-10-20T00:00:00Z"),
    });
    expect(settings?.allTags.map((t) => t.name)).toEqual(["Alpha", "zeta"]);
  });

  it("returns null when the user does not subscribe (e.g. only another user does)", async () => {
    prisma.userSubscription.findMany.mockResolvedValue([]);
    expect(await getRepositorySettings(USER, "vercel", "next.js")).toBeNull();
  });

  it("returns null for an unknown repository without looking for subscriptions", async () => {
    prisma.repository.findFirst.mockResolvedValue(null);
    expect(await getRepositorySettings(USER, "nobody", "nothing")).toBeNull();
    expect(prisma.userSubscription.findMany).not.toHaveBeenCalled();
  });

  it("returns null for invalid route segments without querying", async () => {
    expect(await getRepositorySettings(USER, "..", "x")).toBeNull();
    expect(prisma.repository.findFirst).not.toHaveBeenCalled();
  });

  it("computes the version status from visible releases only", async () => {
    prisma.userSubscription.findMany.mockResolvedValue([subscriptionRow({ currentVersion: "v15.0.0" })]);
    prisma.release.findMany.mockResolvedValue([
      { repositoryId: "repo_1", tagName: "v16.0.0", publishedAt: new Date("2026-10-20T00:00:00Z"), semverType: "MAJOR" },
      { repositoryId: "repo_1", tagName: "v15.1.0", publishedAt: new Date("2026-09-20T00:00:00Z"), semverType: "MINOR" },
      { repositoryId: "repo_1", tagName: "v15.0.0", publishedAt: new Date("2026-08-20T00:00:00Z"), semverType: "MAJOR" },
    ]);
    const settings = await getRepositorySettings(USER, "vercel", "next.js");
    expect(settings?.versionStatus).toEqual({ behind: 2, major: 1, matched: true });
    const versionQuery = prisma.release.findMany.mock.calls.find(([args]) => "take" in args && args.take === 5000)?.[0];
    expect(versionQuery.where.AND[0]).toEqual(visibleReleasesWhere(USER, { repositoryId: { in: ["repo_1"] } }));
  });
});

describe("getRepositoryActivity", () => {
  it("reads through visibleReleasesWhere for the window, the total and the oldest row", async () => {
    const now = new Date("2026-11-02T12:00:00Z");
    prisma.release.findMany.mockResolvedValue([
      { id: "r1", publishedAt: new Date("2026-10-20T00:00:00Z"), source: "RELEASE", semverType: "MAJOR" },
    ]);
    prisma.release.count.mockResolvedValue(42);
    prisma.release.aggregate.mockResolvedValue({ _min: { publishedAt: new Date("2024-01-01T00:00:00Z") } });

    const activity = await getRepositoryActivity(USER, "repo_1", now);

    const visible = { AND: [visibleReleasesWhere(USER, { repositoryId: "repo_1" }), { repositoryId: "repo_1" }] };
    expect(prisma.release.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { AND: [visible, { publishedAt: { gte: new Date(now.getTime() - 371 * 24 * 60 * 60 * 1000) } }] },
        take: 5001,
      }),
    );
    expect(prisma.release.count).toHaveBeenCalledWith({ where: visible });
    expect(activity).toEqual({
      items: [{ id: "r1", at: "2026-10-20T00:00:00.000Z", source: "RELEASE", semverType: "MAJOR" }],
      truncated: false,
      total: 42,
      firstStoredAt: new Date("2024-01-01T00:00:00Z"),
    });
  });

  it("caps the items and flags truncation", async () => {
    const rows = Array.from({ length: 5001 }, (_, i) => ({
      id: `r${i}`,
      publishedAt: new Date(Date.UTC(2026, 9, 1, 0, 0, i)),
      source: "COMMIT",
      semverType: "OTHER",
    }));
    prisma.release.findMany.mockResolvedValue(rows);
    prisma.release.count.mockResolvedValue(9000);
    prisma.release.aggregate.mockResolvedValue({ _min: { publishedAt: null } });
    const activity = await getRepositoryActivity(USER, "repo_1");
    expect(activity.items).toHaveLength(5000);
    expect(activity.truncated).toBe(true);
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

const prisma = {
  release: {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    count: vi.fn(),
    groupBy: vi.fn(),
  },
  tag: { findMany: vi.fn() },
  userSubscription: { findMany: vi.fn() },
};

vi.mock("@repopulse/db", () => ({ prisma }));

const {
  afterCursorWhere,
  buildFeedWhere,
  decodeFeedCursor,
  encodeFeedCursor,
  getDashboardData,
  getReleaseDetail,
  getReleaseFeed,
  visibleReleasesWhere,
} = await import("./feed");

const USER = "user_1";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("visibleReleasesWhere", () => {
  it("scopes to the user's subscriptions, skips drafts and honors includePrereleases and trackMode", () => {
    expect(visibleReleasesWhere(USER)).toEqual({
      isDraft: false,
      repository: { subscriptions: { some: { userId: USER } } },
      AND: [
        {
          OR: [
            { isPrerelease: false },
            { repository: { subscriptions: { some: { userId: USER, includePrereleases: true } } } },
          ],
        },
        // Releases for "Releases only" and "Releases + tags", tags for "Releases + tags", and commits
        // with "Files / folders" on (any release mode), only when they matched this user's paths (they have a state row).
        {
          OR: [
            {
              source: "RELEASE",
              repository: { subscriptions: { some: { userId: USER, trackMode: { in: ["RELEASES", "TAGS_AND_COMMITS"] } } } },
            },
            { source: "TAG", repository: { subscriptions: { some: { userId: USER, trackMode: "TAGS_AND_COMMITS" } } } },
            {
              source: "COMMIT",
              repository: { subscriptions: { some: { userId: USER, trackPaths: true } } },
              userStates: { some: { userId: USER } },
            },
          ],
        },
      ],
    });
  });

  it("cannot be widened to another user through the subscription filter", () => {
    const where = visibleReleasesWhere(USER, { userId: "someone_else" });
    expect(where.repository).toEqual({ subscriptions: { some: { userId: USER } } });
  });
});

describe("buildFeedWhere", () => {
  it("is just the visibility rule without filters", () => {
    expect(buildFeedWhere(USER, {})).toEqual({ AND: [visibleReleasesWhere(USER)] });
  });

  it("filters by tag through the user's own subscription", () => {
    const where = buildFeedWhere(USER, { tagSlug: "critical" });
    expect(where.AND).toEqual([
      visibleReleasesWhere(USER, { tags: { some: { tag: { slug: "critical" } } } }),
    ]);
  });

  it("combines repository, unread, semver and search filters", () => {
    const where = buildFeedWhere(USER, {
      repositoryId: "repo_1",
      onlyUnread: true,
      semverType: "MAJOR",
      searchQuery: "  breaking ",
    });
    const and = where.AND as unknown[];
    expect(and).toContainEqual({ repositoryId: "repo_1" });
    expect(and).toContainEqual({ userStates: { some: { userId: USER, isRead: false } } });
    expect(and).toContainEqual({ semverType: "MAJOR" });

    const search = and.at(-1) as { OR: unknown[] };
    const contains = { contains: "breaking", mode: "insensitive" };
    expect(search.OR).toEqual([
      { tagName: contains },
      { title: contains },
      { bodyMarkdown: contains },
      { repository: { fullName: contains } },
      { repository: { subscriptions: { some: { userId: USER, tags: { some: { tag: { name: contains } } } } } } },
    ]);
  });

  it("ignores a blank search query", () => {
    expect(buildFeedWhere(USER, { searchQuery: "   " }).AND).toHaveLength(1);
  });
});

describe("keyset feed cursor", () => {
  const row = { publishedAt: new Date("2026-10-30T12:00:00.000Z"), id: "cmabc123" };

  it("round-trips publishedAt and id", () => {
    expect(decodeFeedCursor(encodeFeedCursor(row))).toEqual(row);
  });

  it.each(["", "cmabc123", "abc.cm1", "123.", "123.a b", "1".repeat(16) + ".x"])("rejects malformed cursor %j", (cursor) => {
    expect(decodeFeedCursor(cursor)).toBeNull();
  });

  it("continues strictly after the cursor row in either direction (no skip: 1)", () => {
    expect(afterCursorWhere(row, "desc")).toEqual({
      OR: [{ publishedAt: { lt: row.publishedAt } }, { publishedAt: row.publishedAt, id: { lt: row.id } }],
    });
    expect(afterCursorWhere(row, "asc")).toEqual({
      OR: [{ publishedAt: { gt: row.publishedAt } }, { publishedAt: row.publishedAt, id: { gt: row.id } }],
    });
  });
});

function makeFeedRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "rel1",
    source: "RELEASE" as const,
    tagName: "v2.0.0",
    title: "Release 2.0.0",
    htmlUrl: "https://github.com/acme/web/releases/tag/v2.0.0",
    isPrerelease: false,
    semverType: "MAJOR" as const,
    publishedAt: new Date("2026-11-01T00:00:00.000Z"),
    repository: {
      id: "repo1",
      owner: "acme",
      name: "web",
      fullName: "acme/web",
      avatarUrl: null,
      htmlUrl: "https://github.com/acme/web",
      subscriptions: [
        {
          id: "sub1",
          currentVersion: "v1.0.0",
          tags: [{ tag: { id: "t1", name: "Core", slug: "core", colorHex: "#EF4444" } }],
        },
      ],
    },
    userStates: [] as Array<{ isRead: boolean }>,
    ...overrides,
  };
}

describe("getReleaseFeed", () => {
  it("returns empty page without querying when cursor is malformed", async () => {
    const page = await getReleaseFeed({ userId: USER, cursor: "not-a-cursor" });
    expect(page).toEqual({ items: [], nextCursor: null });
    expect(prisma.release.findMany).not.toHaveBeenCalled();
  });

  it("clamps limit to [1, 100], computes nextCursor, defaults missing userState to isRead=true, and marks isMyVersion/newerThanMine", async () => {
    const r1 = makeFeedRow({ id: "rel2", tagName: "v2.0.0", publishedAt: new Date("2026-11-02T00:00:00Z") });
    const r2 = makeFeedRow({
      id: "rel1",
      tagName: "v1.0.0",
      publishedAt: new Date("2026-11-01T00:00:00Z"),
      userStates: [{ isRead: false }],
    });
    const r3 = makeFeedRow({ id: "rel0", tagName: "v0.9.0", publishedAt: new Date("2026-10-01T00:00:00Z") });

    // 1st call: feed rows (limit clamped to 2 -> take 3). 2nd call: anchor rows for markNewerThanMine.
    prisma.release.findMany
      .mockResolvedValueOnce([r1, r2, r3])
      .mockResolvedValueOnce([{ repositoryId: "repo1", tagName: "v1.0.0", publishedAt: r2.publishedAt }]);

    const page = await getReleaseFeed({ userId: USER, limit: 2 });
    expect(prisma.release.findMany.mock.calls[0]![0]).toMatchObject({ take: 3 });
    expect(page.nextCursor).toBe(encodeFeedCursor(r2));
    expect(page.items).toHaveLength(2);
    expect(page.items[0]).toMatchObject({
      id: "rel2",
      isRead: true,
      isMyVersion: false,
      newerThanMine: true,
    });
    expect(page.items[1]).toMatchObject({
      id: "rel1",
      isRead: false,
      isMyVersion: true,
      newerThanMine: false,
    });

    // Limit > 100 clamps to 100 (take: 101)
    prisma.release.findMany.mockResolvedValueOnce([]);
    await getReleaseFeed({ userId: USER, limit: 500 });
    expect(prisma.release.findMany.mock.calls[2]![0]).toMatchObject({ take: 101 });
  });
});

describe("getReleaseDetail", () => {
  it("scopes visibility to the user and returns null when not found", async () => {
    prisma.release.findFirst.mockResolvedValueOnce(null);
    await expect(getReleaseDetail(USER, "rel-hidden")).resolves.toBeNull();
    expect(prisma.release.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { AND: [{ id: "rel-hidden" }, visibleReleasesWhere(USER)] },
      }),
    );

    const row = makeFeedRow({ bodyMarkdown: "# Changelog" });
    row.repository = { ...row.repository, lastPolledAt: new Date("2026-11-03T00:00:00Z") } as never;
    prisma.release.findFirst.mockResolvedValueOnce(row);
    prisma.release.findMany.mockResolvedValueOnce([]);

    const detail = await getReleaseDetail(USER, "rel1");
    expect(detail).toMatchObject({
      id: "rel1",
      bodyMarkdown: "# Changelog",
      repositoryLastPolledAt: new Date("2026-11-03T00:00:00Z"),
    });
  });
});

describe("getDashboardData", () => {
  it("aggregates unread counts per repository and sums them per tag", async () => {
    prisma.tag.findMany.mockResolvedValueOnce([
      {
        id: "t1",
        name: "Core",
        slug: "core",
        colorHex: "#EF4444",
        subscriptions: [{ subscriptionId: "sub1" }, { subscriptionId: "sub2" }],
      },
    ]);
    prisma.userSubscription.findMany.mockResolvedValueOnce([
      {
        id: "sub1",
        repositoryId: "repo1",
        repository: { fullName: "acme/web", avatarUrl: null },
        tags: [{ tagId: "t1" }],
      },
      {
        id: "sub2",
        repositoryId: "repo2",
        repository: { fullName: "acme/api", avatarUrl: null },
        tags: [{ tagId: "t1" }],
      },
    ]);
    prisma.release.groupBy.mockResolvedValueOnce([
      { repositoryId: "repo1", _count: { _all: 3 } },
      { repositoryId: "repo2", _count: { _all: 1 } },
    ]);

    const data = await getDashboardData(USER);
    expect(data.totalUnread).toBe(4);
    expect(data.tags).toEqual([
      { id: "t1", name: "Core", slug: "core", colorHex: "#EF4444", repositoryCount: 2, unreadCount: 4 },
    ]);
    expect(data.unreadByRepository.map((r) => r.repositoryId)).toEqual(["repo1", "repo2"]);
  });
});

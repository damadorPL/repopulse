import type * as DbModule from "@repopulse/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const prisma = {
  release: {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    count: vi.fn(),
    groupBy: vi.fn(),
  },
  tag: { findMany: vi.fn() },
  userSubscription: { findMany: vi.fn() },
  userReleaseState: { findMany: vi.fn(), count: vi.fn() },
};

vi.mock("@repopulse/db", async (importOriginal) => {
  const actual = await importOriginal<typeof DbModule>();
  return { ...actual, prisma };
});

const {
  afterCursorWhere,
  buildFeedWhere,
  buildFeedWhereForSubscriptions,
  countUnread,
  decodeFeedCursor,
  encodeFeedCursor,
  findSearchUnreadReleaseIds,
  getDashboardData,
  getReleaseDetail,
  getReleaseFeed,
  getUserFeedContext,
  loadTrackedRepositories,
  visibleReleasesWhere,
  visibleReleasesWhereForSubscriptions,
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
              repository: {
                subscriptions: { some: { userId: USER, trackMode: { in: ["RELEASES", "TAGS_AND_COMMITS"] } } },
              },
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
    expect(where.AND).toEqual([visibleReleasesWhere(USER, { tags: { some: { tag: { slug: "critical" } } } })]);
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

  it.each(["", "cmabc123", "abc.cm1", "123.", "123.a b", "1".repeat(16) + ".x"])(
    "rejects malformed cursor %j",
    (cursor) => {
      expect(decodeFeedCursor(cursor)).toBeNull();
    },
  );

  it("continues strictly after the cursor row in either direction with an outer bound (no skip: 1)", () => {
    expect(afterCursorWhere(row, "desc")).toEqual({
      publishedAt: { lte: row.publishedAt },
      OR: [{ publishedAt: { lt: row.publishedAt } }, { publishedAt: row.publishedAt, id: { lt: row.id } }],
    });
    expect(afterCursorWhere(row, "asc")).toEqual({
      publishedAt: { gte: row.publishedAt },
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

    // 1st call: feed rows (limit clamped to 2 -> take 3). 2nd call: anchor rows for markNewerThanMine (flat SAOP).
    prisma.release.findMany
      .mockResolvedValueOnce([r1, r2, r3])
      .mockResolvedValueOnce([{ repositoryId: "repo1", tagName: "v1.0.0", publishedAt: r2.publishedAt }]);

    const page = await getReleaseFeed({ userId: USER, limit: 2 });
    expect(prisma.release.findMany.mock.calls[0]![0]).toMatchObject({ take: 3 });
    expect(prisma.release.findMany.mock.calls[1]![0].where).toEqual({
      repositoryId: { in: ["repo1"] },
      source: { in: ["RELEASE", "TAG"] },
      tagName: { in: expect.arrayContaining(["v1.0.0"]) },
    });
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
    prisma.userReleaseState.findMany.mockResolvedValueOnce([
      { release: { repositoryId: "repo1" } },
      { release: { repositoryId: "repo1" } },
      { release: { repositoryId: "repo1" } },
      { release: { repositoryId: "repo2" } },
    ]);

    const data = await getDashboardData(USER);
    expect(data.totalUnread).toBe(4);
    expect(data.tags).toEqual([
      { id: "t1", name: "Core", slug: "core", colorHex: "#EF4444", repositoryCount: 2, unreadCount: 4 },
    ]);
    expect(data.unreadByRepository.map((r) => r.repositoryId)).toEqual(["repo1", "repo2"]);
  });

  it("uses flat repositoryId buckets and short-circuits when user has no subscriptions", async () => {
    prisma.tag.findMany.mockResolvedValueOnce([]);
    prisma.userSubscription.findMany.mockResolvedValueOnce([]);
    const empty = await getDashboardData(USER);
    expect(empty.totalUnread).toBe(0);
    expect(prisma.userReleaseState.findMany).not.toHaveBeenCalled();

    prisma.tag.findMany.mockResolvedValueOnce([
      { id: "t1", name: "Core", slug: "core", colorHex: "#EF4444", subscriptions: [{ subscriptionId: "sub1" }] },
    ]);
    prisma.userSubscription.findMany.mockResolvedValueOnce([
      {
        id: "sub1",
        repositoryId: "repo1",
        includePrereleases: false,
        trackMode: "TAGS_AND_COMMITS",
        trackPaths: true,
        repository: { fullName: "acme/web", avatarUrl: null },
        tags: [{ tagId: "t1" }],
      },
    ]);
    prisma.userReleaseState.findMany.mockResolvedValueOnce([
      { release: { repositoryId: "repo1" } },
      { release: { repositoryId: "repo1" } },
    ]);

    const data = await getDashboardData(USER);
    expect(data.subscriptionVisibility).toEqual([
      {
        repositoryId: "repo1",
        includePrereleases: false,
        trackMode: "TAGS_AND_COMMITS",
        trackPaths: true,
        tagSlugs: ["core"],
        fullName: "acme/web",
        tagNames: ["Core"],
      },
    ]);
    expect(prisma.userReleaseState.findMany).toHaveBeenCalledWith({
      where: {
        userId: USER,
        isRead: false,
        release: visibleReleasesWhereForSubscriptions(USER, data.subscriptionVisibility, {
          assumeUserStateExists: true,
        }),
      },
      select: { release: { select: { repositoryId: true } } },
    });
  });
});

describe("getUserFeedContext & flat feed queries", () => {
  it("hydrates flat feed queries from repoContextById and drives unread views via userReleaseState", async () => {
    prisma.tag.findMany.mockResolvedValueOnce([
      { id: "t1", name: "Core", slug: "core", colorHex: "#EF4444", subscriptions: [{ subscriptionId: "sub1" }] },
    ]);
    prisma.userSubscription.findMany.mockResolvedValueOnce([
      {
        id: "sub1",
        repositoryId: "repo1",
        includePrereleases: false,
        trackMode: "RELEASES",
        trackPaths: false,
        currentVersion: null,
        repository: {
          id: "repo1",
          owner: "acme",
          name: "web",
          fullName: "acme/web",
          avatarUrl: null,
          htmlUrl: "https://github.com/acme/web",
        },
        tags: [{ tagId: "t1" }],
      },
    ]);

    const ctx = await getUserFeedContext(USER);
    expect(ctx.repoContextById.get("repo1")).toMatchObject({
      subscriptionId: "sub1",
      repository: { fullName: "acme/web" },
      tags: [{ id: "t1", name: "Core", slug: "core", colorHex: "#EF4444" }],
    });

    // All-releases feed with repoContextById skips repository/tag relation joins.
    prisma.release.findMany.mockResolvedValueOnce([
      {
        id: "rel1",
        repositoryId: "repo1",
        source: "RELEASE",
        tagName: "v1.0.0",
        title: "v1.0.0",
        htmlUrl: "https://github.com/acme/web/releases/tag/v1.0.0",
        isPrerelease: false,
        semverType: "MAJOR",
        publishedAt: new Date("2026-11-01T00:00:00.000Z"),
        userStates: [{ isRead: false }],
      },
    ]);
    const page = await getReleaseFeed({
      userId: USER,
      subscriptions: ctx.subscriptionVisibility,
      repoContextById: ctx.repoContextById,
    });
    expect(page.items[0]).toMatchObject({
      id: "rel1",
      subscriptionId: "sub1",
      repository: { fullName: "acme/web" },
      isRead: false,
    });
    expect(prisma.release.findMany.mock.calls[0]![0].select).not.toHaveProperty("repository");

    // Unread feed drives from userReleaseState.findMany using the partial unread index.
    prisma.userReleaseState.findMany.mockResolvedValueOnce([
      {
        release: {
          id: "rel2",
          repositoryId: "repo1",
          source: "RELEASE",
          tagName: "v1.1.0",
          title: "v1.1.0",
          htmlUrl: "https://github.com/acme/web/releases/tag/v1.1.0",
          isPrerelease: false,
          semverType: "MINOR",
          publishedAt: new Date("2026-11-02T00:00:00.000Z"),
        },
      },
    ]);
    const unreadPage = await getReleaseFeed({
      userId: USER,
      onlyUnread: true,
      subscriptions: ctx.subscriptionVisibility,
      repoContextById: ctx.repoContextById,
    });
    expect(unreadPage.items[0]).toMatchObject({ id: "rel2", isRead: false, repository: { fullName: "acme/web" } });
    expect(prisma.userReleaseState.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: [{ release: { publishedAt: "desc" } }, { release: { id: "desc" } }],
      }),
    );

    // countUnread queries userReleaseState.count without EXISTS semi-joins.
    prisma.userReleaseState.count.mockResolvedValueOnce(5);
    await expect(countUnread(USER, { searchQuery: "acme" }, ctx.subscriptionVisibility)).resolves.toBe(5);
    expect(prisma.userReleaseState.count).toHaveBeenCalledWith({
      where: {
        userId: USER,
        isRead: false,
        release: buildFeedWhereForSubscriptions(USER, { searchQuery: "acme" }, ctx.subscriptionVisibility, {
          omitOnlyUnread: true,
          assumeUserStateExists: true,
        }),
      },
    });
  });

  it("narrows search filters with fullName/tagNames to single-table Release OR clauses", () => {
    const subs = [
      {
        repositoryId: "r1",
        includePrereleases: false,
        trackMode: "RELEASES" as const,
        trackPaths: false,
        tagSlugs: ["core"],
        fullName: "acme/web",
        tagNames: ["Core UI"],
      },
      {
        repositoryId: "r2",
        includePrereleases: false,
        trackMode: "RELEASES" as const,
        trackPaths: false,
        tagSlugs: ["ops"],
        fullName: "other/api",
        tagNames: ["Backend"],
      },
    ];
    const where = buildFeedWhereForSubscriptions(USER, { searchQuery: "acme" }, subs);
    const searchClause = (where!.AND as unknown[])[1] as { OR: unknown[] };
    expect(searchClause.OR).toEqual([
      { tagName: { contains: "acme", mode: "insensitive" } },
      { title: { contains: "acme", mode: "insensitive" } },
      { bodyMarkdown: { contains: "acme", mode: "insensitive" } },
      { repositoryId: { in: ["r1"] } },
    ]);
  });
});

describe("visibleReleasesWhereForSubscriptions & buildFeedWhereForSubscriptions", () => {
  it("buckets subscriptions into flat repositoryId IN lists and short-circuits empty/unmatched views", () => {
    const subs = [
      {
        repositoryId: "r1",
        includePrereleases: false,
        trackMode: "RELEASES" as const,
        trackPaths: false,
        tagSlugs: ["core"],
      },
      {
        repositoryId: "r2",
        includePrereleases: true,
        trackMode: "TAGS_AND_COMMITS" as const,
        trackPaths: true,
        tagSlugs: ["infra"],
      },
    ];
    expect(visibleReleasesWhereForSubscriptions(USER, [])).toBeNull();
    expect(buildFeedWhereForSubscriptions(USER, { tagSlug: "missing" }, subs)).toBeNull();

    const filtered = buildFeedWhereForSubscriptions(USER, { tagSlug: "core", onlyUnread: true }, subs);
    expect(filtered).toEqual({
      AND: [
        {
          isDraft: false,
          source: "RELEASE",
          isPrerelease: false,
          repositoryId: { in: ["r1"] },
        },
        { userStates: { some: { userId: USER, isRead: false } } },
      ],
    });

    const repoFiltered = buildFeedWhereForSubscriptions(USER, { repositoryId: "r2" }, subs);
    expect(repoFiltered?.AND).toContainEqual({ repositoryId: "r2" });
  });
});

describe("FTS searchVector ($queryRaw) and loadTrackedRepositories LATERAL queries", () => {
  const queryRaw = vi.fn();

  beforeEach(() => {
    queryRaw.mockReset();
    (prisma as { $queryRaw?: unknown }).$queryRaw = queryRaw;
  });

  afterEach(() => {
    delete (prisma as { $queryRaw?: unknown }).$queryRaw;
  });

  it("uses searchVector + websearch_to_tsquery('english'/'simple') in getReleaseFeed and NEVER runs bodyMarkdown ILIKE", async () => {
    const subs = [
      {
        repositoryId: "r1",
        includePrereleases: false,
        trackMode: "RELEASES" as const,
        trackPaths: true,
        tagSlugs: ["core"],
        fullName: "acme/web",
        tagNames: ["Core UI"],
      },
    ];
    const repoContextById = new Map([
      [
        "r1",
        {
          repository: {
            id: "r1",
            owner: "acme",
            name: "web",
            fullName: "acme/web",
            avatarUrl: null,
            htmlUrl: "https://github.com/acme/web",
          },
          subscriptionId: "sub1",
          currentVersion: null,
          tags: [],
        },
      ],
    ]);

    queryRaw.mockResolvedValueOnce([{ id: "rel2" }, { id: "rel1" }]);
    prisma.release.findMany.mockResolvedValueOnce([
      {
        id: "rel1",
        repositoryId: "r1",
        source: "RELEASE",
        tagName: "v1.0.0",
        title: "First",
        htmlUrl: "https://github.com/acme/web/releases/tag/v1.0.0",
        isPrerelease: false,
        semverType: "MAJOR",
        publishedAt: new Date("2026-11-01T00:00:00.000Z"),
        userStates: [],
      },
      {
        id: "rel2",
        repositoryId: "r1",
        source: "RELEASE",
        tagName: "v2.0.0",
        title: "Second",
        htmlUrl: "https://github.com/acme/web/releases/tag/v2.0.0",
        isPrerelease: false,
        semverType: "MAJOR",
        publishedAt: new Date("2026-11-02T00:00:00.000Z"),
        userStates: [{ isRead: false }],
      },
    ]);

    const page = await getReleaseFeed({
      userId: USER,
      searchQuery: "100%_test\\q",
      semverType: "MAJOR",
      cursor: `${new Date("2026-11-05T00:00:00.000Z").getTime()}.rel9`,
      limit: 10,
      subscriptions: subs,
      repoContextById,
    });

    expect(queryRaw).toHaveBeenCalledTimes(1);
    const sqlObj = queryRaw.mock.calls[0]![0] as { sql: string; values: unknown[] };
    expect(sqlObj.sql).toContain("r.\"searchVector\" @@ (websearch_to_tsquery('english',");
    expect(sqlObj.sql).toContain("websearch_to_tsquery('simple',");
    expect(sqlObj.sql).toContain('r."tagName" ILIKE');
    expect(sqlObj.sql).toContain('r."title" ILIKE');
    expect(sqlObj.sql).not.toContain("bodyMarkdown");
    expect(sqlObj.values).toContain("100%_test\\q");
    expect(sqlObj.values).toContain("%100\\%\\_test\\\\q%");
    expect(sqlObj.values).toContain("MAJOR");

    // Preserves $queryRaw order (rel2 then rel1) after findMany hydration.
    expect(page.items.map((item) => item.id)).toEqual(["rel2", "rel1"]);
    expect(prisma.release.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: ["rel2", "rel1"] } } }),
    );
  });

  it("uses searchVector + websearch_to_tsquery in countUnread and findSearchUnreadReleaseIds without bodyMarkdown ILIKE", async () => {
    const subs = [
      {
        repositoryId: "r1",
        includePrereleases: false,
        trackMode: "RELEASES" as const,
        trackPaths: false,
        tagSlugs: ["core"],
        fullName: "acme/web",
        tagNames: ["Core"],
      },
    ];

    queryRaw.mockResolvedValueOnce([{ count: 7 }]);
    await expect(countUnread(USER, { searchQuery: "security fix" }, subs)).resolves.toBe(7);
    const countSql = queryRaw.mock.calls[0]![0] as { sql: string; values: unknown[] };
    expect(countSql.sql).toContain("r.\"searchVector\" @@ (websearch_to_tsquery('english',");
    expect(countSql.sql).toContain("websearch_to_tsquery('simple',");
    expect(countSql.sql).not.toContain("bodyMarkdown");
    expect(prisma.userReleaseState.count).not.toHaveBeenCalled();

    queryRaw.mockResolvedValueOnce([{ id: "r-unread-1" }, { id: "r-unread-2" }]);
    await expect(findSearchUnreadReleaseIds(USER, { searchQuery: "security fix" }, subs)).resolves.toEqual([
      "r-unread-1",
      "r-unread-2",
    ]);
    const idsSql = queryRaw.mock.calls[1]![0] as { sql: string; values: unknown[] };
    expect(idsSql.sql).toContain("r.\"searchVector\" @@ (websearch_to_tsquery('english',");
    expect(idsSql.sql).toContain("websearch_to_tsquery('simple',");
    expect(idsSql.sql).not.toContain("bodyMarkdown");
  });

  it("loadTrackedRepositories uses groupBy _count._all and CROSS JOIN LATERAL without nested _count/releases", async () => {
    prisma.userSubscription.findMany.mockResolvedValueOnce([
      {
        id: "sub1",
        includePrereleases: false,
        trackMode: "TAGS_AND_COMMITS",
        trackPaths: true,
        watchedPaths: ["src"],
        isPinned: false,
        note: null,
        notificationLevel: "ALL",
        snoozedUntil: null,
        currentVersion: null,
        createdAt: new Date("2026-10-01T00:00:00Z"),
        tags: [],
        repository: {
          id: "repo1",
          owner: "acme",
          name: "web",
          fullName: "acme/web",
          avatarUrl: null,
          htmlUrl: "https://github.com/acme/web",
          description: null,
          starsCount: 10,
          lastPolledAt: null,
          pollStatus: "IDLE",
          backfillStatus: "DONE",
          backfillNextPage: null,
          backfillTarget: 100,
        },
      },
    ]);
    prisma.release.groupBy.mockResolvedValueOnce([
      {
        repositoryId: "repo1",
        _min: { publishedAt: new Date("2026-01-01T00:00:00Z") },
        _count: { _all: 42 },
      },
    ]);
    queryRaw
      .mockResolvedValueOnce([
        {
          id: "rel1",
          repositoryId: "repo1",
          source: "RELEASE",
          tagName: "v1.0.0",
          semverType: "MAJOR",
          publishedAt: new Date("2026-11-01T00:00:00Z"),
        },
      ])
      .mockResolvedValueOnce([
        {
          id: "c1",
          repositoryId: "repo1",
          source: "COMMIT",
          tagName: "abc1234",
          semverType: "OTHER",
          publishedAt: new Date("2026-11-02T00:00:00Z"),
        },
      ]);

    const repos = await loadTrackedRepositories(USER);
    expect(prisma.userSubscription.findMany.mock.calls[0]![0].select.repository.select).not.toHaveProperty("_count");
    expect(prisma.userSubscription.findMany.mock.calls[0]![0].select.repository.select).not.toHaveProperty("releases");
    expect(prisma.release.groupBy).toHaveBeenCalledWith({
      by: ["repositoryId"],
      where: { repositoryId: { in: ["repo1"] }, isDraft: false, source: "RELEASE" },
      _min: { publishedAt: true },
      _count: { _all: true },
    });
    expect(queryRaw).toHaveBeenCalledTimes(2);
    const releasesSql = (queryRaw.mock.calls[0]![0] as { sql: string }).sql;
    expect(releasesSql).toContain("CROSS JOIN LATERAL");
    expect(releasesSql).toContain("unnest(");
    const commitsSql = (queryRaw.mock.calls[1]![0] as { sql: string }).sql;
    expect(commitsSql).toContain('r."isDraft" = false');
    expect(repos[0]).toMatchObject({
      repository: { releaseCount: 42, history: { oldestAt: new Date("2026-01-01T00:00:00Z") } },
      latestRelease: { id: "rel1" },
      latestActivityAt: new Date("2026-11-02T00:00:00Z"),
    });
  });
});

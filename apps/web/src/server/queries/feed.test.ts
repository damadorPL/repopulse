import { describe, expect, it, vi } from "vitest";

vi.mock("@repopulse/db", () => ({ prisma: {} }));

const { buildFeedWhere, visibleReleasesWhere } = await import("./feed");

const USER = "user_1";

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

const { afterCursorWhere, decodeFeedCursor, encodeFeedCursor } = await import("./feed");

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

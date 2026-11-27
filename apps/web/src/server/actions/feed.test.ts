import { beforeEach, describe, expect, it, vi } from "vitest";
import { FEED_PAGE_SIZE } from "@/lib/feed-filters";

class UnauthorizedError extends Error {}
class ForbiddenError extends Error {}

const currentUser = { id: "u1" };
const getReleaseFeed = vi.fn();
const getReleaseDetail = vi.fn();
const feedContext = {
  subscriptionVisibility: [
    { repositoryId: "repo1", includePrereleases: false, trackMode: "RELEASES", trackPaths: false, tagSlugs: ["core"] },
  ],
  repoContextById: new Map(),
};
const getUserFeedContext = vi.fn(async () => feedContext);

vi.mock("@/lib/auth", () => ({
  UnauthorizedError,
  ForbiddenError,
  getCurrentUserOrThrow: vi.fn(async () => currentUser),
}));
vi.mock("@repopulse/db", () => ({ prisma: {} }));
vi.mock("@repopulse/github", () => ({
  GitHubRateLimitError: class extends Error {},
  GitHubRepositoryNotFoundError: class extends Error {},
  InvalidRepositoryInputError: class extends Error {},
}));
vi.mock("@/server/queries/feed", () => ({ getReleaseFeed, getReleaseDetail, getUserFeedContext }));

const { getCurrentUserOrThrow } = await import("@/lib/auth");
const { getReleaseDrawerAction, loadMoreReleasesAction } = await import("./feed");

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getCurrentUserOrThrow).mockResolvedValue(currentUser as never);
  getUserFeedContext.mockResolvedValue(feedContext);
});

describe("loadMoreReleasesAction", () => {
  it("returns UNAUTHORIZED when signed out", async () => {
    vi.mocked(getCurrentUserOrThrow).mockRejectedValueOnce(new UnauthorizedError("Not signed in"));
    const result = await loadMoreReleasesAction({ query: "", cursor: "123.r1" });
    expect(result).toMatchObject({ ok: false, error: { code: "UNAUTHORIZED" } });
    expect(getReleaseFeed).not.toHaveBeenCalled();
  });

  it("returns empty page fast-path when cursor is empty or exceeds 100 chars", async () => {
    expect(await loadMoreReleasesAction({ query: "", cursor: "" })).toEqual({
      ok: true,
      data: { items: [], nextCursor: null },
    });
    expect(await loadMoreReleasesAction({ query: "", cursor: "x".repeat(101) })).toEqual({
      ok: true,
      data: { items: [], nextCursor: null },
    });
    expect(getReleaseFeed).not.toHaveBeenCalled();
  });

  it("parses query filters and forwards them to getReleaseFeed", async () => {
    const page = { items: [], nextCursor: "456.r2" };
    getReleaseFeed.mockResolvedValueOnce(page);

    const result = await loadMoreReleasesAction({
      query: "tag=core&repo=repo1&unread=1&semver=MAJOR&q=breaking&sort=oldest",
      cursor: "123.r1",
    });

    expect(result).toEqual({ ok: true, data: page });
    expect(getReleaseFeed).toHaveBeenCalledWith({
      userId: "u1",
      tagSlug: "core",
      repositoryId: "repo1",
      onlyUnread: true,
      semverType: "MAJOR",
      searchQuery: "breaking",
      sort: "oldest",
      subscriptions: feedContext.subscriptionVisibility,
      repoContextById: feedContext.repoContextById,
      cursor: "123.r1",
      limit: FEED_PAGE_SIZE,
    });
  });
});

describe("getReleaseDrawerAction", () => {
  it("returns NOT_FOUND when release is missing and strips bodyMarkdown when found", async () => {
    getReleaseDetail.mockResolvedValueOnce(null);
    await expect(getReleaseDrawerAction({ releaseId: "r-missing" })).resolves.toMatchObject({
      ok: false,
      error: { code: "NOT_FOUND" },
    });

    getReleaseDetail.mockResolvedValueOnce({
      id: "r1",
      source: "RELEASE",
      tagName: "v1.0.0",
      title: "Release 1.0.0",
      htmlUrl: "https://github.com/acme/web/releases/tag/v1.0.0",
      isPrerelease: false,
      semverType: "MAJOR",
      publishedAt: new Date("2026-11-01T00:00:00Z"),
      repository: { id: "repo1", owner: "acme", name: "web", fullName: "acme/web", avatarUrl: null, htmlUrl: "u" },
      subscriptionId: "sub1",
      tags: [],
      isRead: false,
      newerThanMine: false,
      isMyVersion: false,
      bodyMarkdown: "# Notes",
      repositoryLastPolledAt: new Date("2026-11-01T00:00:00Z"),
    });
    const res = await getReleaseDrawerAction({ releaseId: "r1" });
    expect(res).toMatchObject({ ok: true, data: { detail: { id: "r1" } } });
    if (res.ok) {
      expect(res.data.detail).not.toHaveProperty("bodyMarkdown");
      expect(res.data.detail).not.toHaveProperty("repositoryLastPolledAt");
      expect(res.data.content).toBeTruthy();
    }
  });
});

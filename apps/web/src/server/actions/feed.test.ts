import { beforeEach, describe, expect, it, vi } from "vitest";
import { FEED_PAGE_SIZE } from "@/lib/feed-filters";

class UnauthorizedError extends Error {}
class ForbiddenError extends Error {}

const currentUser = { id: "u1" };
const getReleaseFeed = vi.fn();

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
vi.mock("@/server/queries/feed", () => ({ getReleaseFeed }));

const { getCurrentUserOrThrow } = await import("@/lib/auth");
const { loadMoreReleasesAction } = await import("./feed");

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getCurrentUserOrThrow).mockResolvedValue(currentUser as never);
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
      cursor: "123.r1",
      limit: FEED_PAGE_SIZE,
    });
  });
});

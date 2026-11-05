import { beforeEach, describe, expect, it, vi } from "vitest";

class UnauthorizedError extends Error {}
class ForbiddenError extends Error {}
class GitHubRepositoryNotFoundError extends Error {}
class GitHubRateLimitError extends Error {}
class InvalidRepositoryInputError extends Error {}

const currentUser = { id: "u1", githubAccessTokenEncrypted: "enc(ghp_test)" };

const prisma = {
  repository: { findFirst: vi.fn(), upsert: vi.fn(), updateMany: vi.fn() },
  release: { createMany: vi.fn(), findMany: vi.fn(), count: vi.fn() },
  userSubscription: { upsert: vi.fn(), findFirst: vi.fn(), update: vi.fn(), delete: vi.fn() },
  tag: { findMany: vi.fn() },
  subscriptionTag: { createMany: vi.fn() },
  userReleaseState: { createMany: vi.fn(), deleteMany: vi.fn() },
  $transaction: vi.fn(async (arg: unknown) => {
    if (typeof arg === "function") return (arg as (tx: typeof prisma) => unknown)(prisma);
    if (Array.isArray(arg)) return Promise.all(arg);
    return undefined;
  }),
};

const validateAndFetchRepo = vi.fn();
const fetchRepoTree = vi.fn();
const enqueueReleaseBackfill = vi.fn();
const syncCommitStates = vi.fn();
const needsPathImport = vi.fn();
const queueRepoImport = vi.fn();
const isRealtimeConfigured = vi.fn();
const decryptToken = vi.fn((val: string) => val.replace(/^enc\((.*)\)$/, "$1"));

vi.mock("@/lib/auth", () => ({
  UnauthorizedError,
  ForbiddenError,
  getCurrentUserOrThrow: vi.fn(async () => currentUser),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@repopulse/db", () => ({ prisma, decryptToken }));
vi.mock("@repopulse/github", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@repopulse/github")>()),
  GitHubRepositoryNotFoundError,
  GitHubRateLimitError,
  InvalidRepositoryInputError,
  validateAndFetchRepo,
  fetchRepoTree,
}));
vi.mock("@/server/backfill-queue", () => ({ enqueueReleaseBackfill }));
vi.mock("@/server/commit-states", () => ({ syncCommitStates, needsPathImport }));
vi.mock("@/server/realtime", () => ({ isRealtimeConfigured }));
vi.mock("@/server/repo-poll-queue", () => ({ queueRepoImport }));

const { getCurrentUserOrThrow } = await import("@/lib/auth");
const {
  addRepositoryAction,
  listRepositoryPathsAction,
  removeSubscriptionAction,
  updateSubscriptionSettingsAction,
  updateTrackModeAction,
} = await import("./repositories");

const baseRepoState = {
  id: "repo1",
  fullName: "acme/web",
  backfillStatus: "NONE" as const,
  lastTagsPolledAt: null,
  lastPathsPolledAt: null,
  polledPaths: [] as string[],
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getCurrentUserOrThrow).mockResolvedValue(currentUser as never);
  isRealtimeConfigured.mockReturnValue(true);
  needsPathImport.mockReturnValue(false);
  syncCommitStates.mockResolvedValue({ matching: 0, unread: [], read: [], prune: [] });
  prisma.repository.findFirst.mockResolvedValue(null);
  prisma.repository.upsert.mockResolvedValue(baseRepoState);
  prisma.repository.updateMany.mockResolvedValue({ count: 1 });
  prisma.userSubscription.upsert.mockResolvedValue({ id: "sub1" });
  prisma.release.findMany.mockResolvedValue([{ id: "rel1" }, { id: "rel2" }]);
  prisma.release.count.mockResolvedValue(2);
  validateAndFetchRepo.mockResolvedValue({
    repository: {
      githubRepoId: 100,
      owner: "acme",
      name: "web",
      fullName: "acme/web",
      description: "Desc",
      avatarUrl: null,
      htmlUrl: "https://github.com/acme/web",
      starsCount: 10,
    },
    releases: [{ githubReleaseId: 1, tagName: "v1.0.0" }],
    etag: "W/\"1\"",
  });
});

describe("addRepositoryAction", () => {
  it("returns UNAUTHORIZED when signed out", async () => {
    vi.mocked(getCurrentUserOrThrow).mockRejectedValueOnce(new UnauthorizedError("Not signed in"));
    const result = await addRepositoryAction({ repoUrlOrSlug: "acme/web", includePrereleases: false, tagIds: [] });
    expect(result).toMatchObject({ ok: false, error: { code: "UNAUTHORIZED" } });
    expect(validateAndFetchRepo).not.toHaveBeenCalled();
  });

  it("validates empty slug, nothing-tracked combination, and invalid or too many watchedPaths", async () => {
    expect(await addRepositoryAction({ repoUrlOrSlug: "   ", includePrereleases: false, tagIds: [] })).toMatchObject({
      ok: false,
      error: { code: "INVALID_INPUT" },
    });
    expect(
      await addRepositoryAction({
        repoUrlOrSlug: "acme/web",
        includePrereleases: false,
        trackMode: "NONE",
        trackPaths: false,
        tagIds: [],
      }),
    ).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
    expect(
      await addRepositoryAction({
        repoUrlOrSlug: "acme/web",
        includePrereleases: false,
        trackMode: "NONE",
        trackPaths: true,
        watchedPaths: ["../secret"],
        tagIds: [],
      }),
    ).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
    expect(
      await addRepositoryAction({
        repoUrlOrSlug: "acme/web",
        includePrereleases: false,
        trackPaths: true,
        watchedPaths: Array.from({ length: 51 }, (_, i) => `src/file-${i}.ts`),
        tagIds: [],
      }),
    ).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
    expect(validateAndFetchRepo).not.toHaveBeenCalled();
  });

  it("skips validateAndFetchRepo when the repository already exists with stored releases", async () => {
    prisma.repository.findFirst.mockResolvedValueOnce({
      ...baseRepoState,
      backfillStatus: "DONE",
      _count: { releases: 5 },
    });

    const result = await addRepositoryAction({ repoUrlOrSlug: "acme/web", includePrereleases: false, tagIds: [] });
    expect(result).toMatchObject({ ok: true, data: { repositoryId: "repo1", subscriptionId: "sub1" } });
    expect(validateAndFetchRepo).not.toHaveBeenCalled();
    expect(prisma.repository.upsert).not.toHaveBeenCalled();
    expect(enqueueReleaseBackfill).not.toHaveBeenCalled();
  });

  it("attaches only tags belonging to the current user", async () => {
    prisma.tag.findMany.mockResolvedValueOnce([{ id: "tag-mine" }]);

    await addRepositoryAction({
      repoUrlOrSlug: "acme/web",
      includePrereleases: false,
      tagIds: ["tag-mine", "tag-theirs"],
    });

    expect(prisma.tag.findMany).toHaveBeenCalledWith({
      where: { id: { in: ["tag-mine", "tag-theirs"] }, userId: "u1" },
      select: { id: true },
    });
    expect(prisma.subscriptionTag.createMany).toHaveBeenCalledWith({
      data: [{ subscriptionId: "sub1", tagId: "tag-mine" }],
      skipDuplicates: true,
    });
  });

  it("seeds initial userReleaseState respecting includePrereleases and trackMode, and queues backfill & imports", async () => {
    needsPathImport.mockReturnValueOnce(true);
    syncCommitStates.mockResolvedValueOnce({ matching: 3, unread: ["c1"], read: [], prune: [] });

    const result = await addRepositoryAction({
      repoUrlOrSlug: "acme/web",
      includePrereleases: true,
      trackMode: "TAGS_AND_COMMITS",
      trackPaths: true,
      watchedPaths: ["packages/db"],
      tagIds: [],
    });

    expect(result).toEqual({
      ok: true,
      data: {
        subscriptionId: "sub1",
        repositoryId: "repo1",
        fullName: "acme/web",
        releasesCount: 2,
        commitsCount: 3,
        importingTags: true,
        importingPaths: true,
      },
    });
    expect(prisma.release.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          repositoryId: "repo1",
          isDraft: false,
          source: { in: ["RELEASE", "TAG"] },
        },
      }),
    );
    expect(prisma.userReleaseState.createMany).toHaveBeenCalledWith({
      data: [
        { userId: "u1", releaseId: "rel1" },
        { userId: "u1", releaseId: "rel2" },
      ],
      skipDuplicates: true,
    });
    expect(enqueueReleaseBackfill).toHaveBeenCalledWith({ repositoryId: "repo1", trigger: "add" }, expect.any(Number));
    expect(queueRepoImport).toHaveBeenCalledWith("repo1", "addRepositoryAction");
  });

  it("does not seed release states when trackMode is NONE", async () => {
    const result = await addRepositoryAction({
      repoUrlOrSlug: "acme/web",
      includePrereleases: false,
      trackMode: "NONE",
      trackPaths: true,
      watchedPaths: ["src"],
      tagIds: [],
    });
    expect(result).toMatchObject({ ok: true, data: { releasesCount: 0 } });
    expect(prisma.release.findMany).not.toHaveBeenCalled();
    expect(prisma.userReleaseState.createMany).not.toHaveBeenCalled();
  });
});

describe("updateTrackModeAction", () => {
  it("returns NOT_FOUND for another user's subscription", async () => {
    prisma.userSubscription.findFirst.mockResolvedValueOnce(null);
    const result = await updateTrackModeAction({
      subscriptionId: "sub-other",
      trackMode: "RELEASES",
      trackPaths: false,
    });
    expect(result).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    expect(prisma.userSubscription.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "sub-other", userId: "u1" } }),
    );
  });

  it("rejects trackMode NONE with trackPaths false", async () => {
    const result = await updateTrackModeAction({
      subscriptionId: "sub1",
      trackMode: "NONE",
      trackPaths: false,
    });
    expect(result).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
    expect(prisma.userSubscription.findFirst).not.toHaveBeenCalled();
  });

  it("falls back to stored watchedPaths when input.watchedPaths is omitted", async () => {
    prisma.userSubscription.findFirst.mockResolvedValueOnce({
      id: "sub1",
      repositoryId: "repo1",
      watchedPaths: ["docs", "apps/web"],
      repository: baseRepoState,
    });
    needsPathImport.mockReturnValueOnce(true);

    const result = await updateTrackModeAction({
      subscriptionId: "sub1",
      trackMode: "NONE",
      trackPaths: true,
    });

    expect(result).toEqual({
      ok: true,
      data: {
        subscriptionId: "sub1",
        trackMode: "NONE",
        trackPaths: true,
        watchedPaths: ["docs", "apps/web"],
        importingTags: false,
        importingPaths: true,
      },
    });
    expect(syncCommitStates).toHaveBeenCalledWith(prisma, "u1", "repo1", ["docs", "apps/web"]);
    expect(queueRepoImport).toHaveBeenCalledWith("repo1", "updateTrackModeAction");
  });
});

describe("removeSubscriptionAction", () => {
  it("returns NOT_FOUND when subscription does not belong to the user", async () => {
    prisma.userSubscription.findFirst.mockResolvedValueOnce(null);
    const result = await removeSubscriptionAction({ subscriptionId: "sub-other" });
    expect(result).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("deletes only the user's release states and subscription row in a transaction", async () => {
    prisma.userSubscription.findFirst.mockResolvedValueOnce({ id: "sub1", repositoryId: "repo1" });
    prisma.userReleaseState.deleteMany.mockResolvedValueOnce({ count: 3 });
    prisma.userSubscription.delete.mockResolvedValueOnce({ id: "sub1" });

    const result = await removeSubscriptionAction({ subscriptionId: "sub1" });
    expect(result).toEqual({ ok: true, data: { subscriptionId: "sub1" } });
    expect(prisma.userReleaseState.deleteMany).toHaveBeenCalledWith({
      where: { userId: "u1", release: { repositoryId: "repo1" } },
    });
    expect(prisma.userSubscription.delete).toHaveBeenCalledWith({ where: { id: "sub1" } });
  });
});

describe("listRepositoryPathsAction", () => {
  it("validates input and passes decrypted token to fetchRepoTree", async () => {
    expect(await listRepositoryPathsAction({ repoUrlOrSlug: "  " })).toMatchObject({
      ok: false,
      error: { code: "INVALID_INPUT" },
    });

    const tree = { defaultBranch: "main", entries: [{ path: "src", type: "tree" as const }], truncated: false };
    fetchRepoTree.mockResolvedValueOnce(tree);

    const result = await listRepositoryPathsAction({ repoUrlOrSlug: "acme/web" });
    expect(result).toEqual({ ok: true, data: tree });
    expect(fetchRepoTree).toHaveBeenCalledWith(
      expect.objectContaining({ owner: "acme", name: "web", accessToken: "ghp_test" }),
    );
  });

  it("maps GitHubRepositoryNotFoundError to NOT_FOUND and GitHubRateLimitError to RATE_LIMITED", async () => {
    fetchRepoTree.mockRejectedValueOnce(new GitHubRepositoryNotFoundError("acme/missing"));
    expect(await listRepositoryPathsAction({ repoUrlOrSlug: "acme/missing" })).toMatchObject({
      ok: false,
      error: { code: "NOT_FOUND" },
    });

    fetchRepoTree.mockRejectedValueOnce(new GitHubRateLimitError("Rate limit exceeded"));
    expect(await listRepositoryPathsAction({ repoUrlOrSlug: "acme/web" })).toMatchObject({
      ok: false,
      error: { code: "RATE_LIMITED" },
    });
  });
});

describe("updateSubscriptionSettingsAction", () => {
  const updatedRow = {
    id: "sub1",
    includePrereleases: true,
    isPinned: false,
    note: null,
    notificationLevel: "ALL" as const,
    snoozedUntil: null,
    currentVersion: null,
  };

  it("rejects empty updates, unknown fields, and invalid snooze dates", async () => {
    expect(await updateSubscriptionSettingsAction({ subscriptionId: "sub1" })).toMatchObject({
      ok: false,
      error: { code: "INVALID_INPUT" },
    });
    expect(
      await updateSubscriptionSettingsAction({ subscriptionId: "sub1", isPinned: true, extra: 1 } as never),
    ).toMatchObject({
      ok: false,
      error: { code: "INVALID_INPUT" },
    });
    expect(
      await updateSubscriptionSettingsAction({
        subscriptionId: "sub1",
        snoozedUntil: new Date(Date.now() - 60_000).toISOString(),
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "INVALID_INPUT" },
    });
    expect(prisma.userSubscription.findFirst).not.toHaveBeenCalled();
  });

  it("returns NOT_FOUND for another user's subscription", async () => {
    prisma.userSubscription.findFirst.mockResolvedValueOnce(null);
    const result = await updateSubscriptionSettingsAction({ subscriptionId: "sub-other", isPinned: true });
    expect(result).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    expect(prisma.userSubscription.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "sub-other", userId: "u1" } }),
    );
  });

  it("seeds unread states for pre-releases when toggling includePrereleases from false to true", async () => {
    prisma.userSubscription.findFirst.mockResolvedValueOnce({
      id: "sub1",
      repositoryId: "repo1",
      trackMode: "RELEASES",
      includePrereleases: false,
    });
    prisma.userSubscription.update.mockResolvedValueOnce({ ...updatedRow, includePrereleases: true });
    prisma.release.findMany.mockResolvedValueOnce([
      { id: "rel-stable", isPrerelease: false },
      { id: "rel-rc1", isPrerelease: true },
    ]);

    const result = await updateSubscriptionSettingsAction({ subscriptionId: "sub1", includePrereleases: true });
    expect(result).toMatchObject({ ok: true, data: { subscriptionId: "sub1", includePrereleases: true } });
    expect(prisma.userReleaseState.createMany).toHaveBeenCalledWith({
      data: [{ userId: "u1", releaseId: "rel-rc1" }],
      skipDuplicates: true,
    });
  });

  it("deletes unread pre-release states (preserving read and commit states) when toggling includePrereleases from true to false", async () => {
    prisma.userSubscription.findFirst.mockResolvedValueOnce({
      id: "sub1",
      repositoryId: "repo1",
      trackMode: "TAGS_AND_COMMITS",
      includePrereleases: true,
    });
    prisma.userSubscription.update.mockResolvedValueOnce({ ...updatedRow, includePrereleases: false });

    const result = await updateSubscriptionSettingsAction({ subscriptionId: "sub1", includePrereleases: false });
    expect(result).toMatchObject({ ok: true, data: { subscriptionId: "sub1", includePrereleases: false } });
    expect(prisma.userReleaseState.deleteMany).toHaveBeenCalledWith({
      where: {
        userId: "u1",
        isRead: false,
        release: { repositoryId: "repo1", isPrerelease: true, source: { in: ["RELEASE", "TAG"] } },
      },
    });
  });
});

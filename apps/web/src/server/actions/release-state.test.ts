import { beforeEach, describe, expect, it, vi } from "vitest";

class UnauthorizedError extends Error {}
class ForbiddenError extends Error {}

const currentUser = { id: "u1" };

const prisma = {
  release: { findFirst: vi.fn() },
  userReleaseState: { upsert: vi.fn(), updateMany: vi.fn() },
};

vi.mock("@/lib/auth", () => ({
  UnauthorizedError,
  ForbiddenError,
  getCurrentUserOrThrow: vi.fn(async () => currentUser),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@repopulse/db", () => ({ prisma }));
vi.mock("@repopulse/github", () => ({
  GitHubRateLimitError: class extends Error {},
  GitHubRepositoryNotFoundError: class extends Error {},
  InvalidRepositoryInputError: class extends Error {},
}));

const { buildFeedWhere, visibleReleasesWhere } = await import("@/server/queries/feed");
const { markAllReadAction, toggleReleaseReadAction } = await import("./release-state");

beforeEach(() => {
  vi.clearAllMocks();
});

describe("toggleReleaseReadAction", () => {
  it("returns NOT_FOUND when release is not visible to the user (unsubscribed or hidden)", async () => {
    prisma.release.findFirst.mockResolvedValueOnce(null);
    const result = await toggleReleaseReadAction({ releaseId: "rel-hidden", isRead: true });
    expect(result).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    expect(prisma.release.findFirst).toHaveBeenCalledWith({
      where: { AND: [{ id: "rel-hidden" }, visibleReleasesWhere("u1")] },
      select: { id: true },
    });
    expect(prisma.userReleaseState.upsert).not.toHaveBeenCalled();
  });

  it("upserts readAt Date when marking read and null when marking unread", async () => {
    prisma.release.findFirst.mockResolvedValue({ id: "rel1" });

    const readRes = await toggleReleaseReadAction({ releaseId: "rel1", isRead: true });
    expect(readRes).toEqual({ ok: true, data: { releaseId: "rel1", isRead: true } });
    expect(prisma.userReleaseState.upsert).toHaveBeenCalledWith({
      where: { userId_releaseId: { userId: "u1", releaseId: "rel1" } },
      create: { userId: "u1", releaseId: "rel1", isRead: true, readAt: expect.any(Date) },
      update: { isRead: true, readAt: expect.any(Date) },
    });

    const unreadRes = await toggleReleaseReadAction({ releaseId: "rel1", isRead: false });
    expect(unreadRes).toEqual({ ok: true, data: { releaseId: "rel1", isRead: false } });
    expect(prisma.userReleaseState.upsert).toHaveBeenLastCalledWith({
      where: { userId_releaseId: { userId: "u1", releaseId: "rel1" } },
      create: { userId: "u1", releaseId: "rel1", isRead: false, readAt: null },
      update: { isRead: false, readAt: null },
    });
  });
});

describe("markAllReadAction", () => {
  it("updates unread release states scoped to the user and buildFeedWhere filters", async () => {
    prisma.userReleaseState.updateMany.mockResolvedValueOnce({ count: 4 });
    const filters = { tagSlug: "frontend", semverType: "MAJOR" as const, searchQuery: "react" };

    const result = await markAllReadAction(filters);
    expect(result).toEqual({ ok: true, data: { count: 4 } });
    expect(prisma.userReleaseState.updateMany).toHaveBeenCalledWith({
      where: {
        userId: "u1",
        isRead: false,
        release: buildFeedWhere("u1", filters),
      },
      data: { isRead: true, readAt: expect.any(Date) },
    });
  });
});

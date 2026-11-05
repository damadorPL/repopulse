import { beforeEach, describe, expect, it, vi } from "vitest";

class UnauthorizedError extends Error {}
class ForbiddenError extends Error {}
class RealtimeUnavailableError extends Error {}

const currentUser = { id: "u1" };

const prisma = {
  userSubscription: { findUnique: vi.fn() },
  repository: { updateMany: vi.fn(), findUnique: vi.fn() },
};

const enqueueReleaseBackfill = vi.fn();
const getBackfillConfig = vi.fn();

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
vi.mock("@/server/backfill-queue", () => ({ enqueueReleaseBackfill }));
vi.mock("@/server/backfill-settings", () => ({ getBackfillConfig }));
vi.mock("@/server/realtime", () => ({ RealtimeUnavailableError }));

const { requestDeepBackfillAction } = await import("./backfill");

beforeEach(() => {
  vi.clearAllMocks();
  getBackfillConfig.mockResolvedValue({
    defaultTarget: 100,
    maxAgeDays: 365,
    hardCap: 500,
    minQuota: 500,
    deepStep: 100,
    deepCooldownMinutes: 10,
  });
  prisma.repository.updateMany.mockResolvedValue({ count: 1 });
});

describe("requestDeepBackfillAction", () => {
  it("returns NOT_FOUND when user is not subscribed to the repository", async () => {
    prisma.userSubscription.findUnique.mockResolvedValueOnce(null);
    const result = await requestDeepBackfillAction({ repositoryId: "repo1" });
    expect(result).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    expect(prisma.userSubscription.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId_repositoryId: { userId: "u1", repositoryId: "repo1" } } }),
    );
  });

  it.each(["QUEUED", "RUNNING"] as const)("returns IN_PROGRESS when status is %s", async (backfillStatus) => {
    prisma.userSubscription.findUnique.mockResolvedValueOnce({
      repository: {
        fullName: "acme/web",
        backfillStatus,
        backfillTarget: 100,
        backfillNextPage: 2,
        backfillRequestedAt: null,
      },
    });
    const result = await requestDeepBackfillAction({ repositoryId: "repo1" });
    expect(result).toEqual({ ok: true, data: { status: "IN_PROGRESS", fullName: "acme/web" } });
    expect(prisma.repository.updateMany).not.toHaveBeenCalled();
  });

  it("returns AT_CAP when status is PARTIAL or backfillTarget >= hardCap", async () => {
    prisma.userSubscription.findUnique.mockResolvedValueOnce({
      repository: {
        fullName: "acme/web",
        backfillStatus: "PARTIAL",
        backfillTarget: 200,
        backfillNextPage: 3,
        backfillRequestedAt: null,
      },
    });
    expect(await requestDeepBackfillAction({ repositoryId: "repo1" })).toEqual({
      ok: true,
      data: { status: "AT_CAP", fullName: "acme/web", hardCap: 500 },
    });

    prisma.userSubscription.findUnique.mockResolvedValueOnce({
      repository: {
        fullName: "acme/web",
        backfillStatus: "DONE",
        backfillTarget: 500,
        backfillNextPage: 6,
        backfillRequestedAt: null,
      },
    });
    expect(await requestDeepBackfillAction({ repositoryId: "repo1" })).toEqual({
      ok: true,
      data: { status: "AT_CAP", fullName: "acme/web", hardCap: 500 },
    });
  });

  it("returns COMPLETE when status is DONE and backfillNextPage is null", async () => {
    prisma.userSubscription.findUnique.mockResolvedValueOnce({
      repository: {
        fullName: "acme/web",
        backfillStatus: "DONE",
        backfillTarget: 100,
        backfillNextPage: null,
        backfillRequestedAt: null,
      },
    });
    expect(await requestDeepBackfillAction({ repositoryId: "repo1" })).toEqual({
      ok: true,
      data: { status: "COMPLETE", fullName: "acme/web" },
    });
  });

  it.each(["NONE", "ERROR"] as const)("enqueues with trigger 'retry' and keeps target when status is %s", async (backfillStatus) => {
    prisma.userSubscription.findUnique.mockResolvedValueOnce({
      repository: {
        fullName: "acme/web",
        backfillStatus,
        backfillTarget: 100,
        backfillNextPage: null,
        backfillRequestedAt: null,
      },
    });

    const result = await requestDeepBackfillAction({ repositoryId: "repo1" });
    expect(result).toEqual({
      ok: true,
      data: { status: "QUEUED", fullName: "acme/web", target: 100, retry: true },
    });
    expect(enqueueReleaseBackfill).toHaveBeenCalledWith({ repositoryId: "repo1", trigger: "retry" }, 1);
  });

  it("raises target by deepStep (clamped to hardCap) and enqueues with trigger 'deep' when DONE with more pages", async () => {
    prisma.userSubscription.findUnique.mockResolvedValueOnce({
      repository: {
        fullName: "acme/web",
        backfillStatus: "DONE",
        backfillTarget: 450,
        backfillNextPage: 5,
        backfillRequestedAt: null,
      },
    });

    const result = await requestDeepBackfillAction({ repositoryId: "repo1" });
    expect(result).toEqual({
      ok: true,
      data: { status: "QUEUED", fullName: "acme/web", target: 500, retry: false },
    });
    expect(enqueueReleaseBackfill).toHaveBeenCalledWith({ repositoryId: "repo1", trigger: "deep" }, 1);
  });

  it("returns COOLDOWN when claim updateMany returns count 0 and backfillRequestedAt is within cooldown window", async () => {
    prisma.userSubscription.findUnique.mockResolvedValueOnce({
      repository: {
        fullName: "acme/web",
        backfillStatus: "DONE",
        backfillTarget: 100,
        backfillNextPage: 2,
        backfillRequestedAt: null,
      },
    });
    prisma.repository.updateMany.mockResolvedValueOnce({ count: 0 });
    prisma.repository.findUnique.mockResolvedValueOnce({
      backfillRequestedAt: new Date(Date.now() - 60_000),
    });

    const result = await requestDeepBackfillAction({ repositoryId: "repo1" });
    expect(result).toMatchObject({
      ok: true,
      data: { status: "COOLDOWN", fullName: "acme/web", cooldownMinutes: 10 },
    });
    if (result.ok && result.data.status === "COOLDOWN") {
      expect(result.data.retryAfterSeconds).toBeGreaterThan(500);
    }
    expect(enqueueReleaseBackfill).not.toHaveBeenCalled();
  });

  it("rolls back the claim and returns UNAVAILABLE when enqueueReleaseBackfill throws RealtimeUnavailableError", async () => {
    const prevRequestedAt = new Date("2026-10-01T00:00:00Z");
    prisma.userSubscription.findUnique.mockResolvedValueOnce({
      repository: {
        fullName: "acme/web",
        backfillStatus: "DONE",
        backfillTarget: 100,
        backfillNextPage: 2,
        backfillRequestedAt: prevRequestedAt,
      },
    });
    enqueueReleaseBackfill.mockRejectedValueOnce(new RealtimeUnavailableError("Redis down"));

    const result = await requestDeepBackfillAction({ repositoryId: "repo1" });
    expect(result).toEqual({ ok: false, error: { code: "UNAVAILABLE", message: "Redis down" } });
    expect(prisma.repository.updateMany).toHaveBeenCalledTimes(2);
    expect(prisma.repository.updateMany).toHaveBeenLastCalledWith({
      where: { id: "repo1", backfillStatus: "QUEUED", backfillRequestedAt: expect.any(Date) },
      data: { backfillStatus: "DONE", backfillTarget: 100, backfillRequestedAt: prevRequestedAt },
    });
  });
});

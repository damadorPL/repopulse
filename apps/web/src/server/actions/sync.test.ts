import { beforeEach, describe, expect, it, vi } from "vitest";
import { JOB_NAMES, REPO_POLL_PRIORITY } from "@repopulse/queue";

class UnauthorizedError extends Error {}
class ForbiddenError extends Error {}
class RealtimeUnavailableError extends Error {}

const currentUser = { id: "u1" };

const prisma = {
  userSubscription: { findUnique: vi.fn() },
};

const queueAdd = vi.fn();
const queueGetJob = vi.fn();
const publishToUser = vi.fn();

vi.mock("@/lib/auth", () => ({
  UnauthorizedError,
  ForbiddenError,
  getCurrentUserOrThrow: vi.fn(async () => currentUser),
}));
vi.mock("@repopulse/db", () => ({ prisma }));
vi.mock("@repopulse/github", () => ({
  GitHubRateLimitError: class extends Error {},
  GitHubRepositoryNotFoundError: class extends Error {},
  InvalidRepositoryInputError: class extends Error {},
}));
vi.mock("@/server/realtime", () => ({
  RealtimeUnavailableError,
  getRepoPollQueue: () => ({ add: queueAdd, getJob: queueGetJob }),
  publishToUser,
  withRedisTimeout: <T>(op: Promise<T>) => op,
}));

const { triggerManualRepoSyncAction } = await import("./sync");

beforeEach(() => {
  vi.clearAllMocks();
  queueGetJob.mockResolvedValue(null);
});

describe("triggerManualRepoSyncAction", () => {
  it("returns NOT_FOUND when user is not subscribed to the repository", async () => {
    prisma.userSubscription.findUnique.mockResolvedValueOnce(null);
    const result = await triggerManualRepoSyncAction({ repositoryId: "repo1" });
    expect(result).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    expect(queueAdd).not.toHaveBeenCalled();
  });

  it("enforces the 5-minute cooldown when lastPolledAt is recent", async () => {
    prisma.userSubscription.findUnique.mockResolvedValueOnce({
      repository: { fullName: "acme/web", lastPolledAt: new Date(Date.now() - 60_000) },
    });
    const result = await triggerManualRepoSyncAction({ repositoryId: "repo1" });
    expect(result).toMatchObject({ ok: true, data: { status: "COOLDOWN", fullName: "acme/web" } });
    if (result.ok && result.data.status === "COOLDOWN") {
      expect(result.data.retryAfterSeconds).toBeGreaterThan(200);
    }
    expect(queueAdd).not.toHaveBeenCalled();
    expect(publishToUser).not.toHaveBeenCalled();
  });

  it("adds a new priority job when no existing job is in the queue", async () => {
    prisma.userSubscription.findUnique.mockResolvedValueOnce({
      repository: { fullName: "acme/web", lastPolledAt: new Date(Date.now() - 10 * 60_000) },
    });

    const result = await triggerManualRepoSyncAction({ repositoryId: "repo1" });
    expect(result).toEqual({ ok: true, data: { status: "QUEUED", fullName: "acme/web" } });
    expect(queueAdd).toHaveBeenCalledWith(
      JOB_NAMES.poll,
      { repositoryId: "repo1", trigger: "manual", requestedByUserId: "u1" },
      { jobId: "poll-repo1", priority: REPO_POLL_PRIORITY.manual },
    );
    expect(publishToUser).toHaveBeenCalledWith("u1", {
      type: "SYNC_STARTED",
      repositoryId: "repo1",
      repositoryName: "acme/web",
    });
  });

  it.each(["waiting", "prioritized"] as const)(
    "updates data and bumps priority when existing job is %s",
    async (state) => {
      prisma.userSubscription.findUnique.mockResolvedValueOnce({
        repository: { fullName: "acme/web", lastPolledAt: null },
      });
      const updateData = vi.fn();
      const changePriority = vi.fn();
      queueGetJob.mockResolvedValueOnce({
        getState: vi.fn(async () => state),
        updateData,
        changePriority,
      });

      const result = await triggerManualRepoSyncAction({ repositoryId: "repo1" });
      expect(result).toEqual({ ok: true, data: { status: "QUEUED", fullName: "acme/web" } });
      expect(updateData).toHaveBeenCalledWith({
        repositoryId: "repo1",
        trigger: "manual",
        requestedByUserId: "u1",
      });
      expect(changePriority).toHaveBeenCalledWith({ priority: REPO_POLL_PRIORITY.manual });
      expect(queueAdd).not.toHaveBeenCalled();
    },
  );

  it("updates data without calling changePriority when existing job is delayed", async () => {
    prisma.userSubscription.findUnique.mockResolvedValueOnce({
      repository: { fullName: "acme/web", lastPolledAt: null },
    });
    const updateData = vi.fn();
    const changePriority = vi.fn();
    queueGetJob.mockResolvedValueOnce({
      getState: vi.fn(async () => "delayed"),
      updateData,
      changePriority,
    });

    await triggerManualRepoSyncAction({ repositoryId: "repo1" });
    expect(updateData).toHaveBeenCalledTimes(1);
    expect(changePriority).not.toHaveBeenCalled();
  });

  it("leaves an active job untouched", async () => {
    prisma.userSubscription.findUnique.mockResolvedValueOnce({
      repository: { fullName: "acme/web", lastPolledAt: null },
    });
    const updateData = vi.fn();
    const changePriority = vi.fn();
    queueGetJob.mockResolvedValueOnce({
      getState: vi.fn(async () => "active"),
      updateData,
      changePriority,
    });

    await triggerManualRepoSyncAction({ repositoryId: "repo1" });
    expect(updateData).not.toHaveBeenCalled();
    expect(changePriority).not.toHaveBeenCalled();
  });

  it("maps RealtimeUnavailableError to UNAVAILABLE", async () => {
    prisma.userSubscription.findUnique.mockResolvedValueOnce({
      repository: { fullName: "acme/web", lastPolledAt: null },
    });
    queueGetJob.mockRejectedValueOnce(new RealtimeUnavailableError("Redis unavailable"));

    const result = await triggerManualRepoSyncAction({ repositoryId: "repo1" });
    expect(result).toEqual({ ok: false, error: { code: "UNAVAILABLE", message: "Redis unavailable" } });
  });
});

import { describe, expect, it, vi } from "vitest";
import type { Job } from "bullmq";
import { GitHubRateLimitError, GitHubRepositoryNotFoundError, type pollRepoReleases } from "@repopulse/github";
import type { RepoPollJobData } from "@repopulse/queue";

vi.mock("@repopulse/db", () => ({
  decryptToken: (value: string) => {
    if (value === "corrupt") throw new Error("bad key");
    return `plain:${value}`;
  },
}));

const { MAX_ERROR_COUNT, processRepoPoll } = await import("./repo-poll.processor");

const REPO = { id: "repo1", owner: "acme", name: "widget", fullName: "acme/widget", lastEtag: '"old"' };

/** Minimal stand-in for the Prisma calls made by the processor (no transaction path). */
function fakePrisma(options: { errorCount?: number; subscribers?: number; tokens?: Array<[string, string]> } = {}) {
  const repo = { ...REPO, errorCount: options.errorCount ?? 0, pollStatus: "IDLE" as string };
  const updates: Array<Record<string, unknown>> = [];
  const prisma = {
    repository: {
      findUnique: vi.fn(async () => ({ ...REPO, _count: { subscriptions: options.subscribers ?? 1 } })),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        updates.push(data);
        const inc = data.errorCount as { increment?: number } | number | undefined;
        if (typeof inc === "number") repo.errorCount = inc;
        else if (inc?.increment) repo.errorCount += inc.increment;
        if (typeof data.pollStatus === "string") repo.pollStatus = data.pollStatus;
        return { errorCount: repo.errorCount };
      }),
    },
    userSubscription: {
      findMany: vi.fn(async () =>
        (options.tokens ?? []).map(([userId, enc]) => ({ userId, user: { githubAccessTokenEncrypted: enc } })),
      ),
    },
  };
  return { prisma, repo, updates };
}

function job(data: Partial<RepoPollJobData> = {}, attemptsMade = 0): Job<RepoPollJobData> {
  return { data: { repositoryId: REPO.id, trigger: "schedule", ...data }, attemptsMade, opts: { attempts: 3 } } as Job<RepoPollJobData>;
}

function deps(prisma: unknown, poll: typeof pollRepoReleases) {
  return {
    prisma: prisma as never,
    redis: { publish: vi.fn(async () => 1) },
    repoPollQueue: { rateLimit: vi.fn(async () => undefined) },
    notificationQueue: { addBulk: vi.fn(async () => []) },
    poll,
    now: () => new Date("2026-10-31T12:00:00Z"),
  };
}

const notModified = vi.fn(async () => ({ status: "NOT_MODIFIED" as const, etag: '"old"', releases: [] as [], rateLimitRemaining: 4999 }));

describe("processRepoPoll", () => {
  it("skips repositories nobody subscribes to any more", async () => {
    const { prisma } = fakePrisma({ subscribers: 0 });
    const d = deps(prisma, notModified);
    expect(await processRepoPoll(job(), d)).toEqual({ status: "SKIPPED", reason: "NO_SUBSCRIBERS" });
    expect(prisma.repository.update).not.toHaveBeenCalled();
  });

  it("on 304 marks the repo IDLE, resets errorCount and tells the requester", async () => {
    const { prisma, repo, updates } = fakePrisma({ errorCount: 3 });
    const d = deps(prisma, notModified);

    expect(await processRepoPoll(job({ trigger: "manual", requestedByUserId: "u1" }), d)).toEqual({ status: "NOT_MODIFIED" });

    expect(updates[0]).toEqual({ pollStatus: "POLLING" });
    expect(repo).toMatchObject({ pollStatus: "IDLE", errorCount: 0 });
    expect(notModified).toHaveBeenLastCalledWith(expect.objectContaining({ lastEtag: '"old"', owner: "acme", name: "widget" }));
    expect(d.redis.publish).toHaveBeenCalledWith(
      "user:u1:events",
      JSON.stringify({ type: "SYNC_COMPLETED", repositoryId: "repo1", repositoryName: "acme/widget", result: "NOT_MODIFIED", newReleases: 0 }),
    );
  });

  it("uses the requester's token first and falls back past a rejected (401) token", async () => {
    const { prisma } = fakePrisma({ tokens: [["u2", "t2"], ["u1", "t1"], ["u3", "corrupt"]] });
    const poll = vi.fn(async ({ accessToken }: { accessToken?: string | null }) => {
      if (accessToken === "plain:t1") throw Object.assign(new Error("Bad credentials"), { status: 401 });
      return { status: "NOT_MODIFIED" as const, etag: null, releases: [] as [], rateLimitRemaining: null };
    });

    await processRepoPoll(job({ requestedByUserId: "u1" }), deps(prisma, poll as never));

    expect(poll.mock.calls.map(([p]) => p.accessToken)).toEqual(["plain:t1", "plain:t2"]);
  });

  it("on a rate limit pauses the queue until the reset and re-queues the job", async () => {
    const { prisma, repo } = fakePrisma();
    const poll = vi.fn(async () => {
      throw new GitHubRateLimitError(new Date("2026-10-31T12:10:00Z"));
    });
    const d = deps(prisma, poll as never);

    await expect(processRepoPoll(job({ requestedByUserId: "u1" }), d)).rejects.toMatchObject({ name: "RateLimitError" });

    expect(d.repoPollQueue.rateLimit).toHaveBeenCalledWith(10 * 60_000 + 1_000);
    expect(repo.pollStatus).toBe("IDLE");
    expect(repo.errorCount).toBe(0);
    expect(d.redis.publish).toHaveBeenCalledWith("user:u1:events", expect.stringContaining('"reason":"RATE_LIMITED"'));
  });

  it("on 404 increments errorCount and flags ERROR at the threshold", async () => {
    const poll = vi.fn(async () => {
      throw new GitHubRepositoryNotFoundError("acme", "widget");
    });

    const below = fakePrisma({ errorCount: MAX_ERROR_COUNT - 2 });
    expect(await processRepoPoll(job(), deps(below.prisma, poll as never))).toEqual({ status: "NOT_FOUND", errorCount: MAX_ERROR_COUNT - 1 });
    expect(below.repo.pollStatus).toBe("IDLE");

    const at = fakePrisma({ errorCount: MAX_ERROR_COUNT - 1 });
    expect(await processRepoPoll(job(), deps(at.prisma, poll as never))).toEqual({ status: "NOT_FOUND", errorCount: MAX_ERROR_COUNT });
    expect(at.repo.pollStatus).toBe("ERROR");
  });

  it("rethrows other errors for BullMQ retries, counting only the final attempt", async () => {
    const poll = vi.fn(async () => {
      throw new Error("socket hang up");
    });

    const early = fakePrisma();
    await expect(processRepoPoll(job({}, 0), deps(early.prisma, poll as never))).rejects.toThrow("socket hang up");
    expect(early.repo).toMatchObject({ pollStatus: "IDLE", errorCount: 0 });

    const last = fakePrisma();
    const d = deps(last.prisma, poll as never);
    await expect(processRepoPoll(job({ requestedByUserId: "u1" }, 2), d)).rejects.toThrow("socket hang up");
    expect(last.repo.errorCount).toBe(1);
    expect(d.redis.publish).toHaveBeenCalledWith("user:u1:events", expect.stringContaining('"reason":"ERROR"'));
  });
});

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

const REPO = { id: "repo1", owner: "acme", name: "widget", fullName: "acme/widget", htmlUrl: "https://github.com/acme/widget", lastEtag: '"old"' };

/** Minimal stand-in for the Prisma calls made by the processor (no transaction path). */
function fakePrisma(options: { errorCount?: number; subscribers?: number; tokens?: Array<[string, string]>; polledPaths?: string[] } = {}) {
  const repo = { ...REPO, errorCount: options.errorCount ?? 0, pollStatus: "IDLE" as string };
  const updates: Array<Record<string, unknown>> = [];
  const prisma = {
    repository: {
      findUnique: vi.fn(async () => ({
        ...REPO,
        polledPaths: options.polledPaths ?? [],
        _count: { subscriptions: options.subscribers ?? 1 },
        subscriptions: [],
      })),
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
  it("skips repositories deleted before the job runs", async () => {
    const { prisma } = fakePrisma();
    prisma.repository.findUnique.mockResolvedValueOnce(null as never);
    const d = deps(prisma, notModified);
    expect(await processRepoPoll(job(), d)).toEqual({ status: "SKIPPED", reason: "REPOSITORY_GONE" });
    expect(prisma.repository.update).not.toHaveBeenCalled();
    expect(notModified).not.toHaveBeenCalled();
  });

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

  it("stops fallback immediately on a non-401 error and rethrows the final 401 if all candidates fail", async () => {
    const { prisma } = fakePrisma({ tokens: [["u1", "t1"], ["u2", "t2"]] });
    const serverErr = Object.assign(new Error("Internal Server Error"), { status: 500 });
    const poll500 = vi.fn(async () => {
      throw serverErr;
    });

    await expect(processRepoPoll(job(), deps(prisma, poll500 as never))).rejects.toBe(serverErr);
    expect(poll500).toHaveBeenCalledTimes(1);

    const authErr = Object.assign(new Error("Bad credentials"), { status: 401 });
    const pollAll401 = vi.fn(async () => {
      throw authErr;
    });
    const { prisma: prisma401 } = fakePrisma({ tokens: [["u1", "t1"]] });
    await expect(processRepoPoll(job(), deps(prisma401, pollAll401 as never))).rejects.toBe(authErr);
    expect(pollAll401.mock.calls.map(([p]) => p.accessToken)).toEqual(["plain:t1", undefined]);
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

  it("on 404 increments errorCount, flags ERROR at the threshold, and notifies manual sync requester", async () => {
    const poll = vi.fn(async () => {
      throw new GitHubRepositoryNotFoundError("acme", "widget");
    });

    const below = fakePrisma({ errorCount: MAX_ERROR_COUNT - 2 });
    const belowDeps = deps(below.prisma, poll as never);
    expect(await processRepoPoll(job({ trigger: "manual", requestedByUserId: "u1" }), belowDeps)).toEqual({
      status: "NOT_FOUND",
      errorCount: MAX_ERROR_COUNT - 1,
    });
    expect(below.repo.pollStatus).toBe("IDLE");
    expect(belowDeps.redis.publish).toHaveBeenCalledWith(
      "user:u1:events",
      expect.stringContaining('"type":"SYNC_FAILED"'),
    );
    expect(belowDeps.redis.publish).toHaveBeenCalledWith(
      "user:u1:events",
      expect.stringContaining('"reason":"NOT_FOUND"'),
    );

    const at = fakePrisma({ errorCount: MAX_ERROR_COUNT - 1 });
    expect(await processRepoPoll(job(), deps(at.prisma, poll as never))).toEqual({ status: "NOT_FOUND", errorCount: MAX_ERROR_COUNT });
    expect(at.repo.pollStatus).toBe("ERROR");
  });

  it("forgets the polled paths once nobody watches paths", async () => {
    const { prisma, updates } = fakePrisma({ polledPaths: ["docs"] });
    await processRepoPoll(job(), deps(prisma, notModified));
    expect(updates[0]).toEqual({ pollStatus: "POLLING", polledPaths: [] });
  });

  it("rethrows other errors for BullMQ retries, counting only the final attempt and tolerating recordFailure errors", async () => {
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

    const failingUpdate = fakePrisma();
    let updateCalls = 0;
    failingUpdate.prisma.repository.update.mockImplementation(async () => {
      updateCalls += 1;
      if (updateCalls > 1) throw new Error("db connection lost");
      return { errorCount: 0 };
    });
    await expect(processRepoPoll(job({}, 2), deps(failingUpdate.prisma, poll as never))).rejects.toThrow("socket hang up");
  });
});

describe("processRepoPoll release → tag promotion", () => {
  /** Transaction-capable fake: a stored tag row `v2.0.0` and two subscribers, one per tracking mode. */
  function promotionDb() {
    const updatedRows: Array<{ id: string; data: Record<string, unknown> }> = [];
    const states: Array<{ userId: string; releaseId: string }> = [];
    const stored = (id: string, tagName: string, publishedAt: string) => ({
      id,
      tagName,
      isPrerelease: false,
      semverType: "MAJOR" as const,
      publishedAt: new Date(publishedAt),
    });
    const prisma = {
      repository: {
        findUnique: vi.fn(async () => ({ ...REPO, polledPaths: [], _count: { subscriptions: 4 }, subscriptions: [] })),
        update: vi.fn(async () => ({})),
      },
      release: {
        findFirst: vi.fn(async () => ({ publishedAt: new Date("2026-10-01T00:00:00Z") })),
        findMany: vi.fn(async ({ where }: { where: { githubReleaseId?: unknown; tagName?: { in: string[] } } }) =>
          where.githubReleaseId ? [] : [{ id: "tagrow", tagName: "v2.0.0", source: "TAG" }],
        ),
        createManyAndReturn: vi.fn(async ({ data }: { data: Array<{ tagName: string; publishedAt: Date }> }) =>
          data.map((r) => stored(`new-${r.tagName}`, r.tagName, r.publishedAt.toISOString())),
        ),
        update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          updatedRows.push({ id: where.id, data });
          return stored(where.id, "v2.0.0", "2026-10-30T00:00:00Z");
        }),
      },
      userSubscription: {
        findMany: vi.fn(async (args: { select: Record<string, unknown> }) =>
          "trackMode" in args.select
            ? [
                { userId: "tagger", includePrereleases: false, trackMode: "TAGS_AND_COMMITS", tags: [], user: { notificationRules: [] } },
                { userId: "releaser", includePrereleases: false, trackMode: "RELEASES", tags: [], user: { notificationRules: [] } },
                // Paths-only subscribers never get GitHub Releases.
                {
                  userId: "pather",
                  includePrereleases: false,
                  trackMode: "NONE",
                  trackPaths: true,
                  watchedPaths: ["docs"],
                  tags: [],
                  user: { notificationRules: [] },
                },
                // Releases and "Files / folders" at once: gets releases like any release-mode subscriber.
                {
                  userId: "both",
                  includePrereleases: false,
                  trackMode: "RELEASES",
                  trackPaths: true,
                  watchedPaths: ["docs"],
                  tags: [],
                  user: { notificationRules: [] },
                },
              ]
            : [],
        ),
      },
      userReleaseState: {
        createMany: vi.fn(async ({ data }: { data: typeof states }) => {
          states.push(...data);
          return { count: data.length };
        }),
      },
      $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(prisma)),
    };
    return { prisma, updatedRows, states };
  }

  const mapped = (id: number, tagName: string, publishedAt: string) => ({
    githubReleaseId: BigInt(id),
    tagName,
    title: tagName,
    bodyMarkdown: "notes",
    htmlUrl: `https://github.com/acme/widget/releases/tag/${tagName}`,
    isPrerelease: false,
    isDraft: false,
    semverType: "MAJOR" as const,
    publishedAt: new Date(publishedAt),
  });

  it("promotes the tag row in place and fans the release out to release-mode subscribers only", async () => {
    const db = promotionDb();
    const poll = vi.fn(async () => ({
      status: "UPDATED" as const,
      etag: '"new"',
      releases: [mapped(200, "v2.0.0", "2026-10-30T00:00:00Z"), mapped(201, "v2.1.0", "2026-10-31T00:00:00Z")],
      rateLimitRemaining: 4000,
    }));

    const outcome = await processRepoPoll(job(), deps(db.prisma, poll as never));

    expect(outcome).toMatchObject({ status: "UPDATED", stored: 1, promoted: 1, fresh: 2 });
    expect(db.updatedRows).toEqual([{ id: "tagrow", data: expect.objectContaining({ source: "RELEASE", githubReleaseId: 200n, tagSha: null }) }]);
    // v2.1.0 is new for everyone; the promoted v2.0.0 only for the release-mode subscriber.
    expect(db.states).toEqual(
      expect.arrayContaining([
        { userId: "tagger", releaseId: "new-v2.1.0", isRead: false },
        { userId: "releaser", releaseId: "new-v2.1.0", isRead: false },
        { userId: "releaser", releaseId: "tagrow", isRead: false },
        { userId: "both", releaseId: "new-v2.1.0", isRead: false },
        { userId: "both", releaseId: "tagrow", isRead: false },
      ]),
    );
    expect(db.states).toHaveLength(5);
  });

  it("filters out already stored githubReleaseIds and recreated release tagNames", async () => {
    const db = promotionDb();
    db.prisma.release.findMany.mockImplementation(
      async ({ where }: { where: { githubReleaseId?: unknown; tagName?: { in: string[] } } }) =>
        where.githubReleaseId
          ? [{ githubReleaseId: 100n } as never]
          : [
              { id: "relrow", tagName: "v1.9.0", source: "RELEASE" },
              { id: "tagrow", tagName: "v2.0.0", source: "TAG" },
            ],
    );
    const poll = vi.fn(async () => ({
      status: "UPDATED" as const,
      etag: '"new"',
      releases: [
        mapped(100, "v1.8.0", "2026-10-25T00:00:00Z"),
        mapped(199, "v1.9.0", "2026-10-28T00:00:00Z"),
        mapped(200, "v2.0.0", "2026-10-30T00:00:00Z"),
        mapped(201, "v2.1.0", "2026-10-31T00:00:00Z"),
      ],
      rateLimitRemaining: 4000,
    }));

    const outcome = await processRepoPoll(job(), deps(db.prisma, poll as never));

    expect(outcome).toMatchObject({ status: "UPDATED", received: 4, stored: 1, promoted: 1, fresh: 2 });
    expect(db.prisma.release.createManyAndReturn).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [expect.objectContaining({ tagName: "v2.1.0", githubReleaseId: 201n })],
      }),
    );
    expect(db.updatedRows).toHaveLength(1);
    expect(db.updatedRows[0]!.id).toBe("tagrow");
  });

  it("inserts older historical releases from the poll page as read history without fanning out", async () => {
    const db = promotionDb();
    const poll = vi.fn(async () => ({
      status: "UPDATED" as const,
      etag: '"new"',
      // Both older than newestKnownAt (2026-10-01T00:00:00Z).
      releases: [mapped(90, "v0.9.0", "2026-09-15T00:00:00Z"), mapped(80, "v0.8.0", "2026-09-01T00:00:00Z")],
      rateLimitRemaining: 4000,
    }));

    const outcome = await processRepoPoll(job(), deps(db.prisma, poll as never));

    expect(outcome).toMatchObject({ status: "UPDATED", received: 2, stored: 2, promoted: 0, fresh: 0, notifications: 0 });
    expect(db.states).toEqual([]);
    expect(db.prisma.userReleaseState.createMany).not.toHaveBeenCalled();
  });

  it("dispatches NEW_RELEASE, SYNC_COMPLETED, and notification jobs, surviving Redis and queue errors", async () => {
    const db = promotionDb();
    db.prisma.userSubscription.findMany.mockImplementation(async (args: { select: Record<string, unknown> }) =>
      "trackMode" in args.select
        ? [
            {
              userId: "u1",
              includePrereleases: false,
              trackMode: "RELEASES",
              tags: [],
              user: {
                notificationRules: [
                  { id: "rule-1", tagId: null, channel: "DISCORD_WEBHOOK", onlyMajorReleases: false, events: ["RELEASES"] },
                ],
              },
            },
          ]
        : [],
    );
    const poll = vi.fn(async () => ({
      status: "UPDATED" as const,
      etag: '"new"',
      releases: [mapped(201, "v2.1.0", "2026-10-31T00:00:00Z")],
      rateLimitRemaining: 4000,
    }));
    const d = deps(db.prisma, poll as never);
    d.redis.publish.mockRejectedValueOnce(new Error("redis hiccup"));
    d.notificationQueue.addBulk.mockRejectedValueOnce(new Error("queue down"));

    const outcome = await processRepoPoll(job({ trigger: "manual", requestedByUserId: "u1" }), d);

    expect(outcome).toMatchObject({ status: "UPDATED", stored: 1, fresh: 1, notifications: 1 });
    expect(d.notificationQueue.addBulk).toHaveBeenCalledWith([
      {
        name: "dispatch-notification",
        data: { ruleId: "rule-1", releaseId: "new-v2.1.0", userId: "u1" },
        opts: { jobId: "notify-rule-1-new-v2.1.0" },
      },
    ]);
    expect(d.redis.publish).toHaveBeenCalledWith(
      "user:u1:events",
      JSON.stringify({
        type: "NEW_RELEASE",
        repositoryId: "repo1",
        repositoryName: "acme/widget",
        tagName: "v2.1.0",
        releaseId: "new-v2.1.0",
      }),
    );
    expect(d.redis.publish).toHaveBeenCalledWith(
      "user:u1:events",
      JSON.stringify({
        type: "SYNC_COMPLETED",
        repositoryId: "repo1",
        repositoryName: "acme/widget",
        result: "UPDATED",
        newReleases: 1,
      }),
    );
  });

  it("runs tag and path steps when main release poll returns 304 and reports UPDATED on SYNC_COMPLETED", async () => {
    const repoUpdates: Array<Record<string, unknown>> = [];
    const states: Array<{ userId: string; releaseId: string; isRead: boolean }> = [];
    const prisma = {
      repository: {
        findUnique: vi.fn(async (args: { select: Record<string, unknown> }) =>
          "_count" in args.select
            ? {
                ...REPO,
                polledPaths: ["docs"],
                _count: { subscriptions: 2 },
                subscriptions: [
                  { trackMode: "TAGS_AND_COMMITS", trackPaths: false },
                  { trackMode: "NONE", trackPaths: true },
                ],
              }
            : { polledPaths: ["docs"] },
        ),
        update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          repoUpdates.push(data);
          return {};
        }),
      },
      release: {
        findFirst: vi.fn(async () => ({ publishedAt: new Date("2026-10-01T00:00:00Z") })),
        findMany: vi.fn(async () => []),
        createManyAndReturn: vi.fn(async ({ data }: { data: Array<{ tagName: string; publishedAt: Date; tagSha?: string; changedPaths?: string[] }> }) =>
          data.map((r) => ({
            id: `id-${r.tagName}`,
            tagName: r.tagName,
            tagSha: r.tagSha ?? null,
            changedPaths: r.changedPaths ?? [],
            isPrerelease: false,
            semverType: "MINOR" as const,
            publishedAt: r.publishedAt,
          })),
        ),
      },
      userSubscription: {
        findMany: vi.fn(async (args: { select: Record<string, unknown> }) =>
          "trackMode" in args.select
            ? [
                {
                  userId: "u1",
                  includePrereleases: false,
                  trackMode: "TAGS_AND_COMMITS",
                  trackPaths: true,
                  watchedPaths: ["docs"],
                  tags: [],
                  user: { notificationRules: [] },
                },
              ]
            : [{ userId: "u1", user: { githubAccessTokenEncrypted: "t1" } }],
        ),
      },
      userReleaseState: {
        findMany: vi.fn(async () => []),
        createMany: vi.fn(async ({ data }: { data: typeof states }) => {
          states.push(...data);
          return { count: data.length };
        }),
      },
      $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(prisma)),
    };

    const fetchTags = vi.fn(async () => [
      {
        name: "v1.1.0",
        sha: "sha1100000",
        commitUrl: "https://github.com/acme/widget/commit/sha1100000",
        commitMessage: "Release 1.1.0",
        commitDate: new Date("2026-10-20T00:00:00Z"),
        message: null,
        taggerDate: null,
      },
    ]);
    const sha = "1234567".padEnd(40, "a");
    const fetchPathCommits = vi.fn(async () => [
      {
        sha,
        htmlUrl: `https://github.com/acme/widget/commit/${sha}`,
        message: "docs update",
        committedDate: new Date("2026-10-25T00:00:00Z"),
        authorName: "Octo",
        authorLogin: "octo",
      },
    ]);
    const fetchCommitDetail = vi.fn(async () => ({
      sha,
      stats: { additions: 1, deletions: 0, total: 1 },
      files: [{ filename: "docs/readme.md", status: "modified", additions: 1, deletions: 0 }],
    }));

    const d = {
      ...deps(prisma, notModified),
      fetchTags,
      fetchPathCommits,
      fetchCommitDetail,
    };

    const outcome = await processRepoPoll(job({ trigger: "manual", requestedByUserId: "u1" }), d);

    expect(outcome).toEqual({
      status: "NOT_MODIFIED",
      tags: { received: 1, stored: 1, fresh: 1 },
      paths: { paths: 1, received: 1, stored: 1, fresh: 1, imported: 0 },
    });
    // Preserves polledPaths when withPaths is true.
    expect(repoUpdates[0]).toEqual({ pollStatus: "POLLING" });
    expect(d.redis.publish).toHaveBeenCalledWith(
      "user:u1:events",
      JSON.stringify({
        type: "SYNC_COMPLETED",
        repositoryId: "repo1",
        repositoryName: "acme/widget",
        result: "UPDATED",
        newReleases: 2,
      }),
    );
  });
});

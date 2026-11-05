import { describe, expect, it, vi } from "vitest";
import { DelayedError, type Job } from "bullmq";
import {
  GitHubRateLimitError,
  GitHubRepositoryNotFoundError,
  type fetchReleasesPage,
  type MappedRelease,
} from "@repopulse/github";
import { BACKFILL_DEFAULTS, type BackfillConfig, type ReleaseBackfillJobData } from "@repopulse/queue";

vi.mock("@repopulse/db", () => ({ decryptToken: (value: string) => `plain:${value}` }));

const { processReleaseBackfill } = await import("./release-backfill.processor");

const NOW = new Date("2026-10-31T12:00:00Z");
const HOUR = 60 * 60 * 1000;

/** GitHub release `id` (higher = newer), published `id` hours after a fixed origin. */
function rel(id: number): MappedRelease {
  return {
    githubReleaseId: BigInt(id),
    tagName: `v${id}`,
    title: `v${id}`,
    bodyMarkdown: "",
    htmlUrl: `https://github.com/acme/widget/releases/tag/v${id}`,
    isPrerelease: false,
    isDraft: false,
    semverType: "PATCH",
    publishedAt: new Date(NOW.getTime() - 300 * HOUR + id * HOUR),
  };
}

const range = (from: number, to: number) => Array.from({ length: from - to + 1 }, (_, i) => from - i);

/** In-memory stand-in for the Prisma calls the processor makes. Any other call throws. */
function fakeDb(options: {
  stored: number[];
  nextPage?: number | null;
  target?: number;
  backfilledAt?: Date | null;
  subscribers?: string[];
  /** Tag rows ("Releases + tags") by tag name. */
  tagRows?: string[];
}) {
  const repo = {
    id: "repo1",
    owner: "acme",
    name: "widget",
    fullName: "acme/widget",
    backfillStatus: "QUEUED" as string,
    backfillNextPage: options.nextPage ?? null,
    backfillTarget: options.target ?? 100,
    backfilledAt: options.backfilledAt ?? null,
  };
  const releases = new Map(options.stored.map((id) => [BigInt(id), rel(id)]));
  const subscribers = options.subscribers ?? ["u1", "u2"];
  const tagRows = new Set(options.tagRows ?? []);
  const promoted: string[] = [];
  const statuses: string[] = [];

  const prisma = {
    repository: {
      findUnique: vi.fn(async () => ({ ...repo, _count: { subscriptions: subscribers.length } })),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(repo, data);
        if (typeof data.backfillStatus === "string") statuses.push(data.backfillStatus);
        return repo;
      }),
    },
    release: {
      count: vi.fn(async () => releases.size),
      findFirst: vi.fn(async () => {
        const newest = [...releases.values()].sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime())[0];
        return newest ? { publishedAt: newest.publishedAt } : null;
      }),
      findMany: vi.fn(async ({ where }: { where: { githubReleaseId?: { in: bigint[] }; source?: string; tagName?: { in: string[] } } }) => {
        if (where.githubReleaseId) {
          return where.githubReleaseId.in.filter((id) => releases.has(id)).map((githubReleaseId) => ({ githubReleaseId }));
        }
        return where.tagName!.in.filter((name) => tagRows.has(name)).map((tagName) => ({ id: `tag-${tagName}`, tagName }));
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: MappedRelease & { source: string } }) => {
        const name = where.id.replace(/^tag-/, "");
        tagRows.delete(name);
        promoted.push(name);
        releases.set(data.githubReleaseId, data);
        return data;
      }),
      createMany: vi.fn(async ({ data }: { data: MappedRelease[] }) => {
        let count = 0;
        for (const row of data) {
          if (releases.has(row.githubReleaseId)) continue;
          releases.set(row.githubReleaseId, row);
          count += 1;
        }
        return { count };
      }),
    },
    userSubscription: {
      findMany: vi.fn(async () => subscribers.map((userId) => ({ userId, user: { githubAccessTokenEncrypted: `t-${userId}` } }))),
    },
  };
  return { prisma, repo, releases, statuses, promoted };
}

/** A GitHub repository with releases `total`..1, served newest first, 100 per page. */
function fakeGitHub(total: number, options: { remaining?: number; failOnPage?: number; error?: Error } = {}) {
  return vi.fn(async ({ page }: { page: number }) => {
    if (options.error && (options.failOnPage === undefined || options.failOnPage === page)) throw options.error;
    const ids = range(total, 1).slice((page - 1) * 100, page * 100);
    return {
      releases: ids.map(rel),
      hasNextPage: page * 100 < total,
      rateLimitRemaining: options.remaining ?? 4000,
      rateLimitResetAt: new Date(NOW.getTime() + 10 * 60_000),
    };
  });
}

function job(attemptsMade = 0) {
  return {
    data: { repositoryId: "repo1", trigger: "add" },
    attemptsMade,
    opts: { attempts: 3 },
    moveToDelayed: vi.fn(async () => undefined),
  } as unknown as Job<ReleaseBackfillJobData> & { moveToDelayed: ReturnType<typeof vi.fn> };
}

function deps(db: ReturnType<typeof fakeDb>, fetchPage: unknown, config: Partial<BackfillConfig> = {}) {
  return {
    prisma: db.prisma as never,
    redis: { publish: vi.fn(async () => 1) },
    fetchPage: fetchPage as typeof fetchReleasesPage,
    config: { ...BACKFILL_DEFAULTS, maxAgeDays: 0, ...config },
    now: () => NOW,
  };
}

describe("processReleaseBackfill", () => {
  it("skips vanished repositories and resets backfillStatus to NONE when no subscribers remain", async () => {
    const gone = fakeDb({ stored: [1] });
    gone.prisma.repository.findUnique.mockResolvedValueOnce(null as never);
    const github = fakeGitHub(10);
    expect(await processReleaseBackfill(job(), "token", deps(gone, github))).toEqual({
      status: "SKIPPED",
      reason: "REPOSITORY_GONE",
    });
    expect(gone.prisma.repository.update).not.toHaveBeenCalled();
    expect(github).not.toHaveBeenCalled();

    const empty = fakeDb({ stored: [1], subscribers: [] });
    expect(await processReleaseBackfill(job(), "token", deps(empty, github))).toEqual({
      status: "SKIPPED",
      reason: "NO_SUBSCRIBERS",
    });
    expect(empty.repo.backfillStatus).toBe("NONE");
    expect(github).not.toHaveBeenCalled();
  });

  it("short-circuits before fetching when storedCount already meets or exceeds the target", async () => {
    const dbDone = fakeDb({ stored: range(100, 1), nextPage: 2, target: 100, backfilledAt: NOW });
    const github = fakeGitHub(200);
    const done = await processReleaseBackfill(job(), "token", deps(dbDone, github));
    expect(done).toEqual({ status: "FINISHED", backfillStatus: "DONE", reason: "TARGET", added: 0, pages: 0 });
    expect(dbDone.repo.backfillNextPage).toBe(2);
    expect(github).not.toHaveBeenCalled();

    const dbPartial = fakeDb({ stored: range(150, 1), nextPage: 3, target: 200, backfilledAt: NOW });
    const partial = await processReleaseBackfill(job(), "token", deps(dbPartial, github, { hardCap: 150 }));
    expect(partial).toEqual({ status: "FINISHED", backfillStatus: "PARTIAL", reason: "TARGET", added: 0, pages: 0 });
    expect(dbPartial.repo.backfillNextPage).toBe(3);
    expect(github).not.toHaveBeenCalled();
  });

  it("stops with MAX_AGE and keeps backfillNextPage on the current page when automatic backfill hits the age cutoff", async () => {
    // Release id `id` is published at NOW - (300 - id) hours. With maxAgeDays = 10 (240 hours),
    // cutoff is NOW - 240h, corresponding to id = 60.
    // Page 1 of 100 releases has ids 100..1. Stored is 100..91 (10 releases).
    // Releases 90..60 (31 releases) are >= cutoff; 59..1 are < cutoff.
    const db = fakeDb({ stored: range(100, 91) });
    const github = fakeGitHub(100);
    const outcome = await processReleaseBackfill(job(), "token", deps(db, github, { maxAgeDays: 10 }));
    expect(outcome).toEqual({ status: "FINISHED", backfillStatus: "DONE", reason: "MAX_AGE", added: 31, pages: 1 });
    expect(db.repo).toMatchObject({ backfillStatus: "DONE", backfillNextPage: 1 });
  });

  it("imports history up to the default target as read and tells every subscriber", async () => {
    // "Add repository" stored the newest 10 of 250.
    const db = fakeDb({ stored: range(250, 241) });
    const github = fakeGitHub(250);
    const d = deps(db, github);

    const outcome = await processReleaseBackfill(job(), "token", d);

    expect(outcome).toEqual({ status: "FINISHED", backfillStatus: "DONE", reason: "TARGET", added: 90, pages: 1 });
    expect(db.releases.size).toBe(100);
    expect(db.repo).toMatchObject({ backfillStatus: "DONE", backfillNextPage: 2, backfillTarget: 100, backfilledAt: NOW });
    expect(db.statuses[0]).toBe("RUNNING");
    // No UserReleaseState rows: the fake has no such model, so any write would have thrown.
    expect(d.redis.publish).toHaveBeenCalledTimes(2);
    expect(d.redis.publish).toHaveBeenCalledWith(
      "user:u1:events",
      JSON.stringify({ type: "HISTORY_BACKFILLED", repositoryId: "repo1", repositoryName: "acme/widget", added: 90 }),
    );
  });

  it("resumes from backfillNextPage and is idempotent when run again", async () => {
    const db = fakeDb({ stored: range(250, 151), nextPage: 2, target: 300, backfilledAt: new Date("2026-10-01") });
    const github = fakeGitHub(250);

    const first = await processReleaseBackfill(job(), "token", deps(db, github));
    expect(github.mock.calls.map(([p]) => p.page)).toEqual([2, 3]);
    expect(first).toMatchObject({ backfillStatus: "DONE", reason: "COMPLETE", added: 100 + 50 });
    expect(db.repo.backfillNextPage).toBeNull();

    const second = await processReleaseBackfill(job(), "token", deps(db, fakeGitHub(250)));
    expect(second).toMatchObject({ backfillStatus: "DONE", reason: "COMPLETE", added: 0 });
    expect(db.releases.size).toBe(250);
  });

  it("never imports releases newer than the newest stored one", async () => {
    // 251-255 were published after the newest stored release; repo-poll must discover them as new.
    const db = fakeDb({ stored: range(250, 241) });
    await processReleaseBackfill(job(), "token", deps(db, fakeGitHub(255)));
    expect([...db.releases.keys()].some((id) => id > 250n)).toBe(false);
    expect(db.releases.size).toBe(100);
  });

  it("stops PARTIAL at the hard cap", async () => {
    const db = fakeDb({ stored: range(500, 491), nextPage: 1, target: 400, backfilledAt: NOW });
    const outcome = await processReleaseBackfill(job(), "token", deps(db, fakeGitHub(500), { hardCap: 150 }));
    expect(outcome).toMatchObject({ backfillStatus: "PARTIAL", reason: "TARGET" });
    expect(db.releases.size).toBe(150);
  });

  it("finishes without calling GitHub when nothing is stored", async () => {
    const db = fakeDb({ stored: [] });
    const github = fakeGitHub(0);
    expect(await processReleaseBackfill(job(), "token", deps(db, github))).toMatchObject({ backfillStatus: "DONE", reason: "COMPLETE" });
    expect(github).not.toHaveBeenCalled();
  });

  it("pauses until the rate-limit reset when the quota drops below the minimum", async () => {
    const db = fakeDb({ stored: range(500, 491), target: 300 });
    const j = job();
    // First run: the default target (100) is applied, so make it larger than one page for this test.
    const d = deps(db, fakeGitHub(500, { remaining: 120 }), { defaultTarget: 300, minQuota: 500 });

    await expect(processReleaseBackfill(j, "token", d)).rejects.toBeInstanceOf(DelayedError);

    expect(j.moveToDelayed).toHaveBeenCalledWith(NOW.getTime() + 10 * 60_000 + 1_000, "token");
    expect(db.repo).toMatchObject({ backfillStatus: "QUEUED", backfillNextPage: 2 });
    expect(db.releases.size).toBe(100);
  });

  it("re-queues itself on a GitHub rate-limit error without losing its page", async () => {
    const db = fakeDb({ stored: range(500, 491), nextPage: 3, target: 400, backfilledAt: NOW });
    const j = job();
    const github = fakeGitHub(500, { error: new GitHubRateLimitError(new Date(NOW.getTime() + 5 * 60_000)) });

    await expect(processReleaseBackfill(j, "token", deps(db, github))).rejects.toBeInstanceOf(DelayedError);

    expect(j.moveToDelayed).toHaveBeenCalledWith(NOW.getTime() + 5 * 60_000 + 1_000, "token");
    expect(db.repo).toMatchObject({ backfillStatus: "QUEUED", backfillNextPage: 3 });
  });

  it("flags ERROR on 404", async () => {
    const db = fakeDb({ stored: range(50, 41) });
    const github = fakeGitHub(50, { error: new GitHubRepositoryNotFoundError("acme", "widget") });
    expect(await processReleaseBackfill(job(), "token", deps(db, github))).toEqual({ status: "NOT_FOUND" });
    expect(db.repo.backfillStatus).toBe("ERROR");
  });

  it("rethrows other errors for BullMQ retries and flags ERROR on the final attempt, surviving setStatus and publish failures", async () => {
    const error = new Error("socket hang up");

    const early = fakeDb({ stored: range(50, 41) });
    await expect(processReleaseBackfill(job(0), "token", deps(early, fakeGitHub(50, { error })))).rejects.toThrow(error);
    expect(early.repo.backfillStatus).toBe("QUEUED");

    const last = fakeDb({ stored: range(50, 41) });
    await expect(processReleaseBackfill(job(2), "token", deps(last, fakeGitHub(50, { error })))).rejects.toThrow(error);
    expect(last.repo.backfillStatus).toBe("ERROR");

    const brokenStatus = fakeDb({ stored: range(50, 41) });
    let updateCalls = 0;
    brokenStatus.prisma.repository.update.mockImplementation(async () => {
      updateCalls += 1;
      if (updateCalls > 1) throw new Error("db down");
      return brokenStatus.repo;
    });
    await expect(processReleaseBackfill(job(2), "token", deps(brokenStatus, fakeGitHub(50, { error })))).rejects.toThrow(error);

    const publishFailDb = fakeDb({ stored: range(50, 41) });
    const publishFailDeps = deps(publishFailDb, fakeGitHub(50));
    publishFailDeps.redis.publish.mockRejectedValueOnce(new Error("redis down"));
    const outcome = await processReleaseBackfill(job(), "token", publishFailDeps);
    expect(outcome).toMatchObject({ status: "FINISHED", backfillStatus: "DONE", reason: "COMPLETE", added: 40 });
  });

  it("promotes a stored tag row instead of adding a second entry", async () => {
    const db = fakeDb({ stored: range(50, 46), tagRows: ["v45", "v10"] });
    const outcome = await processReleaseBackfill(job(), "token", deps(db, fakeGitHub(50)));
    expect(db.promoted.sort()).toEqual(["v10", "v45"]);
    expect(outcome).toMatchObject({ reason: "COMPLETE", added: 45 });
    expect(db.releases.size).toBe(50);
  });

  it("falls back past a rejected (401) token", async () => {
    const db = fakeDb({ stored: range(50, 41) });
    const github = fakeGitHub(50);
    const fetchPage = vi.fn(async (params: { page: number; accessToken?: string | null }) => {
      if (params.accessToken === "plain:t-u1") throw Object.assign(new Error("Bad credentials"), { status: 401 });
      return github(params);
    });

    await processReleaseBackfill(job(), "token", deps(db, fetchPage));

    expect(fetchPage.mock.calls.map(([p]) => p.accessToken)).toEqual(["plain:t-u1", "plain:t-u2"]);
    expect(db.releases.size).toBe(50);
  });
});

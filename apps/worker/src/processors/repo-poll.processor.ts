import { Worker, type Job, type Queue } from "bullmq";
import type { PrismaClient } from "@repopulse/db";
import {
  GitHubRateLimitError,
  GitHubRepositoryNotFoundError,
  isGitHubHttpError,
  pollRepoReleases,
  type MappedRelease,
} from "@repopulse/github";
import {
  JOB_NAMES,
  notificationJobId,
  publishUserEvent,
  type NotificationJobData,
  type RealtimeEvent,
  type Redis,
  type RepoPollJobData,
} from "@repopulse/queue";
import { createLogger } from "../logger";
import { tokenCandidates, type TokenCandidate } from "./github-tokens";
import { planFanOut, rateLimitDelayMs, selectFreshReleases, type FanOutPlan } from "./fan-out";

const log = createLogger("repo-poll");

/** Consecutive failures after which a repository is flagged `ERROR`. */
export const MAX_ERROR_COUNT = 5;
const GITHUB_REQUEST_TIMEOUT_MS = 30_000;

export type RepoPollOutcome =
  | { status: "SKIPPED"; reason: "REPOSITORY_GONE" | "NO_SUBSCRIBERS" }
  | { status: "NOT_MODIFIED" }
  | { status: "UPDATED"; received: number; stored: number; fresh: number; notifications: number }
  | { status: "NOT_FOUND"; errorCount: number };

export interface RepoPollDeps {
  prisma: PrismaClient;
  redis: Pick<Redis, "publish">;
  repoPollQueue: Pick<Queue<RepoPollJobData>, "rateLimit">;
  notificationQueue: Pick<Queue<NotificationJobData>, "addBulk">;
  poll?: typeof pollRepoReleases;
  now?: () => Date;
}

type PollTarget = { id: string; owner: string; name: string; fullName: string; lastEtag: string | null };

/** Polls with each candidate token in turn, moving on only when GitHub rejects the token (401). */
async function pollWithFallback(
  repo: PollTarget,
  candidates: TokenCandidate[],
  poll: typeof pollRepoReleases,
  signal: AbortSignal,
) {
  for (const [index, candidate] of candidates.entries()) {
    try {
      return await poll({ owner: repo.owner, name: repo.name, lastEtag: repo.lastEtag, accessToken: candidate.token, signal });
    } catch (error) {
      if (isGitHubHttpError(error) && error.status === 401 && index < candidates.length - 1) {
        log.warn(`${repo.fullName}: token of user ${candidate.userId} was rejected (401); trying the next one`);
        continue;
      }
      throw error;
    }
  }
  throw new Error("unreachable: the anonymous candidate always returns or throws");
}

/**
 * Inserts the releases not yet in PostgreSQL and fans the genuinely new ones out as unread
 * `UserReleaseState`s, all in one transaction with the Repository bookkeeping.
 */
async function storeAndFanOut(
  prisma: PrismaClient,
  repositoryId: string,
  releases: MappedRelease[],
  etag: string | null,
  polledAt: Date,
): Promise<{ stored: number; fresh: number; plan: FanOutPlan }> {
  return prisma.$transaction(async (tx) => {
    const newestKnown = await tx.release.findFirst({
      where: { repositoryId },
      orderBy: { publishedAt: "desc" },
      select: { publishedAt: true },
    });

    const existing =
      releases.length > 0
        ? await tx.release.findMany({
            where: { repositoryId, githubReleaseId: { in: releases.map((r) => r.githubReleaseId) } },
            select: { githubReleaseId: true },
          })
        : [];
    const known = new Set(existing.map((r) => r.githubReleaseId));
    const missing = releases.filter((r) => !known.has(r.githubReleaseId));

    const created =
      missing.length > 0
        ? await tx.release.createManyAndReturn({
            data: missing.map((release) => ({ ...release, repositoryId })),
            // A concurrent addRepositoryAction may insert the same rows.
            skipDuplicates: true,
            select: { id: true, tagName: true, isPrerelease: true, semverType: true, publishedAt: true },
          })
        : [];

    const fresh = selectFreshReleases(created, newestKnown?.publishedAt ?? null);
    let plan: FanOutPlan = { states: [], deliveries: [], notifications: [] };

    if (fresh.length > 0) {
      const subscriptions = await tx.userSubscription.findMany({
        where: { repositoryId },
        select: {
          userId: true,
          includePrereleases: true,
          tags: { select: { tagId: true } },
          user: {
            select: {
              notificationRules: {
                where: { enabled: true },
                select: { id: true, tagId: true, channel: true, onlyMajorReleases: true },
              },
            },
          },
        },
      });
      plan = planFanOut(
        subscriptions.map((s) => ({
          userId: s.userId,
          includePrereleases: s.includePrereleases,
          tagIds: s.tags.map((t) => t.tagId),
          rules: s.user.notificationRules,
        })),
        fresh,
      );
      if (plan.states.length > 0) {
        await tx.userReleaseState.createMany({
          data: plan.states.map((state) => ({ ...state, isRead: false })),
          skipDuplicates: true,
        });
      }
    }

    await tx.repository.update({
      where: { id: repositoryId },
      data: { lastEtag: etag, lastPolledAt: polledAt, pollStatus: "IDLE", errorCount: 0 },
    });

    return { stored: created.length, fresh: fresh.length, plan };
  });
}

/**
 * Records a failed attempt. `lastPolledAt` marks the attempt, so neither the scheduler nor
 * "Sync now" hammers a failing repository. Only the last BullMQ attempt counts towards
 * `errorCount`; at {@link MAX_ERROR_COUNT} the repository is flagged `ERROR`.
 */
async function recordFailure(
  prisma: PrismaClient,
  repositoryId: string,
  polledAt: Date,
  countIt: boolean,
): Promise<number> {
  const { errorCount } = await prisma.repository.update({
    where: { id: repositoryId },
    data: { lastPolledAt: polledAt, pollStatus: "IDLE", ...(countIt ? { errorCount: { increment: 1 } } : {}) },
    select: { errorCount: true },
  });
  if (errorCount >= MAX_ERROR_COUNT) {
    await prisma.repository.update({ where: { id: repositoryId }, data: { pollStatus: "ERROR" } });
  }
  return errorCount;
}

/** Publishing is best effort: the data is committed, a missed live update is fixed by the next page load. */
async function publish(redis: Pick<Redis, "publish">, userId: string, event: RealtimeEvent): Promise<void> {
  try {
    await publishUserEvent(redis, userId, event);
  } catch (error) {
    log.error(`could not publish ${event.type} to user ${userId}`, error);
  }
}

async function dispatchFanOut(deps: RepoPollDeps, repo: PollTarget, plan: FanOutPlan): Promise<void> {
  await Promise.all(
    plan.deliveries.flatMap(({ userId, releases }) =>
      releases.map((release) =>
        publish(deps.redis, userId, {
          type: "NEW_RELEASE",
          repositoryId: repo.id,
          repositoryName: repo.fullName,
          tagName: release.tagName,
          releaseId: release.id,
        }),
      ),
    ),
  );

  if (plan.notifications.length === 0) return;
  try {
    await deps.notificationQueue.addBulk(
      plan.notifications.map((data) => ({
        name: JOB_NAMES.notify,
        data,
        opts: { jobId: notificationJobId(data.ruleId, data.releaseId) },
      })),
    );
  } catch (error) {
    // Not rethrown: a retry of this poll would find nothing new and could not re-plan these jobs.
    log.error(`${repo.fullName}: could not enqueue ${plan.notifications.length} notification job(s)`, error);
  }
}

function quota(remaining: number | null): string {
  return remaining === null ? "" : `, quota left ${remaining}`;
}

/**
 * `repo-poll` job: conditional (`If-None-Match`) poll of one repository, storage of new releases,
 * fan-out to subscribers, Pub/Sub events and notification jobs.
 */
export async function processRepoPoll(
  job: Job<RepoPollJobData>,
  deps: RepoPollDeps,
  jobSignal?: AbortSignal,
): Promise<RepoPollOutcome> {
  const { prisma } = deps;
  const now = () => deps.now?.() ?? new Date();
  const { repositoryId, requestedByUserId } = job.data;

  const row = await prisma.repository.findUnique({
    where: { id: repositoryId },
    select: {
      id: true,
      owner: true,
      name: true,
      fullName: true,
      lastEtag: true,
      _count: { select: { subscriptions: true } },
    },
  });
  if (!row) return { status: "SKIPPED", reason: "REPOSITORY_GONE" };
  // The last subscriber left between enqueue and processing.
  if (row._count.subscriptions === 0) return { status: "SKIPPED", reason: "NO_SUBSCRIBERS" };
  const repo: PollTarget = row;

  const notifyRequester = (event: RealtimeEvent) =>
    requestedByUserId ? publish(deps.redis, requestedByUserId, event) : Promise.resolve();
  const syncFailed = (reason: "NOT_FOUND" | "RATE_LIMITED" | "ERROR", message: string) =>
    notifyRequester({ type: "SYNC_FAILED", repositoryId, repositoryName: repo.fullName, reason, message });

  await prisma.repository.update({ where: { id: repositoryId }, data: { pollStatus: "POLLING" } });

  try {
    const timeout = AbortSignal.timeout(GITHUB_REQUEST_TIMEOUT_MS);
    const signal = jobSignal ? AbortSignal.any([jobSignal, timeout]) : timeout;
    const candidates = await tokenCandidates(prisma, repositoryId, requestedByUserId);
    const result = await pollWithFallback(repo, candidates, deps.poll ?? pollRepoReleases, signal);

    if (result.status === "NOT_MODIFIED") {
      await prisma.repository.update({
        where: { id: repositoryId },
        data: { lastPolledAt: now(), pollStatus: "IDLE", errorCount: 0 },
      });
      log.info(`${repo.fullName}: HTTP 304 Not Modified${quota(result.rateLimitRemaining)}`);
      await notifyRequester({
        type: "SYNC_COMPLETED",
        repositoryId,
        repositoryName: repo.fullName,
        result: "NOT_MODIFIED",
        newReleases: 0,
      });
      return { status: "NOT_MODIFIED" };
    }

    const { stored, fresh, plan } = await storeAndFanOut(prisma, repositoryId, result.releases, result.etag, now());
    log.info(
      `${repo.fullName}: HTTP 200 OK, ${result.releases.length} releases received, ${stored} stored, ` +
        `${fresh} new, fanned out to ${plan.deliveries.length} user(s)${quota(result.rateLimitRemaining)}`,
    );
    await dispatchFanOut(deps, repo, plan);
    await notifyRequester({
      type: "SYNC_COMPLETED",
      repositoryId,
      repositoryName: repo.fullName,
      result: "UPDATED",
      newReleases: plan.deliveries.find((d) => d.userId === requestedByUserId)?.releases.length ?? 0,
    });
    return { status: "UPDATED", received: result.releases.length, stored, fresh, notifications: plan.notifications.length };
  } catch (error) {
    if (error instanceof GitHubRateLimitError) {
      const delayMs = rateLimitDelayMs(error.resetAt, now());
      await prisma.repository.update({ where: { id: repositoryId }, data: { pollStatus: "IDLE" } });
      // Pause the whole queue until the quota resets; the job goes back to waiting
      // without consuming an attempt.
      await deps.repoPollQueue.rateLimit(delayMs);
      log.warn(`${repo.fullName}: GitHub rate limit exceeded; pausing repo-poll for ${Math.ceil(delayMs / 1000)}s`);
      await syncFailed("RATE_LIMITED", `GitHub rate limit reached. The sync resumes in about ${Math.ceil(delayMs / 60_000)} min.`);
      throw Worker.RateLimitError();
    }

    if (error instanceof GitHubRepositoryNotFoundError) {
      // Retrying within this job is pointless; the counter spans scheduler ticks instead.
      const errorCount = await recordFailure(prisma, repositoryId, now(), true);
      log.warn(`${repo.fullName}: HTTP 404 Not Found (errorCount ${errorCount}/${MAX_ERROR_COUNT})`);
      await syncFailed("NOT_FOUND", `${repo.fullName} was not found on GitHub. It may have been renamed, deleted or made private.`);
      return { status: "NOT_FOUND", errorCount };
    }

    // Network errors, timeouts, 5xx: BullMQ retries with exponential backoff.
    const finalAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
    await recordFailure(prisma, repositoryId, now(), finalAttempt).catch((e: unknown) =>
      log.error(`${repo.fullName}: could not record the failure`, e),
    );
    if (finalAttempt) await syncFailed("ERROR", `Could not sync ${repo.fullName}. It will be retried on the next scheduled poll.`);
    throw error;
  }
}

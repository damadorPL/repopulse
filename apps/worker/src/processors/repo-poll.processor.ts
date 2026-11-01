import { Worker, type Job, type Queue } from "bullmq";
import type { PrismaClient } from "@repopulse/db";
import {
  compareCommits,
  fetchCommitDetail,
  fetchCommitsForPath,
  fetchRecentTags,
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
import {
  EMPTY_FAN_OUT_PLAN,
  mergeFanOutPlans,
  planFanOut,
  rateLimitDelayMs,
  selectFreshReleases,
  type FanOutPlan,
} from "./fan-out";
import { pollRepoPaths, type PathStepCounts, type PathStepResult } from "./repo-paths";
import { loadSubscribers, pollRepoTags, STORED_RELEASE_SELECT, tracksReleases, tracksTags, type TagStepResult } from "./repo-tags";

const log = createLogger("repo-poll");

/** Consecutive failures after which a repository is flagged `ERROR`. */
export const MAX_ERROR_COUNT = 5;
const GITHUB_REQUEST_TIMEOUT_MS = 30_000;

/**
 * Outcomes of the tag step ("Releases + tags" subscribers, Slice 04c) and the path step ("Files /
 * folders" subscribers, Slice 06), each present only when it ran.
 */
export type TagOutcome = {
  tags?: { received: number; stored: number; fresh: number };
  paths?: PathStepCounts;
};

export type RepoPollOutcome =
  | { status: "SKIPPED"; reason: "REPOSITORY_GONE" | "NO_SUBSCRIBERS" }
  | ({ status: "NOT_MODIFIED" } & TagOutcome)
  | ({ status: "UPDATED"; received: number; stored: number; promoted: number; fresh: number; notifications: number } & TagOutcome)
  | { status: "NOT_FOUND"; errorCount: number };

export interface RepoPollDeps {
  prisma: PrismaClient;
  redis: Pick<Redis, "publish">;
  repoPollQueue: Pick<Queue<RepoPollJobData>, "rateLimit">;
  notificationQueue: Pick<Queue<NotificationJobData>, "addBulk">;
  poll?: typeof pollRepoReleases;
  fetchTags?: typeof fetchRecentTags;
  compare?: typeof compareCommits;
  fetchPathCommits?: typeof fetchCommitsForPath;
  fetchCommitDetail?: typeof fetchCommitDetail;
  now?: () => Date;
}

type PollTarget = { id: string; owner: string; name: string; fullName: string; htmlUrl: string; lastEtag: string | null };

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
 *
 * A release whose tag is already stored as a tag row ("Releases + tags", Slice 04c) **promotes**
 * that row in place instead of adding a second entry: `TAGS_AND_COMMITS` subscribers keep their
 * read state and get no second notification; only `RELEASES` subscribers receive it as new.
 */
async function storeAndFanOut(
  prisma: PrismaClient,
  repositoryId: string,
  releases: MappedRelease[],
  etag: string | null,
  polledAt: Date,
): Promise<{ stored: number; promoted: number; fresh: number; plan: FanOutPlan }> {
  return prisma.$transaction(async (tx) => {
    // Tag rows are dated by their commit, so only GitHub Releases define what counts as new here.
    const newestKnown = await tx.release.findFirst({
      where: { repositoryId, source: "RELEASE" },
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

    const sameTag =
      missing.length > 0
        ? await tx.release.findMany({
            where: { repositoryId, tagName: { in: missing.map((r) => r.tagName) } },
            select: { id: true, tagName: true, source: true },
          })
        : [];
    const tagRowByName = new Map(sameTag.filter((r) => r.source === "TAG").map((r) => [r.tagName, r.id]));
    // A GitHub Release already stored under this tag name (e.g. deleted and re-created): keep the stored one.
    const releaseTagNames = new Set(sameTag.filter((r) => r.source === "RELEASE").map((r) => r.tagName));
    const toInsert = missing.filter((r) => !tagRowByName.has(r.tagName) && !releaseTagNames.has(r.tagName));
    const toPromote = missing.filter((r) => tagRowByName.has(r.tagName) && !releaseTagNames.has(r.tagName));

    const created =
      toInsert.length > 0
        ? await tx.release.createManyAndReturn({
            data: toInsert.map((release) => ({ ...release, repositoryId })),
            // A concurrent addRepositoryAction may insert the same rows.
            skipDuplicates: true,
            select: STORED_RELEASE_SELECT,
          })
        : [];
    const promoted = [];
    for (const release of toPromote) {
      promoted.push(
        await tx.release.update({
          where: { id: tagRowByName.get(release.tagName)! },
          data: { ...release, source: "RELEASE", tagSha: null },
          select: STORED_RELEASE_SELECT,
        }),
      );
    }

    const newestKnownAt = newestKnown?.publishedAt ?? null;
    const fresh = selectFreshReleases(created, newestKnownAt);
    const freshPromoted = selectFreshReleases(promoted, newestKnownAt);
    let plan = EMPTY_FAN_OUT_PLAN;

    if (fresh.length > 0 || freshPromoted.length > 0) {
      // Paths-only subscribers (`trackMode: NONE`) never see GitHub Releases.
      const subscribers = (await loadSubscribers(tx, repositoryId)).filter(tracksReleases);
      plan = mergeFanOutPlans(
        planFanOut(subscribers, fresh),
        // Tag-mode subscribers already received these as tags.
        planFanOut(subscribers.filter((s) => !tracksTags(s)), freshPromoted),
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

    return { stored: created.length, promoted: promoted.length, fresh: fresh.length + freshPromoted.length, plan };
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
      htmlUrl: true,
      lastEtag: true,
      polledPaths: true,
      _count: { select: { subscriptions: true } },
      // A "Releases + tags" subscriber turns on the tag step, a "Files / folders" one the path step.
      subscriptions: {
        where: { OR: [{ trackMode: "TAGS_AND_COMMITS" }, { trackPaths: true, watchedPaths: { isEmpty: false } }] },
        select: { trackMode: true, trackPaths: true },
      },
    },
  });
  if (!row) return { status: "SKIPPED", reason: "REPOSITORY_GONE" };
  // The last subscriber left between enqueue and processing.
  if (row._count.subscriptions === 0) return { status: "SKIPPED", reason: "NO_SUBSCRIBERS" };
  const { _count, subscriptions: modeSubscribers, polledPaths, ...repo } = row satisfies PollTarget & object;
  const withTags = modeSubscribers.some((s) => s.trackMode === "TAGS_AND_COMMITS");
  const withPaths = modeSubscribers.some((s) => s.trackPaths);

  const notifyRequester = (event: RealtimeEvent) =>
    requestedByUserId ? publish(deps.redis, requestedByUserId, event) : Promise.resolve();
  const syncFailed = (reason: "NOT_FOUND" | "RATE_LIMITED" | "ERROR", message: string) =>
    notifyRequester({ type: "SYNC_FAILED", repositoryId, repositoryName: repo.fullName, reason, message });

  await prisma.repository.update({
    where: { id: repositoryId },
    // Nobody watches paths any more: forget them, so a path watched again later is imported quietly
    // instead of notifying its subscriber about everything committed in between.
    data: { pollStatus: "POLLING", ...(!withPaths && polledPaths.length > 0 ? { polledPaths: [] } : {}) },
  });

  try {
    const timeout = AbortSignal.timeout(GITHUB_REQUEST_TIMEOUT_MS);
    const signal = jobSignal ? AbortSignal.any([jobSignal, timeout]) : timeout;
    const candidates = await tokenCandidates(prisma, repositoryId, requestedByUserId);
    // Tags are new when newer than every release or tag row stored before this poll. Commit rows
    // (Slice 06) are far more frequent and would push genuinely new tags into read history.
    const newestBefore = withTags
      ? ((
          await prisma.release.findFirst({
            where: { repositoryId, source: { in: ["RELEASE", "TAG"] } },
            orderBy: { publishedAt: "desc" },
            select: { publishedAt: true },
          })
        )?.publishedAt ?? null)
      : null;
    const result = await pollWithFallback(repo, candidates, deps.poll ?? pollRepoReleases, signal);

    let releaseStep: Awaited<ReturnType<typeof storeAndFanOut>> | null = null;
    if (result.status === "NOT_MODIFIED") {
      await prisma.repository.update({
        where: { id: repositoryId },
        data: { lastPolledAt: now(), pollStatus: "IDLE", errorCount: 0 },
      });
      log.info(`${repo.fullName}: HTTP 304 Not Modified${quota(result.rateLimitRemaining)}`);
    } else {
      releaseStep = await storeAndFanOut(prisma, repositoryId, result.releases, result.etag, now());
      log.info(
        `${repo.fullName}: HTTP 200 OK, ${result.releases.length} releases received, ${releaseStep.stored} stored, ` +
          `${releaseStep.promoted} promoted from tags, ${releaseStep.fresh} new, ` +
          `fanned out to ${releaseStep.plan.deliveries.length} user(s)${quota(result.rateLimitRemaining)}`,
      );
    }

    // After the release step, so a tag whose Release arrived in this poll is not stored twice.
    const tagStep: TagStepResult | null = withTags
      ? await pollRepoTags({ prisma, fetchTags: deps.fetchTags, compare: deps.compare, now }, repo, candidates, newestBefore, signal)
      : null;
    const tags = tagStep ? { tags: { received: tagStep.received, stored: tagStep.stored, fresh: tagStep.fresh } } : {};
    // Best effort too: commits touching watched paths ("Files / folders", Slice 06).
    const pathStep: PathStepResult | null = withPaths
      ? await pollRepoPaths(
          { prisma, fetchCommits: deps.fetchPathCommits, fetchDetail: deps.fetchCommitDetail, now },
          repo,
          candidates,
          signal,
        )
      : null;
    const stepOutcomes: TagOutcome = { ...tags, ...(pathStep ? { paths: pathStep.counts } : {}) };

    const plan = mergeFanOutPlans(
      releaseStep?.plan ?? EMPTY_FAN_OUT_PLAN,
      tagStep?.plan ?? EMPTY_FAN_OUT_PLAN,
      pathStep?.plan ?? EMPTY_FAN_OUT_PLAN,
    );
    await dispatchFanOut(deps, repo, plan);
    await notifyRequester({
      type: "SYNC_COMPLETED",
      repositoryId,
      repositoryName: repo.fullName,
      result: releaseStep || (tagStep?.stored ?? 0) > 0 || (pathStep?.counts.stored ?? 0) > 0 ? "UPDATED" : "NOT_MODIFIED",
      newReleases: plan.deliveries.find((d) => d.userId === requestedByUserId)?.releases.length ?? 0,
    });

    if (!releaseStep) return { status: "NOT_MODIFIED", ...stepOutcomes };
    const { stored, promoted, fresh } = releaseStep;
    return {
      status: "UPDATED",
      received: result.releases.length,
      stored,
      promoted,
      fresh,
      notifications: plan.notifications.length,
      ...stepOutcomes,
    };
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

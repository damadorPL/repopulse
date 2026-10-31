import { DelayedError, type Job } from "bullmq";
import type { PrismaClient } from "@repopulse/db";
import {
  fetchReleasesPage,
  GitHubRateLimitError,
  GitHubRepositoryNotFoundError,
  isGitHubHttpError,
  type FetchReleasesPageResult,
} from "@repopulse/github";
import {
  publishUserEvent,
  readBackfillConfig,
  type BackfillConfig,
  type Redis,
  type ReleaseBackfillJobData,
} from "@repopulse/queue";
import { createLogger } from "../logger";
import { effectiveTarget, maxAgeCutoff, planBackfillPage, targetStop, type BackfillStop } from "./backfill-plan";
import { rateLimitDelayMs } from "./fan-out";
import { tokenCandidates, type TokenCandidate } from "./github-tokens";

const log = createLogger("release-backfill");

const GITHUB_REQUEST_TIMEOUT_MS = 30_000;

export type ReleaseBackfillOutcome =
  | { status: "SKIPPED"; reason: "REPOSITORY_GONE" | "NO_SUBSCRIBERS" }
  | { status: "FINISHED"; backfillStatus: BackfillStop["status"]; reason: BackfillStop["reason"]; added: number; pages: number }
  | { status: "NOT_FOUND" };

export interface ReleaseBackfillDeps {
  prisma: PrismaClient;
  redis: Pick<Redis, "publish">;
  config?: BackfillConfig;
  fetchPage?: typeof fetchReleasesPage;
  now?: () => Date;
}

type BackfillTarget = { id: string; owner: string; name: string; fullName: string };

/** Fetches a page, moving on to the next candidate token only when GitHub rejects one (401). */
async function fetchWithFallback(
  repo: BackfillTarget,
  page: number,
  candidates: TokenCandidate[],
  cursor: { index: number },
  fetchPage: typeof fetchReleasesPage,
  jobSignal: AbortSignal | undefined,
): Promise<FetchReleasesPageResult> {
  for (;;) {
    const candidate = candidates[cursor.index]!;
    const timeout = AbortSignal.timeout(GITHUB_REQUEST_TIMEOUT_MS);
    const signal = jobSignal ? AbortSignal.any([jobSignal, timeout]) : timeout;
    try {
      return await fetchPage({ owner: repo.owner, name: repo.name, page, accessToken: candidate.token, signal });
    } catch (error) {
      if (isGitHubHttpError(error) && error.status === 401 && cursor.index < candidates.length - 1) {
        log.warn(`${repo.fullName}: token of user ${candidate.userId} was rejected (401); trying the next one`);
        cursor.index += 1;
        continue;
      }
      throw error;
    }
  }
}

/** Best effort, like repo-poll: the import is committed; a missed refresh is fixed by the next page load. */
async function publishBackfilled(deps: ReleaseBackfillDeps, repo: BackfillTarget, added: number): Promise<void> {
  const subscribers = await deps.prisma.userSubscription.findMany({
    where: { repositoryId: repo.id },
    select: { userId: true },
  });
  await Promise.all(
    subscribers.map(async ({ userId }) => {
      try {
        await publishUserEvent(deps.redis, userId, {
          type: "HISTORY_BACKFILLED",
          repositoryId: repo.id,
          repositoryName: repo.fullName,
          added,
        });
      } catch (error) {
        log.error(`could not publish HISTORY_BACKFILLED to user ${userId}`, error);
      }
    }),
  );
}

/**
 * `release-backfill` job: pages through a repository's older releases (100 per page, newest first)
 * and stores them as history, until the repository holds `backfillTarget` releases, GitHub has no
 * more pages, or (automatic backfill only) releases get older than `RELEASE_BACKFILL_MAX_AGE_DAYS`.
 *
 * - History is stored **without** `UserReleaseState` rows, which by definition means read: it never
 *   touches unread counters and never notifies.
 * - Releases newer than the newest stored one are skipped: they are genuinely new and belong to
 *   repo-poll, which fans them out as unread.
 * - `backfillNextPage` is persisted after every page, so a restart or a rate-limit pause resumes there.
 * - Below `RELEASE_BACKFILL_MIN_QUOTA` remaining requests, or on a rate-limit response, the job moves
 *   itself to delayed until the quota resets, so the backfill never starves regular polling.
 */
export async function processReleaseBackfill(
  job: Job<ReleaseBackfillJobData>,
  token: string | undefined,
  deps: ReleaseBackfillDeps,
  jobSignal?: AbortSignal,
): Promise<ReleaseBackfillOutcome> {
  const { prisma } = deps;
  const config = deps.config ?? readBackfillConfig();
  const now = () => deps.now?.() ?? new Date();
  const fetchPage = deps.fetchPage ?? fetchReleasesPage;
  const { repositoryId, trigger } = job.data;

  const row = await prisma.repository.findUnique({
    where: { id: repositoryId },
    select: {
      id: true,
      owner: true,
      name: true,
      fullName: true,
      backfillNextPage: true,
      backfilledAt: true,
      _count: { select: { subscriptions: true } },
    },
  });
  if (!row) return { status: "SKIPPED", reason: "REPOSITORY_GONE" };
  const repo: BackfillTarget = row;
  const setStatus = (data: Parameters<PrismaClient["repository"]["update"]>[0]["data"]) =>
    prisma.repository.update({ where: { id: repositoryId }, data });

  if (row._count.subscriptions === 0) {
    // Nobody left to import for. The next "Add repository" re-queues it and resumes from backfillNextPage.
    await setStatus({ backfillStatus: "NONE" });
    return { status: "SKIPPED", reason: "NO_SUBSCRIBERS" };
  }

  // The first run applies RELEASE_BACKFILL_DEFAULT_TARGET; later runs keep the stored target, which
  // "Load older releases" may have raised.
  const firstRun = row.backfilledAt === null && row.backfillNextPage === null;
  await setStatus({ backfillStatus: "RUNNING", ...(firstRun ? { backfillTarget: config.defaultTarget } : {}) });

  let page = row.backfillNextPage ?? 1;
  let added = 0;
  let pages = 0;

  const finish = async (stop: BackfillStop, nextPage: number | null): Promise<ReleaseBackfillOutcome> => {
    await setStatus({ backfillStatus: stop.status, backfillNextPage: nextPage, backfilledAt: now() });
    log.info(
      `${repo.fullName}: backfill ${stop.status} (${stop.reason}), ${added} releases imported over ${pages} page(s)` +
        (nextPage === null ? "" : `, resumes at page ${nextPage}`),
    );
    await publishBackfilled(deps, repo, added);
    return { status: "FINISHED", backfillStatus: stop.status, reason: stop.reason, added, pages };
  };

  /** Re-queues this same job (same jobId, no attempt used) until the quota resets, then exits. */
  const pauseUntil = async (resetAt: Date | null, why: string): Promise<never> => {
    const delayMs = rateLimitDelayMs(resetAt, now());
    await setStatus({ backfillStatus: "QUEUED", backfillNextPage: page });
    log.warn(`${repo.fullName}: ${why}; backfill paused for ${Math.ceil(delayMs / 1000)}s at page ${page}`);
    await job.moveToDelayed(now().getTime() + delayMs, token);
    throw new DelayedError();
  };

  try {
    const candidates = await tokenCandidates(prisma, repositoryId, undefined);
    const cursor = { index: 0 };

    for (;;) {
      // Re-read every page: "Load older releases" may raise the target while this job runs.
      const [current, storedCount, newest] = await Promise.all([
        prisma.repository.findUnique({ where: { id: repositoryId }, select: { backfillTarget: true } }),
        prisma.release.count({ where: { repositoryId } }),
        prisma.release.findFirst({ where: { repositoryId }, orderBy: { publishedAt: "desc" }, select: { publishedAt: true } }),
      ]);
      // Nothing stored means GitHub had no releases when the repository was added; anything
      // published since is new and arrives through repo-poll.
      if (!newest) return await finish({ status: "DONE", reason: "COMPLETE" }, null);

      const target = effectiveTarget(current?.backfillTarget ?? 0, config.hardCap);
      if (storedCount >= target) return await finish(targetStop(target, config.hardCap), page);

      const result = await fetchWithFallback(repo, page, candidates, cursor, fetchPage, jobSignal);
      pages += 1;

      const ids = result.releases.map((r) => r.githubReleaseId);
      const stored =
        ids.length > 0
          ? await prisma.release.findMany({
              where: { repositoryId, githubReleaseId: { in: ids } },
              select: { githubReleaseId: true },
            })
          : [];

      const plan = planBackfillPage({
        page,
        releases: result.releases,
        hasNextPage: result.hasNextPage,
        storedIds: new Set(stored.map((r) => r.githubReleaseId)),
        storedCount,
        target,
        hardCap: config.hardCap,
        newestKnownAt: newest.publishedAt,
        cutoff: maxAgeCutoff(config, target, now()),
      });

      if (plan.insert.length > 0) {
        // Idempotent through the (repositoryId, githubReleaseId) unique key. No UserReleaseState rows.
        const { count } = await prisma.release.createMany({
          data: plan.insert.map((release) => ({ ...release, repositoryId })),
          skipDuplicates: true,
        });
        added += count;
      }

      if (plan.stop) return await finish(plan.stop, plan.stop.reason === "COMPLETE" ? null : plan.nextPage);

      page = plan.nextPage;
      await setStatus({ backfillNextPage: page });

      if (result.rateLimitRemaining !== null && result.rateLimitRemaining < config.minQuota) {
        await pauseUntil(result.rateLimitResetAt, `GitHub quota ${result.rateLimitRemaining} is below ${config.minQuota}`);
      }
    }
  } catch (error) {
    if (error instanceof DelayedError) throw error;

    if (error instanceof GitHubRateLimitError) {
      return await pauseUntil(error.resetAt, "GitHub rate limit exceeded");
    }

    if (error instanceof GitHubRepositoryNotFoundError) {
      // Removal of vanished repositories is repo-poll's job (errorCount / ERROR).
      await setStatus({ backfillStatus: "ERROR" });
      log.warn(`${repo.fullName}: HTTP 404 Not Found; backfill stopped (trigger ${trigger})`);
      return { status: "NOT_FOUND" };
    }

    // Network errors, timeouts, 5xx: BullMQ retries with exponential backoff, resuming at backfillNextPage.
    const finalAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
    await setStatus({ backfillStatus: finalAttempt ? "ERROR" : "QUEUED" }).catch((e: unknown) =>
      log.error(`${repo.fullName}: could not record the backfill failure`, e),
    );
    throw error;
  }
}

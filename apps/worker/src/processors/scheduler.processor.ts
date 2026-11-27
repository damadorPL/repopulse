import type { Prisma, PrismaClient } from "@repopulse/db";
import {
  deduplicatedJobOptions,
  JOB_NAMES,
  QUEUE_NAMES,
  RELEASE_BACKFILL_PRIORITY,
  REPO_POLL_PRIORITY,
  releaseBackfillJobId,
  repoPollJobId,
  type ReleaseBackfillQueue,
  type RepoPollQueue,
} from "@repopulse/queue";
import { createLogger } from "../logger.js";

const log = createLogger("repo-scheduler");

/** A repository is due when its last poll is older than this (the cron default is 30 min). */
export const REPOLL_AFTER_MS = 25 * 60_000;
/** A `POLLING` row this old belongs to a worker that died mid-poll; poll it again. */
export const STALE_POLLING_MS = 15 * 60_000;
/** Repositories in `ERROR` (e.g. 5× 404) are retried, but only every 6 hours. */
export const ERROR_REPOLL_AFTER_MS = 6 * 60 * 60_000;

export const ENQUEUE_BATCH_SIZE = 500;
/** Repositories handed to `release-backfill` per tick, so pre-existing repositories catch up gradually. */
export const BACKFILL_SWEEP_BATCH = 10;

function polledBefore(cutoff: Date): Prisma.RepositoryWhereInput {
  return { OR: [{ lastPolledAt: null }, { lastPolledAt: { lt: cutoff } }] };
}

/**
 * Due repositories: at least one subscriber, not currently being polled, and not polled in the
 * last 25 minutes. Repositories shared by many users appear once, so each is polled once per
 * interval no matter how many people track it.
 */
export function dueRepositoriesWhere(now: Date): Prisma.RepositoryWhereInput {
  const ago = (ms: number) => new Date(now.getTime() - ms);
  return {
    subscriptions: { some: {} },
    OR: [
      { pollStatus: "IDLE", ...polledBefore(ago(REPOLL_AFTER_MS)) },
      { pollStatus: "POLLING", updatedAt: { lt: ago(STALE_POLLING_MS) }, ...polledBefore(ago(REPOLL_AFTER_MS)) },
      { pollStatus: "ERROR", ...polledBefore(ago(ERROR_REPOLL_AFTER_MS)) },
    ],
  };
}

/**
 * Repositories whose history still needs importing: never backfilled (`NONE`, e.g. added before
 * Slice 04b or while Redis was down), plus `QUEUED`/`RUNNING` ones, whose job may have been lost
 * (Redis flushed). Re-adding those is a no-op while their `backfill-{id}` job still exists.
 */
export function backfillSweepWhere(): Prisma.RepositoryWhereInput {
  return { subscriptions: { some: {} }, backfillStatus: { in: ["NONE", "QUEUED", "RUNNING"] } };
}

export interface SchedulerDeps {
  prisma: PrismaClient;
  repoPollQueue: Pick<RepoPollQueue, "addBulk">;
  releaseBackfillQueue: Pick<ReleaseBackfillQueue, "addBulk">;
  now?: () => Date;
}

/** Hands up to {@link BACKFILL_SWEEP_BATCH} repositories to `release-backfill`, never-backfilled ones first. */
async function sweepBackfills(deps: SchedulerDeps): Promise<number> {
  const pending = await deps.prisma.repository.findMany({
    where: backfillSweepWhere(),
    select: { id: true, backfillStatus: true },
    // Enum columns sort in declaration order: NONE < QUEUED < RUNNING.
    orderBy: [{ backfillStatus: "asc" }, { createdAt: "asc" }],
    take: BACKFILL_SWEEP_BATCH,
  });
  if (pending.length === 0) return 0;

  await deps.releaseBackfillQueue.addBulk(
    pending.map((repo) => ({
      name: JOB_NAMES.backfill,
      data: { repositoryId: repo.id, trigger: "sweep" as const },
      opts: deduplicatedJobOptions(releaseBackfillJobId(repo.id), RELEASE_BACKFILL_PRIORITY.automatic),
    })),
  );
  const fresh = pending.filter((repo) => repo.backfillStatus === "NONE").map((repo) => repo.id);
  if (fresh.length > 0) {
    // Only NONE -> QUEUED: a job that already started has moved the row on.
    await deps.prisma.repository.updateMany({
      where: { id: { in: fresh }, backfillStatus: "NONE" },
      data: { backfillStatus: "QUEUED" },
    });
  }
  return fresh.length;
}

/**
 * `repo-scheduler` tick: enqueue one `repo-poll` job per due repository. BullMQ's deduplication
 * (`poll-{repositoryId}`, `keepLastIfActive: true`) avoids stacking polls when a tick overlaps
 * with an existing or active job (e.g. a manual sync).
 */
export async function processSchedulerTick(deps: SchedulerDeps): Promise<{ due: number; backfills: number }> {
  const now = deps.now?.() ?? new Date();
  const where = dueRepositoriesWhere(now);
  let cursorId: string | undefined;
  let dueCount = 0;

  for (;;) {
    const batch = await deps.prisma.repository.findMany({
      where,
      select: { id: true },
      orderBy: [{ lastPolledAt: { sort: "asc", nulls: "first" } }, { id: "asc" }],
      take: ENQUEUE_BATCH_SIZE,
      ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
    });
    if (batch.length === 0) break;

    await deps.repoPollQueue.addBulk(
      batch.map((repo) => ({
        name: JOB_NAMES.poll,
        data: { repositoryId: repo.id, trigger: "schedule" as const },
        opts: deduplicatedJobOptions(repoPollJobId(repo.id), REPO_POLL_PRIORITY.scheduled),
      })),
    );
    dueCount += batch.length;
    if (batch.length < ENQUEUE_BATCH_SIZE) break;
    cursorId = batch[batch.length - 1]!.id;
  }

  log.info(
    { queue: QUEUE_NAMES.scheduler, due: dueCount },
    `${dueCount} due ${dueCount === 1 ? "repository" : "repositories"} enqueued`,
  );

  // History is secondary: a failure here must not fail the poll tick.
  let backfills = 0;
  try {
    backfills = await sweepBackfills(deps);
    if (backfills > 0) {
      log.info(
        { queue: QUEUE_NAMES.scheduler, backfills },
        `${backfills} ${backfills === 1 ? "repository" : "repositories"} queued for history backfill`,
      );
    }
  } catch (error) {
    log.error({ queue: QUEUE_NAMES.scheduler, err: error }, "could not queue history backfills");
  }
  return { due: dueCount, backfills };
}

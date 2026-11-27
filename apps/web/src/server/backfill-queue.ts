import { enqueueDeduplicated, JOB_NAMES, releaseBackfillJobId, type ReleaseBackfillJobData } from "@repopulse/queue";
import { getReleaseBackfillQueue, withRedisTimeout } from "@/server/realtime";

/**
 * Producer side of the `release-backfill` queue. Deliberately not a `"use server"` module: these
 * helpers must never be callable from the browser.
 */

/**
 * Enqueues one history import for a repository. Deduplication (`backfill-{repositoryId}`,
 * `keepLastIfActive: true`) prevents duplicate concurrent backfills. A waiting one is bumped to
 * `priority`; a delayed one (rate-limit pause) or an active one is left alone, since it re-reads
 * `backfillTarget` from the database on every page.
 *
 * Rejects with `RealtimeUnavailableError` when Redis is not configured or does not answer.
 */
export async function enqueueReleaseBackfill(data: ReleaseBackfillJobData, priority: number): Promise<void> {
  const queue = getReleaseBackfillQueue();
  await withRedisTimeout(
    enqueueDeduplicated({
      queue,
      name: JOB_NAMES.backfill,
      data,
      deduplicationId: releaseBackfillJobId(data.repositoryId),
      priority,
    }),
  );
}

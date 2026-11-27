import { enqueueDeduplicated, JOB_NAMES, REPO_POLL_PRIORITY, repoPollJobId } from "@repopulse/queue";
import { getRepoPollQueue, isRealtimeConfigured, withRedisTimeout } from "@/server/realtime";

/**
 * Queues a priority `repo-poll` job so a repository's tags ("Releases + tags") or the commits of
 * newly watched paths ("Files / folders") are imported right away instead of at the next
 * scheduled poll. Not a `"use server"` module, so it can't be called from the browser.
 *
 * Best effort and quiet (no SYNC_* events): the scheduled poll imports them anyway. A queued job
 * (dedup id `poll-{id}`) is bumped to priority; an active one already runs the tag and path
 * steps (a path watched after it read the subscriptions is picked up by the next poll).
 */
export async function queueRepoImport(repositoryId: string, caller: string): Promise<void> {
  if (!isRealtimeConfigured()) return;
  try {
    const queue = getRepoPollQueue();
    await withRedisTimeout(
      enqueueDeduplicated({
        queue,
        name: JOB_NAMES.poll,
        data: { repositoryId, trigger: "schedule" },
        deduplicationId: repoPollJobId(repositoryId),
        priority: REPO_POLL_PRIORITY.manual,
      }),
    );
  } catch (error) {
    console.warn(`[${caller}] could not queue the import of ${repositoryId}`, error);
  }
}

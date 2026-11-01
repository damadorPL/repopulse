import { JOB_NAMES, REPO_POLL_PRIORITY, repoPollJobId } from "@repopulse/queue";
import { getRepoPollQueue, isRealtimeConfigured, withRedisTimeout } from "@/server/realtime";

/**
 * Queues a priority `repo-poll` job so a repository's tags ("Releases + tags") or the commits of
 * newly watched paths ("Files / folders") are imported right away instead of at the next
 * scheduled poll. Not a `"use server"` module, so it can't be called from the browser.
 *
 * Best effort and quiet (no SYNC_* events): the scheduled poll imports them anyway. A queued job
 * (jobId `poll-{id}`) is only bumped to priority; an active one already runs the tag and path
 * steps (a path watched after it read the subscriptions is picked up by the next poll).
 */
export async function queueRepoImport(repositoryId: string, caller: string): Promise<void> {
  if (!isRealtimeConfigured()) return;
  try {
    const queue = getRepoPollQueue();
    const jobId = repoPollJobId(repositoryId);
    await withRedisTimeout(
      (async () => {
        const existing = await queue.getJob(jobId);
        if (!existing) {
          await queue.add(JOB_NAMES.poll, { repositoryId, trigger: "schedule" }, { jobId, priority: REPO_POLL_PRIORITY.manual });
          return;
        }
        const state = await existing.getState();
        if (state === "waiting" || state === "prioritized") await existing.changePriority({ priority: REPO_POLL_PRIORITY.manual });
      })(),
    );
  } catch (error) {
    console.warn(`[${caller}] could not queue the import of ${repositoryId}`, error);
  }
}

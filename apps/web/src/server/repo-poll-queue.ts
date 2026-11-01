import { JOB_NAMES, REPO_POLL_PRIORITY, repoPollJobId } from "@repopulse/queue";
import { getRepoPollQueue, isRealtimeConfigured, withRedisTimeout } from "@/server/realtime";

/**
 * Queues a priority `repo-poll` job so a repository's tags are imported right away: its first
 * "Releases + tags" subscriber should not wait for the next scheduled poll. Not a `"use server"`
 * module, so it can't be called from the browser.
 *
 * Best effort and quiet (no SYNC_* events): the scheduled poll imports the tags anyway. A queued
 * job (jobId `poll-{id}`) is only bumped to priority; an active one already runs the tag step.
 */
export async function queueTagImport(repositoryId: string, caller: string): Promise<void> {
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
    console.warn(`[${caller}] could not queue the tag import of ${repositoryId}`, error);
  }
}

import {
  createDepsScanQueue,
  deduplicatedJobOptions,
  DEPS_JOB_NAMES,
  DEPS_SCAN_PRIORITY,
  depsScanJobId,
  type DepsScanQueue,
} from "@repopulse/queue";
import { getRedis, isRealtimeConfigured, RealtimeUnavailableError, withRedisTimeout } from "@/server/realtime";

/**
 * `deps-scan` producer of the GitHub App webhook route (Slice 08 Part E). Not a `"use server"` module.
 *
 * Shares the cached `Queue` instance with the Dependencies actions (same `globalThis` key, same
 * options), so the web process holds one producer for the queue.
 */
const globalForDeps = globalThis as unknown as { repopulseDepsScanQueue?: DepsScanQueue };

function getDepsScanQueue(): DepsScanQueue {
  globalForDeps.repopulseDepsScanQueue ??= createDepsScanQueue(getRedis(), (err) =>
    console.error(`[deps-webhook] queue error: ${err.message}`),
  );
  return globalForDeps.repopulseDepsScanQueue;
}

/**
 * Queues a `deps-scan` with `trigger: "webhook"`. Deduplication (`deps-scan-{projectId}`,
 * `keepLastIfActive: true`) absorbs bursts of pushes and schedules at most one follow-up if a scan
 * is currently active. Throws {@link RealtimeUnavailableError} when Redis is not configured or does
 * not answer.
 */
export async function enqueueWebhookScan(projectId: string): Promise<void> {
  if (!isRealtimeConfigured())
    throw new RealtimeUnavailableError("Background jobs are not configured (REDIS_URL is not set).");
  const queue = getDepsScanQueue();
  await withRedisTimeout(
    queue.add(
      DEPS_JOB_NAMES.scan,
      { projectId, trigger: "webhook" },
      deduplicatedJobOptions(depsScanJobId(projectId), DEPS_SCAN_PRIORITY.webhook),
    ),
  );
}

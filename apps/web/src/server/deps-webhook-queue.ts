import { Queue } from "bullmq";
import {
  DEPS_JOB_NAMES,
  DEPS_QUEUE_NAMES,
  DEPS_SCAN_JOB_OPTIONS,
  DEPS_SCAN_PRIORITY,
  depsScanJobId,
  type DepsScanJobData,
} from "@repopulse/queue";
import { getRedis, isRealtimeConfigured, RealtimeUnavailableError, withRedisTimeout } from "@/server/realtime";

/**
 * `deps-scan` producer of the GitHub App webhook route (Slice 08 Part E). Not a `"use server"` module.
 *
 * Shares the cached `Queue` instance with the Dependencies actions (same `globalThis` key, same
 * options), so the web process holds one producer for the queue.
 */
const globalForDeps = globalThis as unknown as { repopulseDepsScanQueue?: Queue<DepsScanJobData> };

function getDepsScanQueue(): Queue<DepsScanJobData> {
  globalForDeps.repopulseDepsScanQueue ??= new Queue<DepsScanJobData>(DEPS_QUEUE_NAMES.scan, {
    connection: getRedis(),
    defaultJobOptions: DEPS_SCAN_JOB_OPTIONS,
  });
  return globalForDeps.repopulseDepsScanQueue;
}

/**
 * Queues a `deps-scan` with `trigger: "webhook"`. The jobId `deps-scan-{projectId}` absorbs bursts of
 * pushes: a scan that is already queued (scheduled, manual or from an earlier delivery) is left as it is.
 * Throws {@link RealtimeUnavailableError} when Redis is not configured or does not answer.
 */
export async function enqueueWebhookScan(projectId: string): Promise<void> {
  if (!isRealtimeConfigured()) throw new RealtimeUnavailableError("Background jobs are not configured (REDIS_URL is not set).");
  const queue = getDepsScanQueue();
  const jobId = depsScanJobId(projectId);
  // BullMQ ignores an add whose jobId already exists (waiting, delayed or active).
  await withRedisTimeout(queue.add(DEPS_JOB_NAMES.scan, { projectId, trigger: "webhook" }, { jobId, priority: DEPS_SCAN_PRIORITY.webhook }));
}

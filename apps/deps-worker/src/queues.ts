import {
  createDepsNotifyQueue,
  createDepsScanQueue,
  createDepsSchedulerQueue,
  createDepsUpdateQueue,
  deduplicatedJobOptions,
  DEPS_JOB_NAMES,
  DEPS_QUEUE_NAMES,
  DEPS_SCHEDULER_ID,
  type DepsNotifyQueue,
  type DepsScanQueue,
  type DepsSchedulerQueue,
  type DepsUpdateQueue,
} from "@repopulse/queue";
import type { ConnectionOptions } from "bullmq";

import { createLogger } from "./logger.js";

export interface DepsQueues {
  schedulerQueue: DepsSchedulerQueue;
  scanQueue: DepsScanQueue;
  updateQueue: DepsUpdateQueue;
  notifyQueue: DepsNotifyQueue;
}

function queueErrorHandler(name: string): (err: Error) => void {
  const log = createLogger(`queue:${name}`);
  return (err) => log.error({ queue: name, err }, "queue error");
}

export function createQueues(connection: ConnectionOptions): DepsQueues {
  return {
    schedulerQueue: createDepsSchedulerQueue(connection, queueErrorHandler(DEPS_QUEUE_NAMES.scheduler)),
    scanQueue: createDepsScanQueue(connection, queueErrorHandler(DEPS_QUEUE_NAMES.scan)),
    updateQueue: createDepsUpdateQueue(connection, queueErrorHandler(DEPS_QUEUE_NAMES.update)),
    notifyQueue: createDepsNotifyQueue(connection, queueErrorHandler(DEPS_QUEUE_NAMES.notify)),
  };
}

export function closeQueues(queues: DepsQueues): Promise<void[]> {
  return Promise.all([
    queues.schedulerQueue.close(),
    queues.scanQueue.close(),
    queues.updateQueue.close(),
    queues.notifyQueue.close(),
  ]);
}

/**
 * Registers (or updates) the repeatable `deps-scheduler` tick by its fixed id, so restarts and replicas keep one
 * schedule and a changed `DEPS_SCAN_CRON` replaces the old pattern. A deduplicated tick also runs right away.
 */
export async function registerSchedule(schedulerQueue: DepsSchedulerQueue, cron: string): Promise<void> {
  await schedulerQueue.upsertJobScheduler(
    DEPS_SCHEDULER_ID,
    { pattern: cron },
    { name: DEPS_JOB_NAMES.schedule, data: {} },
  );
  await schedulerQueue.add(DEPS_JOB_NAMES.schedule, {}, deduplicatedJobOptions(`${DEPS_SCHEDULER_ID}-startup`));
}

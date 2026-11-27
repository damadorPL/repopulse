import type { ConnectionOptions, Queue } from "bullmq";
import {
  createNotificationQueue,
  createReleaseBackfillQueue,
  createRepoPollQueue,
  createSchedulerQueue,
  DEFAULT_POLL_INTERVAL_CRON,
  deduplicatedJobOptions,
  JOB_NAMES,
  QUEUE_NAMES,
  SCHEDULER_ID,
  type NotificationQueue,
  type ReleaseBackfillQueue,
  type RepoPollQueue,
  type SchedulerJobData,
  type SchedulerQueue,
} from "@repopulse/queue";
import { createLogger } from "../logger.js";

export interface Queues {
  /** `repo-scheduler`: one repeatable job that finds due repositories. */
  schedulerQueue: SchedulerQueue;
  /** `repo-poll`: one job per repository check (deduplication id `poll-{repositoryId}`). */
  repoPollQueue: RepoPollQueue;
  /** `notification-dispatch`: one job per (rule, release), delivered by `@repopulse/notifications`. */
  notificationQueue: NotificationQueue;
  /** `release-backfill`: one history import per repository (deduplication id `backfill-{repositoryId}`). */
  releaseBackfillQueue: ReleaseBackfillQueue;
}

function queueErrorHandler(name: string): (err: Error) => void {
  const log = createLogger(`queue:${name}`);
  return (err) => log.error({ queue: name, err }, "queue error");
}

export function createQueues(connection: ConnectionOptions): Queues {
  return {
    schedulerQueue: createSchedulerQueue(connection, queueErrorHandler(QUEUE_NAMES.scheduler)),
    repoPollQueue: createRepoPollQueue(connection, queueErrorHandler(QUEUE_NAMES.repoPoll)),
    notificationQueue: createNotificationQueue(connection, queueErrorHandler(QUEUE_NAMES.notification)),
    releaseBackfillQueue: createReleaseBackfillQueue(connection, queueErrorHandler(QUEUE_NAMES.releaseBackfill)),
  };
}

export function closeQueues(queues: Queues): Promise<void[]> {
  return Promise.all([
    queues.schedulerQueue.close(),
    queues.repoPollQueue.close(),
    queues.notificationQueue.close(),
    queues.releaseBackfillQueue.close(),
  ]);
}

export function pollIntervalCron(): string {
  return process.env.POLL_INTERVAL_CRON?.trim() || DEFAULT_POLL_INTERVAL_CRON;
}

export const MAINTENANCE_SCHEDULER_ID = "db-maintenance";
export const MAINTENANCE_CRON = "17 3 * * *";

type MaintenanceSchedulerQueue = Queue<SchedulerJobData, unknown, typeof MAINTENANCE_SCHEDULER_ID>;

/**
 * Registers (or updates) the repeatable scan on `repo-scheduler`. Upserting by a fixed id keeps
 * exactly one schedule across restarts and replicas, and a changed POLL_INTERVAL_CRON replaces
 * the old pattern instead of adding a second one. A deduplicated one-off scan also runs right
 * away, so a fresh deploy does not wait a full interval for its first poll.
 */
export async function registerSchedule(schedulerQueue: SchedulerQueue, cron: string): Promise<void> {
  await schedulerQueue.upsertJobScheduler(SCHEDULER_ID, { pattern: cron }, { name: JOB_NAMES.scan, data: {} });
  await schedulerQueue.add(JOB_NAMES.scan, {}, deduplicatedJobOptions(`${SCHEDULER_ID}-startup`));
}

/**
 * Registers (or updates) the daily data-lifecycle maintenance job on `repo-scheduler`.
 */
export async function registerMaintenanceSchedule(schedulerQueue: SchedulerQueue): Promise<void> {
  await (schedulerQueue as unknown as MaintenanceSchedulerQueue).upsertJobScheduler(
    MAINTENANCE_SCHEDULER_ID,
    { pattern: MAINTENANCE_CRON },
    { name: MAINTENANCE_SCHEDULER_ID, data: {} },
  );
}

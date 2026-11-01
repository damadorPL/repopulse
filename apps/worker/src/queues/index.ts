import { Queue, type ConnectionOptions } from "bullmq";
import {
  DEFAULT_POLL_INTERVAL_CRON,
  JOB_NAMES,
  NOTIFICATION_JOB_OPTIONS,
  QUEUE_NAMES,
  RELEASE_BACKFILL_JOB_OPTIONS,
  REPO_POLL_JOB_OPTIONS,
  SCHEDULER_ID,
  type NotificationJobData,
  type ReleaseBackfillJobData,
  type RepoPollJobData,
  type SchedulerJobData,
} from "@repopulse/queue";

export interface Queues {
  /** `repo-scheduler`: one repeatable job that finds due repositories. */
  schedulerQueue: Queue<SchedulerJobData>;
  /** `repo-poll`: one job per repository check (jobId `poll-{repositoryId}`). */
  repoPollQueue: Queue<RepoPollJobData>;
  /** `notification-dispatch`: one job per (rule, release), delivered by `@repopulse/notifications`. */
  notificationQueue: Queue<NotificationJobData>;
  /** `release-backfill`: one history import per repository (jobId `backfill-{repositoryId}`). */
  releaseBackfillQueue: Queue<ReleaseBackfillJobData>;
}

export function createQueues(connection: ConnectionOptions): Queues {
  return {
    schedulerQueue: new Queue<SchedulerJobData>(QUEUE_NAMES.scheduler, {
      connection,
      defaultJobOptions: { removeOnComplete: true, removeOnFail: { count: 50 } },
    }),
    repoPollQueue: new Queue<RepoPollJobData>(QUEUE_NAMES.repoPoll, {
      connection,
      defaultJobOptions: REPO_POLL_JOB_OPTIONS,
    }),
    notificationQueue: new Queue<NotificationJobData>(QUEUE_NAMES.notification, {
      connection,
      defaultJobOptions: NOTIFICATION_JOB_OPTIONS,
    }),
    releaseBackfillQueue: new Queue<ReleaseBackfillJobData>(QUEUE_NAMES.releaseBackfill, {
      connection,
      defaultJobOptions: RELEASE_BACKFILL_JOB_OPTIONS,
    }),
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

/**
 * Registers (or updates) the repeatable scan on `repo-scheduler`. Upserting by a fixed id keeps
 * exactly one schedule across restarts and replicas, and a changed POLL_INTERVAL_CRON replaces
 * the old pattern instead of adding a second one. A one-off scan also runs right away, so a
 * fresh deploy does not wait a full interval for its first poll.
 */
export async function registerSchedule(schedulerQueue: Queue<SchedulerJobData>, cron: string): Promise<void> {
  await schedulerQueue.upsertJobScheduler(SCHEDULER_ID, { pattern: cron }, { name: JOB_NAMES.scan, data: {} });
  await schedulerQueue.add(JOB_NAMES.scan, {});
}

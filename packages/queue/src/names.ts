import type { ConnectionOptions, JobsOptions, Queue } from "bullmq";

import { createQueue } from "./queues.js";

/** BullMQ queue names, shared by every producer (worker, web) and consumer (worker). */
export const QUEUE_NAMES = {
  scheduler: "repo-scheduler",
  repoPoll: "repo-poll",
  notification: "notification-dispatch",
  releaseBackfill: "release-backfill",
} as const;

export const JOB_NAMES = {
  scan: "scan-due-repositories",
  poll: "poll-repository",
  notify: "dispatch-notification",
  backfill: "backfill-releases",
} as const;

/** Id of the repeatable job scheduler on the `repo-scheduler` queue. */
export const SCHEDULER_ID = "repo-scheduler-cron";

export const DEFAULT_POLL_INTERVAL_CRON = "*/30 * * * *";

export type SchedulerJobData = Record<string, never>;

export interface RepoPollJobData {
  repositoryId: string;
  trigger: "schedule" | "manual";
  /** Set for manual syncs: this user gets SYNC_* events and their token is tried first. */
  requestedByUserId?: string;
}

export interface ReleaseBackfillJobData {
  repositoryId: string;
  /** Why the job was queued; informational (logs). */
  trigger: "add" | "sweep" | "deep" | "retry";
}

/** One delivery of one notification rule for one release (consumed by the worker's notification processor). */
export interface NotificationJobData {
  ruleId: string;
  releaseId: string;
  userId: string;
}

export type SchedulerQueue = Queue<
  SchedulerJobData,
  unknown,
  typeof JOB_NAMES.scan | typeof SCHEDULER_ID | "db-maintenance"
>;
export type RepoPollQueue = Queue<RepoPollJobData, unknown, typeof JOB_NAMES.poll>;
export type NotificationQueue = Queue<NotificationJobData, unknown, typeof JOB_NAMES.notify>;
export type ReleaseBackfillQueue = Queue<ReleaseBackfillJobData, unknown, typeof JOB_NAMES.backfill>;

/**
 * Deduplication id for `repo-poll` (`keepLastIfActive: true`), so the scheduler and "Sync now"
 * never stack concurrent polls for the same repo. BullMQ rejects custom ids containing `:`, hence `-`.
 */
export function repoPollJobId(repositoryId: string): string {
  return `poll-${repositoryId}`;
}

/**
 * Deduplication id for `release-backfill` (`keepLastIfActive: true`); re-adding while queued,
 * delayed (rate limit), or active never runs parallel backfills for the same repo.
 */
export function releaseBackfillJobId(repositoryId: string): string {
  return `backfill-${repositoryId}`;
}

/** One notification per (rule, release); a re-run of the same fan-out cannot double-send. */
export function notificationJobId(ruleId: string, releaseId: string): string {
  return `notify-${ruleId}-${releaseId}`;
}

/**
 * Lower number = higher priority. BullMQ processes jobs *without* a priority before any
 * prioritized job, so scheduled polls carry an explicit lower priority for manual syncs to overtake them.
 */
export const REPO_POLL_PRIORITY = { manual: 1, scheduled: 10 } as const;

export const REPO_POLL_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: "exponential", delay: 30_000 },
  removeOnComplete: { count: 200 },
  removeOnFail: { age: 7 * 24 * 3600, count: 200 },
  keepLogs: 50,
} satisfies JobsOptions;

/** Backfill runs behind polling: user requests ("Load older releases") go before automatic imports. */
export const RELEASE_BACKFILL_PRIORITY = { requested: 1, automatic: 10 } as const;

export const RELEASE_BACKFILL_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: "exponential", delay: 60_000 },
  removeOnComplete: { count: 200 },
  removeOnFail: { age: 7 * 24 * 3600, count: 200 },
  keepLogs: 50,
} satisfies JobsOptions;

/**
 * Slice 05: 3 attempts, exponential backoff from 5 s (5 s, 10 s), so a webhook timeout or a 5xx is
 * retried quickly. Permanent failures (4xx, blocked URL, SMTP not configured) skip the retries.
 */
export const NOTIFICATION_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: "exponential", delay: 5_000 },
  // Retained for a week so the deterministic jobId deduplicates repeat fan-outs.
  removeOnComplete: { age: 7 * 24 * 3600, count: 5000 },
  removeOnFail: { age: 7 * 24 * 3600, count: 5000 },
} satisfies JobsOptions;

const SCHEDULER_JOB_OPTIONS = {
  removeOnComplete: true,
  removeOnFail: { count: 50 },
} satisfies JobsOptions;

export function createSchedulerQueue(connection: ConnectionOptions, onError?: (err: Error) => void): SchedulerQueue {
  return createQueue<SchedulerJobData, typeof JOB_NAMES.scan | typeof SCHEDULER_ID | "db-maintenance">(
    QUEUE_NAMES.scheduler,
    {
      connection,
      defaultJobOptions: SCHEDULER_JOB_OPTIONS,
      ...(onError ? { onError } : {}),
    },
  );
}

export function createRepoPollQueue(connection: ConnectionOptions, onError?: (err: Error) => void): RepoPollQueue {
  return createQueue<RepoPollJobData, typeof JOB_NAMES.poll>(QUEUE_NAMES.repoPoll, {
    connection,
    defaultJobOptions: REPO_POLL_JOB_OPTIONS,
    ...(onError ? { onError } : {}),
  });
}

export function createNotificationQueue(
  connection: ConnectionOptions,
  onError?: (err: Error) => void,
): NotificationQueue {
  return createQueue<NotificationJobData, typeof JOB_NAMES.notify>(QUEUE_NAMES.notification, {
    connection,
    defaultJobOptions: NOTIFICATION_JOB_OPTIONS,
    ...(onError ? { onError } : {}),
  });
}

export function createReleaseBackfillQueue(
  connection: ConnectionOptions,
  onError?: (err: Error) => void,
): ReleaseBackfillQueue {
  return createQueue<ReleaseBackfillJobData, typeof JOB_NAMES.backfill>(QUEUE_NAMES.releaseBackfill, {
    connection,
    defaultJobOptions: RELEASE_BACKFILL_JOB_OPTIONS,
    ...(onError ? { onError } : {}),
  });
}

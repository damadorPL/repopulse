import type { JobsOptions } from "bullmq";

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

/** Slice 05 consumes these jobs; the shape is fixed by its spec. */
export interface NotificationJobData {
  ruleId: string;
  releaseId: string;
  userId: string;
}

/**
 * One job per repository at a time. BullMQ ignores an add whose jobId already exists, so the
 * scheduler and "Sync now" never stack polls for the same repo. BullMQ rejects custom ids
 * containing `:` (its key separator), hence `-`.
 */
export function repoPollJobId(repositoryId: string): string {
  return `poll-${repositoryId}`;
}

/**
 * One backfill per repository at a time; re-adding while one is queued, delayed (rate limit) or
 * running is a no-op. `-` rather than the spec's `backfill:{id}`, since BullMQ rejects `:` in ids.
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
  // Finished jobs must disappear: a retained job keeps its jobId taken and would block the
  // next poll of that repository. Outcomes are logged and stored on the Repository row.
  removeOnComplete: true,
  removeOnFail: true,
} satisfies JobsOptions;

/** Backfill runs behind polling: user requests ("Load older releases") go before automatic imports. */
export const RELEASE_BACKFILL_PRIORITY = { requested: 1, automatic: 10 } as const;

export const RELEASE_BACKFILL_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: "exponential", delay: 60_000 },
  // Same reason as repo-poll: a retained job would keep `backfill-{id}` taken.
  removeOnComplete: true,
  removeOnFail: true,
} satisfies JobsOptions;

export const NOTIFICATION_JOB_OPTIONS = {
  attempts: 5,
  backoff: { type: "exponential", delay: 60_000 },
  // Retained for a week so the deterministic jobId deduplicates repeat fan-outs.
  removeOnComplete: { age: 7 * 24 * 3600, count: 5000 },
  removeOnFail: { age: 7 * 24 * 3600 },
} satisfies JobsOptions;

import type { ConnectionOptions, JobsOptions, Queue } from "bullmq";

import { createQueue } from "./queues.js";

/**
 * Slice 08: queues of the Dependencies module, consumed by `apps/deps-worker` only. Produced by `apps/web`
 * (add project, "Check now", "Create PR"), by `deps-worker` itself (scheduler, auto PRs, notifications) and by the
 * GitHub App webhook route (Part E). The release `worker` never touches these queues.
 */
export const DEPS_QUEUE_NAMES = {
  scheduler: "deps-scheduler",
  scan: "deps-scan",
  update: "deps-update",
  notify: "deps-notify",
} as const;

export const DEPS_JOB_NAMES = {
  schedule: "scan-due-dependency-projects",
  scan: "scan-dependency-project",
  update: "update-dependency-group",
  notify: "dispatch-dependency-notification",
} as const;

/** Id of the repeatable job scheduler on the `deps-scheduler` queue. */
export const DEPS_SCHEDULER_ID = "deps-scheduler-cron";

/** `DEPS_SCAN_CRON` default: hourly; each project's `scanIntervalHours` decides what is due. */
export const DEFAULT_DEPS_SCAN_CRON = "17 * * * *";

export type DepsSchedulerJobData = Record<string, never>;

export type DepsScanTrigger = "add" | "schedule" | "manual" | "webhook";

export interface DepsScanJobData {
  projectId: string;
  trigger: DepsScanTrigger;
  /** Set for manual scans: this user gets `DEPS_SCAN_FAILED` on failure. */
  requestedByUserId?: string;
}

export interface DepsUpdateJobData {
  projectId: string;
  /** Slugified, `[a-z0-9-]` only. */
  groupKey: string;
  trigger: "manual" | "auto";
}

export type DepsNotifyJobData =
  | {
      ruleId: string;
      projectId: string;
      kind: "digest";
      /** Identifies the scan that produced the digest (dedup key). */
      scanId: string;
      /** `DependencyUpdate` ids the digest covers (their `notifiedAt` was set with the job). */
      updateIds: string[];
    }
  | {
      ruleId: string;
      projectId: string;
      kind: "pull_request";
      prId: string;
      /** What happened to the PR. */
      event: "opened" | "updated" | "edited" | "access_lost";
      /** Dedup discriminator: the PR head SHA (opened / updated) or the event name. */
      dedupKey: string;
    };

export type DepsSchedulerQueue = Queue<
  DepsSchedulerJobData,
  unknown,
  typeof DEPS_JOB_NAMES.schedule | typeof DEPS_SCHEDULER_ID
>;
export type DepsScanQueue = Queue<DepsScanJobData, unknown, typeof DEPS_JOB_NAMES.scan>;
export type DepsUpdateQueue = Queue<DepsUpdateJobData, unknown, typeof DEPS_JOB_NAMES.update>;
export type DepsNotifyQueue = Queue<DepsNotifyJobData, unknown, typeof DEPS_JOB_NAMES.notify>;

/** Deduplication id for `deps-scan` (`keepLastIfActive: true`), one scan per project at a time. */
export function depsScanJobId(projectId: string): string {
  return `deps-scan-${projectId}`;
}

/** Deduplication id for `deps-update` (`keepLastIfActive: true`), one update per (project, group) at a time. */
export function depsUpdateJobId(projectId: string, groupKey: string): string {
  return `deps-update-${projectId}-${groupKey}`;
}

/** One notification per (rule, scan) or (rule, PR, state); a re-run cannot double-send. */
export function depsNotifyJobId(data: DepsNotifyJobData): string {
  const suffix = data.kind === "digest" ? data.scanId : `${data.prId}-${data.dedupKey}`;
  return `deps-notify-${data.ruleId}-${suffix}`.replace(/[^A-Za-z0-9_-]/g, "-");
}

/** Lower number = higher priority (see `REPO_POLL_PRIORITY`). */
export const DEPS_SCAN_PRIORITY = { manual: 1, add: 1, schedule: 10, webhook: 10 } as const satisfies Record<
  DepsScanTrigger,
  number
>;

export const DEPS_UPDATE_PRIORITY = { manual: 1, auto: 10 } as const;

export const DEPS_SCAN_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: "exponential", delay: 60_000 },
  removeOnComplete: { count: 200 },
  removeOnFail: { age: 7 * 24 * 3600, count: 200 },
  keepLogs: 50,
} satisfies JobsOptions;

export const DEPS_UPDATE_JOB_OPTIONS = {
  attempts: 2,
  backoff: { type: "exponential", delay: 120_000 },
  removeOnComplete: { count: 200 },
  removeOnFail: { age: 7 * 24 * 3600, count: 200 },
  keepLogs: 50,
} satisfies JobsOptions;

export const DEPS_NOTIFY_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: "exponential", delay: 5_000 },
  // Kept for a week so the deterministic jobId deduplicates.
  removeOnComplete: { age: 7 * 24 * 3600, count: 5000 },
  removeOnFail: { age: 7 * 24 * 3600, count: 5000 },
} satisfies JobsOptions;

const DEPS_SCHEDULER_JOB_OPTIONS = {
  removeOnComplete: true,
  removeOnFail: { count: 50 },
} satisfies JobsOptions;

export function createDepsSchedulerQueue(
  connection: ConnectionOptions,
  onError?: (err: Error) => void,
): DepsSchedulerQueue {
  return createQueue<DepsSchedulerJobData, typeof DEPS_JOB_NAMES.schedule | typeof DEPS_SCHEDULER_ID>(
    DEPS_QUEUE_NAMES.scheduler,
    {
      connection,
      defaultJobOptions: DEPS_SCHEDULER_JOB_OPTIONS,
      ...(onError ? { onError } : {}),
    },
  );
}

export function createDepsScanQueue(connection: ConnectionOptions, onError?: (err: Error) => void): DepsScanQueue {
  return createQueue<DepsScanJobData, typeof DEPS_JOB_NAMES.scan>(DEPS_QUEUE_NAMES.scan, {
    connection,
    defaultJobOptions: DEPS_SCAN_JOB_OPTIONS,
    ...(onError ? { onError } : {}),
  });
}

export function createDepsUpdateQueue(connection: ConnectionOptions, onError?: (err: Error) => void): DepsUpdateQueue {
  return createQueue<DepsUpdateJobData, typeof DEPS_JOB_NAMES.update>(DEPS_QUEUE_NAMES.update, {
    connection,
    defaultJobOptions: DEPS_UPDATE_JOB_OPTIONS,
    ...(onError ? { onError } : {}),
  });
}

export function createDepsNotifyQueue(connection: ConnectionOptions, onError?: (err: Error) => void): DepsNotifyQueue {
  return createQueue<DepsNotifyJobData, typeof DEPS_JOB_NAMES.notify>(DEPS_QUEUE_NAMES.notify, {
    connection,
    defaultJobOptions: DEPS_NOTIFY_JOB_OPTIONS,
    ...(onError ? { onError } : {}),
  });
}

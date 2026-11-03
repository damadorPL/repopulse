import type { JobsOptions } from "bullmq";

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

/** One scan per project at a time (BullMQ rejects `:` in custom ids, hence `-`). */
export function depsScanJobId(projectId: string): string {
  return `deps-scan-${projectId}`;
}

/** One update per (project, group) at a time. */
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
  // A retained job would keep `deps-scan-{id}` taken and block the next scan.
  removeOnComplete: true,
  removeOnFail: true,
} satisfies JobsOptions;

export const DEPS_UPDATE_JOB_OPTIONS = {
  attempts: 2,
  backoff: { type: "exponential", delay: 120_000 },
  removeOnComplete: true,
  removeOnFail: true,
} satisfies JobsOptions;

export const DEPS_NOTIFY_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: "exponential", delay: 5_000 },
  // Kept for a week so the deterministic jobId deduplicates.
  removeOnComplete: { age: 7 * 24 * 3600, count: 5000 },
  removeOnFail: { age: 7 * 24 * 3600 },
} satisfies JobsOptions;

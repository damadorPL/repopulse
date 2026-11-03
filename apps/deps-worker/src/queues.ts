import { Queue, type ConnectionOptions } from "bullmq";
import {
  DEPS_JOB_NAMES,
  DEPS_NOTIFY_JOB_OPTIONS,
  DEPS_QUEUE_NAMES,
  DEPS_SCAN_JOB_OPTIONS,
  DEPS_SCHEDULER_ID,
  DEPS_UPDATE_JOB_OPTIONS,
  type DepsNotifyJobData,
  type DepsScanJobData,
  type DepsSchedulerJobData,
  type DepsUpdateJobData,
} from "@repopulse/queue";

export interface DepsQueues {
  schedulerQueue: Queue<DepsSchedulerJobData>;
  scanQueue: Queue<DepsScanJobData>;
  updateQueue: Queue<DepsUpdateJobData>;
  notifyQueue: Queue<DepsNotifyJobData>;
}

export function createQueues(connection: ConnectionOptions): DepsQueues {
  return {
    schedulerQueue: new Queue<DepsSchedulerJobData>(DEPS_QUEUE_NAMES.scheduler, {
      connection,
      defaultJobOptions: { removeOnComplete: true, removeOnFail: { count: 50 } },
    }),
    scanQueue: new Queue<DepsScanJobData>(DEPS_QUEUE_NAMES.scan, { connection, defaultJobOptions: DEPS_SCAN_JOB_OPTIONS }),
    updateQueue: new Queue<DepsUpdateJobData>(DEPS_QUEUE_NAMES.update, { connection, defaultJobOptions: DEPS_UPDATE_JOB_OPTIONS }),
    notifyQueue: new Queue<DepsNotifyJobData>(DEPS_QUEUE_NAMES.notify, { connection, defaultJobOptions: DEPS_NOTIFY_JOB_OPTIONS }),
  };
}

export function closeQueues(queues: DepsQueues): Promise<void[]> {
  return Promise.all([queues.schedulerQueue.close(), queues.scanQueue.close(), queues.updateQueue.close(), queues.notifyQueue.close()]);
}

/**
 * Registers (or updates) the repeatable `deps-scheduler` tick by its fixed id, so restarts and replicas keep one
 * schedule and a changed `DEPS_SCAN_CRON` replaces the old pattern. One tick also runs right away.
 */
export async function registerSchedule(schedulerQueue: Queue<DepsSchedulerJobData>, cron: string): Promise<void> {
  await schedulerQueue.upsertJobScheduler(DEPS_SCHEDULER_ID, { pattern: cron }, { name: DEPS_JOB_NAMES.schedule, data: {} });
  await schedulerQueue.add(DEPS_JOB_NAMES.schedule, {});
}

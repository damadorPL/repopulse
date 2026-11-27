import { Queue, type ConnectionOptions, type Job, type JobsOptions, type Worker } from "bullmq";

import { createLogger } from "./logger.js";

export interface TypedQueueOptions {
  connection: ConnectionOptions;
  defaultJobOptions?: JobsOptions;
  onError?: (err: Error) => void;
}

/**
 * Creates a strongly typed BullMQ {@link Queue} and attaches an `"error"` listener so
 * unhandled ioredis/BullMQ errors never crash the process.
 */
export function createQueue<Data, Name extends string = string, Result = unknown>(
  queueName: string,
  options: TypedQueueOptions,
): Queue<Data, Result, Name> {
  const queue = new Queue<Data, Result, Name>(queueName, {
    connection: options.connection,
    ...(options.defaultJobOptions ? { defaultJobOptions: options.defaultJobOptions } : {}),
  });
  const defaultOnError = options.onError
    ? undefined
    : (() => {
        const log = createLogger(`queue:${queueName}`);
        return (err: Error) => log.error({ queue: queueName, err }, "queue error");
      })();
  queue.on("error", options.onError ?? defaultOnError!);
  return queue;
}

/**
 * Builds BullMQ 6 native deduplication options with `keepLastIfActive: true`, guaranteeing at most
 * one active job and one pending follow-up per `deduplicationId`.
 */
export function deduplicatedJobOptions(deduplicationId: string, priority?: number): JobsOptions {
  return {
    deduplication: { id: deduplicationId, keepLastIfActive: true },
    ...(priority !== undefined ? { priority } : {}),
  };
}

export interface DeduplicatedQueueLike<Data, Name extends string> {
  add(name: Name, data: Data, opts?: JobsOptions): Promise<unknown>;
  getDeduplicationJobId(id: string): Promise<string | null>;
  getJob(
    jobId: string,
  ): Promise<Pick<Job<Data, unknown, Name>, "getState" | "updateData" | "changePriority"> | undefined>;
}

export interface EnqueueDeduplicatedOptions<Data, Name extends string> {
  queue: DeduplicatedQueueLike<Data, Name>;
  name: Name;
  data: Data;
  deduplicationId: string;
  priority: number;
  /** When true, overwrite `data` on an existing waiting, prioritized, or delayed job. */
  updateExistingData?: boolean;
  /** When true, call `queue.add` while active so `keepLastIfActive: true` schedules one follow-up. */
  queueIfActive?: boolean;
}

/**
 * Enqueues a deduplicated job, or takes over an already-queued job via `getDeduplicationJobId`
 * to bump its priority and optionally update its payload.
 */
export async function enqueueDeduplicated<Data, Name extends string>(
  options: EnqueueDeduplicatedOptions<Data, Name>,
): Promise<void> {
  const { queue, name, data, deduplicationId, priority, updateExistingData = false, queueIfActive = false } = options;
  const existingId = await queue.getDeduplicationJobId(deduplicationId);
  const existing = existingId ? await queue.getJob(existingId) : undefined;
  if (!existing) {
    await queue.add(name, data, deduplicatedJobOptions(deduplicationId, priority));
    return;
  }

  const state = await existing.getState();
  if (state === "waiting" || state === "prioritized" || state === "delayed") {
    if (updateExistingData) await existing.updateData(data);
    if (state !== "delayed") await existing.changePriority({ priority });
    return;
  }

  if (state === "active") {
    if (queueIfActive) {
      await queue.add(name, data, deduplicatedJobOptions(deduplicationId, priority));
    }
    return;
  }

  await queue.add(name, data, deduplicatedJobOptions(deduplicationId, priority));
}

export interface WorkerEventLog {
  warn(message: string): void;
  error(message: string, detail?: unknown): void;
}

/** Attaches standard BullMQ observability listeners (`failed`, `stalled`, `lockRenewalFailed`, `error`). */
export function attachWorkerListeners<Data, Result, Name extends string>(
  worker: Worker<Data, Result, Name>,
  log: WorkerEventLog,
): void {
  worker.on("failed", (job, err) => {
    if (job) {
      log.error(`job ${job.id} failed (attempt ${job.attemptsMade}/${job.opts.attempts ?? 1})`, err.message);
    } else {
      log.error("job failed (job record removed)", err.message);
    }
  });
  worker.on("stalled", (jobId, prev) => {
    log.warn(`job ${jobId} stalled (previous state: ${prev})`);
  });
  worker.on("lockRenewalFailed", (jobIds) => {
    log.error(`lock renewal failed for job(s): ${jobIds.join(", ")}`);
  });
  worker.on("error", (err) => log.error("worker error", err));
}

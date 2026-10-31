import { Worker } from "bullmq";
import { prisma } from "@repopulse/db";
import {
  QUEUE_NAMES,
  readBackfillConfig,
  type BackfillConfig,
  type NotificationJobData,
  type Redis,
  type ReleaseBackfillJobData,
  type RepoPollJobData,
  type SchedulerJobData,
} from "@repopulse/queue";
import { startHealthServer, type HealthServer } from "./health";
import { createLogger, errorMessage } from "./logger";
import { processNotification } from "./processors/notification.processor";
import { processReleaseBackfill } from "./processors/release-backfill.processor";
import { processRepoPoll } from "./processors/repo-poll.processor";
import { processSchedulerTick } from "./processors/scheduler.processor";
import { closeQueues, createQueues, pollIntervalCron, registerSchedule, type Queues } from "./queues";
import { createWorkerRedis } from "./redis";

/**
 * RepoPulse worker entrypoint: BullMQ scheduler, repository poller and notification dispatcher,
 * plus the HTTP health server on :3001. SIGTERM (Coolify rollout) / SIGINT drain in-flight jobs
 * before exiting with code 0.
 */

/** Backfill stays a background trickle next to the regular polls. */
const RELEASE_BACKFILL_CONCURRENCY = 2;

// Below docker-compose's `stop_grace_period: 30s`, so we exit before Docker sends SIGKILL.
const SHUTDOWN_TIMEOUT_MS = 25_000;

const log = createLogger("worker");

let healthServer: HealthServer | undefined;
let redis: Redis | undefined;
let queues: Queues | undefined;
let workers: Worker[] = [];
let shuttingDown = false;

function positiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) throw new Error(`Invalid ${name} "${raw}"`);
  return value;
}

async function gracefulShutdown(reason: string, exitCode = 0): Promise<void> {
  if (shuttingDown) {
    log.info(`received ${reason} while already shutting down; ignoring`);
    return;
  }
  shuttingDown = true;
  log.info(`received ${reason}, starting graceful shutdown (timeout ${SHUTDOWN_TIMEOUT_MS}ms)`);

  const forceExit = setTimeout(() => {
    log.error(`graceful shutdown timed out after ${SHUTDOWN_TIMEOUT_MS}ms; forcing exit`);
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  forceExit.unref();

  try {
    // Workers first: close() stops fetching new jobs and waits for active ones (in-flight GitHub
    // polls, DB transactions) to finish while Redis and the database are still connected.
    await Promise.all(workers.map((worker) => worker.close()));
    log.info(`${workers.length} BullMQ workers drained and closed`);
    if (queues) await closeQueues(queues);

    if (healthServer) {
      await healthServer.close();
      log.info("health server closed");
    }

    if (redis) {
      await redis.quit();
      log.info("redis connection closed");
    }

    await prisma.$disconnect();
    log.info("database connection closed");

    clearTimeout(forceExit);
    log.info("graceful shutdown complete");
    process.exit(exitCode);
  } catch (err) {
    log.error("error during shutdown", err);
    clearTimeout(forceExit);
    process.exit(1);
  }
}

process.on("SIGTERM", () => void gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => void gracefulShutdown("SIGINT"));

process.on("unhandledRejection", (reason) => {
  log.error("unhandledRejection", reason);
  void gracefulShutdown("unhandledRejection", 1);
});

process.on("uncaughtException", (err) => {
  log.error("uncaughtException", err);
  // State may be corrupt after an uncaught exception: exit immediately
  // rather than attempting a graceful shutdown.
  process.exit(1);
});

function startWorkers(connection: Redis, q: Queues, backfillConfig: BackfillConfig): Worker[] {
  const schedulerWorker = new Worker<SchedulerJobData>(
    QUEUE_NAMES.scheduler,
    () => processSchedulerTick({ prisma, repoPollQueue: q.repoPollQueue, releaseBackfillQueue: q.releaseBackfillQueue }),
    { connection, concurrency: 1 },
  );

  const repoPollWorker = new Worker<RepoPollJobData>(
    QUEUE_NAMES.repoPoll,
    (job, _token, signal) =>
      processRepoPoll(
        job,
        { prisma, redis: connection, repoPollQueue: q.repoPollQueue, notificationQueue: q.notificationQueue },
        signal,
      ),
    {
      connection,
      concurrency: positiveInt("REPO_POLL_CONCURRENCY", 5),
      // Caps outbound GitHub calls at 10/s. A limiter is also what makes
      // `repoPollQueue.rateLimit()` (on HTTP 403/429) pause the queue at all.
      limiter: { max: 10, duration: 1_000 },
    },
  );

  const notificationWorker = new Worker<NotificationJobData>(
    QUEUE_NAMES.notification,
    (job) => processNotification(job, { prisma }),
    { connection, concurrency: positiveInt("NOTIFICATION_CONCURRENCY", 10) },
  );

  const releaseBackfillWorker = new Worker<ReleaseBackfillJobData>(
    QUEUE_NAMES.releaseBackfill,
    (job, token, signal) => processReleaseBackfill(job, token, { prisma, redis: connection, config: backfillConfig }, signal),
    { connection, concurrency: RELEASE_BACKFILL_CONCURRENCY },
  );

  const all = [schedulerWorker, repoPollWorker, notificationWorker, releaseBackfillWorker];
  for (const worker of all) {
    const queueLog = createLogger(worker.name);
    worker.on("failed", (job, err) => {
      if (job) queueLog.error(`job ${job.id} failed (attempt ${job.attemptsMade}/${job.opts.attempts ?? 1})`, err.message);
    });
    worker.on("error", (err) => queueLog.error("worker error", err));
  }
  return all;
}

async function main(): Promise<void> {
  log.info(`starting (node ${process.version}, NODE_ENV=${process.env.NODE_ENV ?? "undefined"})`);

  healthServer = await startHealthServer();
  log.info(`health server listening on :${healthServer.port} (GET /health)`);

  // Warm up the DB connection; a failure here is reported by /health rather
  // than crash-looping the container.
  try {
    await prisma.$connect();
    log.info("database connection established");
  } catch (err) {
    log.error("initial database connection failed", err instanceof Error ? err.message : err);
  }

  if (!process.env.REDIS_URL) {
    throw new Error("REDIS_URL is not set; the worker cannot start BullMQ without Redis");
  }

  // Fails fast on invalid RELEASE_BACKFILL_* values instead of on the first backfill job.
  const backfillConfig = readBackfillConfig();
  log.info(
    `history backfill: target ${backfillConfig.defaultTarget}, max age ${backfillConfig.maxAgeDays || "unlimited"} days, ` +
      `hard cap ${backfillConfig.hardCap}, min quota ${backfillConfig.minQuota}`,
  );

  redis = createWorkerRedis();
  queues = createQueues(redis);
  workers = startWorkers(redis, queues, backfillConfig);

  const cron = pollIntervalCron();
  await registerSchedule(queues.schedulerQueue, cron);
  log.info(`repo-scheduler registered with cron "${cron}"`);
  log.info("ready");
}

main().catch((err: unknown) => {
  console.error(`[worker] fatal startup error: ${errorMessage(err)}`);
  process.exit(1);
});

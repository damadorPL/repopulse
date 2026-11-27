import { createCachedLoader, loadBackfillOverrides, loadSmtpSettings, prisma } from "@repopulse/db";
import { closeSmtpTransports } from "@repopulse/notifications";
import {
  applyBackfillOverrides,
  attachWorkerListeners,
  QUEUE_NAMES,
  readBackfillConfig,
  type BackfillConfig,
  type JOB_NAMES,
  type NotificationJobData,
  type Redis,
  type ReleaseBackfillJobData,
  type RepoPollJobData,
  type SchedulerJobData,
} from "@repopulse/queue";
import { Worker } from "bullmq";

import { startHealthServer, type HealthServer } from "./health.js";
import { createLogger, errorMessage, log } from "./logger.js";
import { processMaintenanceTick } from "./processors/maintenance.processor.js";
import { processNotification } from "./processors/notification.processor.js";
import { processReleaseBackfill } from "./processors/release-backfill.processor.js";
import { processRepoPoll } from "./processors/repo-poll.processor.js";
import { processSchedulerTick } from "./processors/scheduler.processor.js";
import {
  closeQueues,
  createQueues,
  MAINTENANCE_CRON,
  MAINTENANCE_SCHEDULER_ID,
  pollIntervalCron,
  registerMaintenanceSchedule,
  registerSchedule,
  type Queues,
} from "./queues/index.js";
import { createWorkerRedis } from "./redis.js";

/**
 * RepoPulse worker entrypoint: BullMQ scheduler, repository poller and notification dispatcher,
 * plus the HTTP health server on :3001. SIGTERM (Coolify rollout) / SIGINT drain in-flight jobs
 * before exiting with code 0.
 */

const loadBackfillOverridesCached = createCachedLoader(() => loadBackfillOverrides(prisma));
const loadSmtpSettingsCached = createCachedLoader(() => loadSmtpSettings(prisma));

/**
 * The environment settings with the super admin's overrides (Admin → Release history), cached
 * briefly (15s) so changes apply without a restart while avoiding per-job DB reads.
 */
async function currentBackfillConfig(base: BackfillConfig): Promise<BackfillConfig> {
  try {
    return applyBackfillOverrides(base, await loadBackfillOverridesCached());
  } catch (err) {
    log.warn(`could not read the release history settings, using the environment: ${errorMessage(err)}`);
    return base;
  }
}

/** Backfill stays a background trickle next to the regular polls. */
const RELEASE_BACKFILL_CONCURRENCY = 2;

// Below docker-compose's `stop_grace_period: 30s`, so we exit before Docker sends SIGKILL.
const SHUTDOWN_TIMEOUT_MS = 25_000;

interface ManagedWorker {
  cancelAllJobs(reason?: string): void;
  close(): Promise<void>;
}

let healthServer: HealthServer | undefined;
let redis: Redis | undefined;
let queues: Queues | undefined;
let workers: ManagedWorker[] = [];
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
    // Workers first: cancel active job signals so in-flight fetches abort right away, then
    // close() stops fetching new jobs and waits for them to unwind while Redis and DB stay up.
    for (const worker of workers) worker.cancelAllJobs("shutdown");
    await Promise.all(workers.map((worker) => worker.close()));
    log.info(`${workers.length} BullMQ workers drained and closed`);
    closeSmtpTransports();
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

function registerWorker<D, R, N extends string>(worker: Worker<D, R, N>): ManagedWorker {
  attachWorkerListeners(worker, createLogger(worker.name));
  return worker;
}

function startWorkers(connection: Redis, q: Queues, backfillConfig: BackfillConfig): ManagedWorker[] {
  const schedulerWorker = new Worker<
    SchedulerJobData,
    unknown,
    typeof JOB_NAMES.scan | typeof MAINTENANCE_SCHEDULER_ID
  >(
    QUEUE_NAMES.scheduler,
    (job) =>
      job.name === MAINTENANCE_SCHEDULER_ID
        ? processMaintenanceTick({ prisma })
        : processSchedulerTick({
            prisma,
            repoPollQueue: q.repoPollQueue,
            releaseBackfillQueue: q.releaseBackfillQueue,
          }),
    { connection, concurrency: 1, name: `repopulse-worker:${QUEUE_NAMES.scheduler}` },
  );

  const repoPollWorker = new Worker<RepoPollJobData, unknown, typeof JOB_NAMES.poll>(
    QUEUE_NAMES.repoPoll,
    (job, _token, signal) =>
      processRepoPoll(
        job,
        { prisma, redis: connection, repoPollQueue: q.repoPollQueue, notificationQueue: q.notificationQueue },
        signal,
      ),
    {
      connection,
      name: `repopulse-worker:${QUEUE_NAMES.repoPoll}`,
      concurrency: positiveInt("REPO_POLL_CONCURRENCY", 5),
      // Caps outbound GitHub calls at 10/s. A limiter is also what makes
      // `repoPollQueue.rateLimit()` (on HTTP 403/429) pause the queue at all.
      limiter: { max: 10, duration: 1_000 },
    },
  );

  const notificationWorker = new Worker<NotificationJobData, unknown, typeof JOB_NAMES.notify>(
    QUEUE_NAMES.notification,
    (job, _token, signal) =>
      processNotification(job, { prisma, loadSmtp: loadSmtpSettingsCached, ...(signal ? { signal } : {}) }),
    {
      connection,
      name: `repopulse-worker:${QUEUE_NAMES.notification}`,
      concurrency: positiveInt("NOTIFICATION_CONCURRENCY", 10),
    },
  );

  const releaseBackfillWorker = new Worker<ReleaseBackfillJobData, unknown, typeof JOB_NAMES.backfill>(
    QUEUE_NAMES.releaseBackfill,
    async (job, token, signal) =>
      processReleaseBackfill(
        job,
        token,
        { prisma, redis: connection, config: await currentBackfillConfig(backfillConfig) },
        signal,
      ),
    {
      connection,
      name: `repopulse-worker:${QUEUE_NAMES.releaseBackfill}`,
      concurrency: RELEASE_BACKFILL_CONCURRENCY,
    },
  );

  return [
    registerWorker(schedulerWorker),
    registerWorker(repoPollWorker),
    registerWorker(notificationWorker),
    registerWorker(releaseBackfillWorker),
  ];
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
  const effective = await currentBackfillConfig(backfillConfig);
  log.info(
    `history backfill: target ${effective.defaultTarget}, max age ${effective.maxAgeDays || "unlimited"} days, ` +
      `hard cap ${effective.hardCap}, min quota ${effective.minQuota} (environment + Admin → Release history)`,
  );

  redis = createWorkerRedis();
  queues = createQueues(redis);
  workers = startWorkers(redis, queues, backfillConfig);

  const cron = pollIntervalCron();
  await registerSchedule(queues.schedulerQueue, cron);
  log.info(`repo-scheduler registered with cron "${cron}"`);
  await registerMaintenanceSchedule(queues.schedulerQueue);
  log.info(`db-maintenance registered with cron "${MAINTENANCE_CRON}"`);
  log.info("ready");
}

main().catch((err: unknown) => {
  log.error("fatal startup error", err);
  process.exit(1);
});

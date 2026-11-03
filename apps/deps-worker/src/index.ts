import { Worker } from "bullmq";
import { loadGitHubAppSettings, prisma } from "@repopulse/db";
import { fetchRegistryPackage } from "@repopulse/deps";
import {
  DEPS_QUEUE_NAMES,
  type DepsNotifyJobData,
  type DepsScanJobData,
  type DepsSchedulerJobData,
  type DepsUpdateJobData,
  type Redis,
} from "@repopulse/queue";
import type { RegistryLookupFn } from "./analysis";
import { readConfig } from "./config";
import { GitHubAccess } from "./github-access";
import { startHealthServer, type HealthServer } from "./health";
import { startHeartbeat } from "./heartbeat";
import { createLogger, errorMessage } from "./logger";
import { startNotificationOutbox } from "./notification-outbox";
import { processDepsNotify } from "./processors/deps-notify.processor";
import { processDepsScan } from "./processors/deps-scan.processor";
import { processDepsSchedulerTick } from "./processors/deps-scheduler.processor";
import { processDepsUpdate } from "./processors/deps-update.processor";
import { closeQueues, createQueues, registerSchedule, type DepsQueues } from "./queues";
import { createWorkerRedis } from "./redis";
import { createRedisBlobCache, createRedisLockfileCache, createRedisRegistryCache } from "./registry-cache";
import { createSandboxClient } from "./sandbox-client";

/**
 * RepoPulse deps-worker (Slice 08): dependency scans, update pull requests and dependency notifications, plus the
 * HTTP health server on :3002 and a Redis heartbeat every 30 s. SIGTERM / SIGINT drain in-flight jobs before
 * exiting with code 0. Nothing is processed while Admin → Dependencies is off.
 */

const DEPS_NOTIFY_CONCURRENCY = 5;
// Below docker-compose's `stop_grace_period: 30s`, so we exit before Docker sends SIGKILL.
const SHUTDOWN_TIMEOUT_MS = 25_000;

const log = createLogger("deps-worker");

let healthServer: HealthServer | undefined;
let redis: Redis | undefined;
let queues: DepsQueues | undefined;
let workers: Worker[] = [];
let stopHeartbeat: (() => void) | undefined;
let stopNotificationOutbox: (() => Promise<void>) | undefined;
let shuttingDown = false;

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
    stopHeartbeat?.();
    await Promise.all(workers.map((worker) => worker.close()));
    await stopNotificationOutbox?.();
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
  process.exit(1);
});

async function main(): Promise<void> {
  log.info(`starting (node ${process.version}, NODE_ENV=${process.env.NODE_ENV ?? "undefined"})`);
  const config = readConfig();

  healthServer = await startHealthServer();
  log.info(`health server listening on :${healthServer.port} (GET /health)`);

  try {
    await prisma.$connect();
    log.info("database connection established");
  } catch (err) {
    log.error("initial database connection failed", err instanceof Error ? err.message : err);
  }

  if (!process.env.REDIS_URL) throw new Error("REDIS_URL is not set; the deps-worker cannot start BullMQ without Redis");
  redis = createWorkerRedis();
  const connection = redis;
  queues = createQueues(connection);
  const q = queues;

  // Health is unauthenticated: probe it even without a token, so Admin → Dependencies can show reachability.
  const sandboxProbe = createSandboxClient({ baseUrl: config.sandboxUrl, token: config.sandboxToken ?? "" });
  const sandbox = config.sandboxToken ? sandboxProbe : null;
  if (!sandbox) log.warn("DEPS_SANDBOX_TOKEN is not set: update pull requests that need a regenerated lockfile are refused");

  const access = new GitHubAccess({ loadApp: () => loadGitHubAppSettings(prisma) });
  const registryCache = createRedisRegistryCache(connection);
  const blobCache = createRedisBlobCache(connection);
  const lockCache = createRedisLockfileCache(connection);
  const registry: RegistryLookupFn = (ecosystem, name, signal) =>
    fetchRegistryPackage(ecosystem, name, { fetch, cache: registryCache, ...(signal ? { signal } : {}) });
  // Updates revalidate every registry entry (ETag), so a PR never sets a version the policy rejects now.
  const freshRegistry: RegistryLookupFn = (ecosystem, name, signal) =>
    fetchRegistryPackage(ecosystem, name, { fetch, cache: registryCache, ttlMs: 0, ...(signal ? { signal } : {}) });

  const schedulerWorker = new Worker<DepsSchedulerJobData>(
    DEPS_QUEUE_NAMES.scheduler,
    () => processDepsSchedulerTick({ prisma, scanQueue: q.scanQueue }),
    { connection, concurrency: 1 },
  );
  const scanWorker = new Worker<DepsScanJobData>(
    DEPS_QUEUE_NAMES.scan,
    (job, _token, signal) =>
      processDepsScan(
        job,
        {
          prisma,
          redis: connection,
          scanQueue: q.scanQueue,
          updateQueue: q.updateQueue,
          notifyQueue: q.notifyQueue,
          access,
          registry,
          blobCache,
          lockCache,
          lockfileRegeneration: sandbox !== null,
        },
        signal,
      ),
    // A limiter is what makes `scanQueue.rateLimit()` (GitHub rate limits) pause the queue.
    { connection, concurrency: config.scanConcurrency, limiter: { max: 10, duration: 1_000 } },
  );
  const updateWorker = new Worker<DepsUpdateJobData>(
    DEPS_QUEUE_NAMES.update,
    (job, _token, signal) =>
      processDepsUpdate(
        job,
        {
          prisma,
          redis: connection,
          updateQueue: q.updateQueue,
          notifyQueue: q.notifyQueue,
          access,
          registry: freshRegistry,
          blobCache,
          lockCache,
          sandbox,
        },
        signal,
      ),
    { connection, concurrency: config.updateConcurrency, limiter: { max: 5, duration: 1_000 } },
  );
  const notifyWorker = new Worker<DepsNotifyJobData>(
    DEPS_QUEUE_NAMES.notify,
    (job, _token, signal) => processDepsNotify(job, { prisma, ...(signal ? { signal } : {}) }),
    { connection, concurrency: DEPS_NOTIFY_CONCURRENCY },
  );

  workers = [schedulerWorker, scanWorker, updateWorker, notifyWorker];
  for (const worker of workers) {
    const queueLog = createLogger(worker.name);
    worker.on("failed", (job, err) => {
      if (job) queueLog.error(`job ${job.id} failed (attempt ${job.attemptsMade}/${job.opts.attempts ?? 1})`, err.message);
    });
    worker.on("error", (err) => queueLog.error("worker error", err));
  }

  stopHeartbeat = startHeartbeat(connection, sandboxProbe);
  stopNotificationOutbox = startNotificationOutbox(prisma, q.notifyQueue);
  await registerSchedule(q.schedulerQueue, config.scanCron);
  log.info(
    `deps-scheduler registered with cron "${config.scanCron}"; scan concurrency ${config.scanConcurrency}, ` +
      `update concurrency ${config.updateConcurrency}, sandbox ${config.sandboxUrl}`,
  );
  log.info("ready");
}

main().catch((err: unknown) => {
  console.error(`[deps-worker] fatal startup error: ${errorMessage(err)}`);
  process.exit(1);
});

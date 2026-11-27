import { Worker } from "bullmq";
import { createCachedLoader, loadDepsEnabled, loadGitHubAppSettings, loadSmtpSettings, prisma } from "@repopulse/db";
import { fetchRegistryPackage } from "@repopulse/deps";
import { closeSmtpTransports } from "@repopulse/notifications";
import {
  attachWorkerListeners,
  DEPS_QUEUE_NAMES,
  type DEPS_JOB_NAMES,
  type DepsNotifyJobData,
  type DepsScanJobData,
  type DepsSchedulerJobData,
  type DepsUpdateJobData,
  type Redis,
} from "@repopulse/queue";
import type { RegistryLookupFn } from "./analysis.js";
import { readConfig } from "./config.js";
import { GitHubAccess } from "./github-access.js";
import { startHealthServer, type HealthServer } from "./health.js";
import { startHeartbeat } from "./heartbeat.js";
import { createLogger, log } from "./logger.js";
import { startNotificationOutbox } from "./notification-outbox.js";
import { processDepsNotify } from "./processors/deps-notify.processor.js";
import { processDepsScan } from "./processors/deps-scan.processor.js";
import { processDepsSchedulerTick } from "./processors/deps-scheduler.processor.js";
import { processDepsUpdate } from "./processors/deps-update.processor.js";
import { closeQueues, createQueues, registerSchedule, type DepsQueues } from "./queues.js";
import { createWorkerRedis } from "./redis.js";
import {
  createRedisBlobCache,
  createRedisLockfileCache,
  createRedisRegistryCache,
  createRedisTreeCache,
} from "./registry-cache.js";
import { createSandboxClient } from "./sandbox-client.js";

/**
 * RepoPulse deps-worker (Slice 08): dependency scans, update pull requests and dependency notifications, plus the
 * HTTP health server on :3002 and a Redis heartbeat every 30 s. SIGTERM / SIGINT drain in-flight jobs before
 * exiting with code 0. Nothing is processed while Admin → Dependencies is off.
 */

const DEPS_NOTIFY_CONCURRENCY = 5;
const LONG_RUNNING_LOCK_DURATION_MS = 120_000;
// Below docker-compose's `stop_grace_period: 30s`, so we exit before Docker sends SIGKILL.
const SHUTDOWN_TIMEOUT_MS = 25_000;

interface ManagedWorker {
  cancelAllJobs(reason?: string): void;
  close(): Promise<void>;
}

let healthServer: HealthServer | undefined;
let redis: Redis | undefined;
let queues: DepsQueues | undefined;
let workers: ManagedWorker[] = [];
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
    await stopNotificationOutbox?.();
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

  if (!process.env.REDIS_URL)
    throw new Error("REDIS_URL is not set; the deps-worker cannot start BullMQ without Redis");
  redis = createWorkerRedis();
  const connection = redis;
  queues = createQueues(connection);
  const q = queues;

  // Health is unauthenticated: probe it even without a token, so Admin → Dependencies can show reachability.
  const sandboxProbe = createSandboxClient({ baseUrl: config.sandboxUrl, token: config.sandboxToken ?? "" });
  const sandbox = config.sandboxToken ? sandboxProbe : null;
  if (!sandbox)
    log.warn("DEPS_SANDBOX_TOKEN is not set: update pull requests that need a regenerated lockfile are refused");

  const loadDepsEnabledCached = createCachedLoader(() => loadDepsEnabled(prisma));
  const loadGitHubAppSettingsCached = createCachedLoader(() => loadGitHubAppSettings(prisma));
  const loadSmtpSettingsCached = createCachedLoader(() => loadSmtpSettings(prisma));

  const access = new GitHubAccess({ loadApp: loadGitHubAppSettingsCached });
  const registryCache = createRedisRegistryCache(connection);
  const blobCache = createRedisBlobCache(connection);
  const lockCache = createRedisLockfileCache(connection);
  const treeCache = createRedisTreeCache(connection);
  const registry: RegistryLookupFn = (ecosystem, name, signal) =>
    fetchRegistryPackage(ecosystem, name, { fetch, cache: registryCache, ...(signal ? { signal } : {}) });
  // Updates revalidate every registry entry (ETag), so a PR never sets a version the policy rejects now.
  const freshRegistry: RegistryLookupFn = (ecosystem, name, signal) =>
    fetchRegistryPackage(ecosystem, name, { fetch, cache: registryCache, ttlMs: 0, ...(signal ? { signal } : {}) });

  const schedulerWorker = new Worker<DepsSchedulerJobData, unknown, typeof DEPS_JOB_NAMES.schedule>(
    DEPS_QUEUE_NAMES.scheduler,
    () => processDepsSchedulerTick({ prisma, scanQueue: q.scanQueue, loadDepsEnabled: loadDepsEnabledCached }),
    { connection, concurrency: 1, name: `repopulse-deps-worker:${DEPS_QUEUE_NAMES.scheduler}` },
  );
  const scanWorker = new Worker<DepsScanJobData, unknown, typeof DEPS_JOB_NAMES.scan>(
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
          treeCache,
          loadDepsEnabled: loadDepsEnabledCached,
          lockfileRegeneration: sandbox !== null,
        },
        signal,
      ),
    // A limiter is what makes `scanQueue.rateLimit()` (GitHub rate limits) pause the queue.
    {
      connection,
      name: `repopulse-deps-worker:${DEPS_QUEUE_NAMES.scan}`,
      concurrency: config.scanConcurrency,
      lockDuration: LONG_RUNNING_LOCK_DURATION_MS,
      limiter: { max: 10, duration: 1_000 },
    },
  );
  const updateWorker = new Worker<DepsUpdateJobData, unknown, typeof DEPS_JOB_NAMES.update>(
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
          treeCache,
          loadDepsEnabled: loadDepsEnabledCached,
          sandbox,
        },
        signal,
      ),
    {
      connection,
      name: `repopulse-deps-worker:${DEPS_QUEUE_NAMES.update}`,
      concurrency: config.updateConcurrency,
      lockDuration: LONG_RUNNING_LOCK_DURATION_MS,
      limiter: { max: 5, duration: 1_000 },
    },
  );
  const notifyWorker = new Worker<DepsNotifyJobData, unknown, typeof DEPS_JOB_NAMES.notify>(
    DEPS_QUEUE_NAMES.notify,
    (job, _token, signal) =>
      processDepsNotify(job, {
        prisma,
        loadDepsEnabled: loadDepsEnabledCached,
        loadSmtp: loadSmtpSettingsCached,
        ...(signal ? { signal } : {}),
      }),
    {
      connection,
      name: `repopulse-deps-worker:${DEPS_QUEUE_NAMES.notify}`,
      concurrency: DEPS_NOTIFY_CONCURRENCY,
    },
  );

  const register = <D, R, N extends string>(worker: Worker<D, R, N>): ManagedWorker => {
    attachWorkerListeners(worker, createLogger(worker.name));
    return worker;
  };
  workers = [register(schedulerWorker), register(scanWorker), register(updateWorker), register(notifyWorker)];

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
  log.error("fatal startup error", err);
  process.exit(1);
});

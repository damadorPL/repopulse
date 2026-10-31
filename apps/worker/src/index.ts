import { prisma } from "@repopulse/db";
import { startHealthServer, type HealthServer } from "./health";

/**
 * RepoPulse worker entrypoint.
 *
 * Slice 01: healthcheck stub only (HTTP :3001/health) with graceful shutdown.
 * Slice 04 will register BullMQ queues/workers here.
 */

const SHUTDOWN_TIMEOUT_MS = 10_000;

let healthServer: HealthServer | undefined;
let shuttingDown = false;

function log(message: string): void {
  console.log(`[worker] ${message}`);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? (err.stack ?? err.message) : String(err);
}

async function shutdown(reason: string, exitCode = 0): Promise<void> {
  if (shuttingDown) {
    log(`received ${reason} while already shutting down; ignoring`);
    return;
  }
  shuttingDown = true;
  log(`received ${reason}, starting graceful shutdown (timeout ${SHUTDOWN_TIMEOUT_MS}ms)`);

  const forceExit = setTimeout(() => {
    console.error(`[worker] graceful shutdown timed out after ${SHUTDOWN_TIMEOUT_MS}ms; forcing exit`);
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  forceExit.unref();

  try {
    // ------------------------------------------------------------------
    // TODO(slice-04): close BullMQ workers/queues FIRST so in-flight GitHub
    // fetches and notifications finish before the DB connection goes away:
    //   await Promise.all(workers.map((worker) => worker.close()));
    //   await Promise.all(queues.map((queue) => queue.close()));
    // ------------------------------------------------------------------

    if (healthServer) {
      await healthServer.close();
      log("health server closed");
    }

    await prisma.$disconnect();
    log("database connection closed");

    clearTimeout(forceExit);
    log("graceful shutdown complete");
    process.exit(exitCode);
  } catch (err) {
    console.error(`[worker] error during shutdown: ${errorMessage(err)}`);
    clearTimeout(forceExit);
    process.exit(1);
  }
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

process.on("unhandledRejection", (reason) => {
  console.error(`[worker] unhandledRejection: ${errorMessage(reason)}`);
  void shutdown("unhandledRejection", 1);
});

process.on("uncaughtException", (err) => {
  console.error(`[worker] uncaughtException: ${errorMessage(err)}`);
  // State may be corrupt after an uncaught exception: exit immediately
  // rather than attempting a graceful shutdown.
  process.exit(1);
});

async function main(): Promise<void> {
  log(`starting (node ${process.version}, NODE_ENV=${process.env.NODE_ENV ?? "undefined"})`);

  healthServer = await startHealthServer();
  log(`health server listening on :${healthServer.port} (GET /health)`);

  // Warm up the DB connection; a failure here is reported by /health rather
  // than crash-looping the container.
  try {
    await prisma.$connect();
    log("database connection established");
  } catch (err) {
    console.error(
      `[worker] initial database connection failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!process.env.REDIS_URL) {
    log("REDIS_URL not set; redis health check will report 'skipped'");
  }

  // TODO(slice-04): start BullMQ repo-poll scheduler and notification workers here.
  log("ready");
}

main().catch((err: unknown) => {
  console.error(`[worker] fatal startup error: ${errorMessage(err)}`);
  process.exit(1);
});

import { Queue } from "bullmq";
import {
  createRedisConnection,
  publishUserEvent,
  QUEUE_NAMES,
  RELEASE_BACKFILL_JOB_OPTIONS,
  REPO_POLL_JOB_OPTIONS,
  type RealtimeEvent,
  type Redis,
  type ReleaseBackfillJobData,
  type RepoPollJobData,
} from "@repopulse/queue";

/**
 * Server-side Redis access for apps/web: the `repo-poll` producer used by "Sync now", the
 * `release-backfill` producer ("Add repository", "Load older releases"), Pub/Sub
 * publishing, and per-request subscribers for the SSE stream.
 *
 * Never import from client components.
 */

/** Upper bound for a single Redis round trip from a request handler. */
const REDIS_REQUEST_TIMEOUT_MS = 5_000;

export class RealtimeUnavailableError extends Error {
  constructor(message = "Background sync is unavailable right now. Please try again later.") {
    super(message);
    this.name = "RealtimeUnavailableError";
  }
}

export function isRealtimeConfigured(): boolean {
  return Boolean(process.env.REDIS_URL);
}

// Cached on globalThis: Next.js dev HMR re-evaluates modules and would leak connections.
const globalForRealtime = globalThis as unknown as {
  repopulseRedis?: Redis;
  repopulseRepoPollQueue?: Queue<RepoPollJobData>;
  repopulseReleaseBackfillQueue?: Queue<ReleaseBackfillJobData>;
};

/**
 * Shared command connection. Unlike the worker, requests must fail fast when Redis is down
 * instead of queueing forever, so `maxRetriesPerRequest` is finite here.
 */
function getRedis(): Redis {
  if (!isRealtimeConfigured()) throw new RealtimeUnavailableError("Background sync is not configured (REDIS_URL is not set).");
  if (!globalForRealtime.repopulseRedis) {
    const redis = createRedisConnection({ connectionName: "repopulse-web", maxRetriesPerRequest: 1, connectTimeout: 5_000 });
    redis.on("error", (err) => console.error(`[realtime] redis error: ${err.message}`));
    globalForRealtime.repopulseRedis = redis;
  }
  return globalForRealtime.repopulseRedis;
}

export function getRepoPollQueue(): Queue<RepoPollJobData> {
  globalForRealtime.repopulseRepoPollQueue ??= new Queue<RepoPollJobData>(QUEUE_NAMES.repoPoll, {
    connection: getRedis(),
    defaultJobOptions: REPO_POLL_JOB_OPTIONS,
  });
  return globalForRealtime.repopulseRepoPollQueue;
}

export function getReleaseBackfillQueue(): Queue<ReleaseBackfillJobData> {
  globalForRealtime.repopulseReleaseBackfillQueue ??= new Queue<ReleaseBackfillJobData>(QUEUE_NAMES.releaseBackfill, {
    connection: getRedis(),
    defaultJobOptions: RELEASE_BACKFILL_JOB_OPTIONS,
  });
  return globalForRealtime.repopulseReleaseBackfillQueue;
}

/** Rejects with {@link RealtimeUnavailableError} if Redis does not answer in time. */
export async function withRedisTimeout<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new RealtimeUnavailableError()), REDIS_REQUEST_TIMEOUT_MS);
  });
  try {
    return await Promise.race([operation, timeout]);
  } catch (error) {
    if (error instanceof RealtimeUnavailableError) throw error;
    console.error("[realtime] redis operation failed", error);
    throw new RealtimeUnavailableError();
  } finally {
    clearTimeout(timer);
  }
}

/** Best-effort publish to `user:{userId}:events`; a missed live update is not an error. */
export async function publishToUser(userId: string, event: RealtimeEvent): Promise<void> {
  try {
    await withRedisTimeout(publishUserEvent(getRedis(), userId, event));
  } catch (error) {
    console.warn(`[realtime] could not publish ${event.type} to user ${userId}`, error);
  }
}

/**
 * A dedicated connection for one SSE stream. A connection in subscriber mode can't run other
 * commands, so it can't be shared; ioredis re-subscribes on its own after a reconnect.
 */
export function createSubscriber(): Redis {
  if (!isRealtimeConfigured()) throw new RealtimeUnavailableError("Live updates are not configured (REDIS_URL is not set).");
  return createRedisConnection({ connectionName: "repopulse-web-sse", connectTimeout: 5_000 });
}

import {
  createRedisConnection,
  createReleaseBackfillQueue,
  createRepoPollQueue,
  publishUserEvent,
  userEventsChannel,
  type RealtimeEvent,
  type Redis,
  type ReleaseBackfillQueue,
  type RepoPollQueue,
} from "@repopulse/queue";

/**
 * Server-side Redis access for apps/web: the `repo-poll` producer used by "Sync now", the
 * `release-backfill` producer ("Add repository", "Load older releases"), Pub/Sub
 * publishing, and a process-wide multiplexed ref-counted subscriber for SSE streams.
 *
 * Never import from client components.
 */

/** Upper bound for a single Redis round trip from a request handler. */
const REDIS_REQUEST_TIMEOUT_MS = 5_000;

export type UserEventListener = (raw: string) => void;

interface SubscriberState {
  redis: Redis;
  channels: Map<string, Set<UserEventListener>>;
  pendingSubscribes: Map<string, Promise<unknown>>;
}

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
declare global {
  var repopulseRedis: Redis | undefined;
  var repopulseRepoPollQueue: RepoPollQueue | undefined;
  var repopulseReleaseBackfillQueue: ReleaseBackfillQueue | undefined;
  var repopulseSubscriberState: SubscriberState | undefined;
}

const globalForRealtime = globalThis;

/**
 * Shared command connection. Unlike the worker, requests must fail fast when Redis is down
 * instead of queueing or buffering offline commands, so `maxRetriesPerRequest: 1` and
 * `enableOfflineQueue: false` are set here.
 */
export function getRedis(): Redis {
  if (!isRealtimeConfigured())
    throw new RealtimeUnavailableError("Background sync is not configured (REDIS_URL is not set).");
  if (!globalForRealtime.repopulseRedis) {
    const redis = createRedisConnection({
      connectionName: "repopulse-web",
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      connectTimeout: 5_000,
    });
    redis.on("error", (err) => console.error(`[realtime] redis error: ${err.message}`));
    globalForRealtime.repopulseRedis = redis;
  }
  return globalForRealtime.repopulseRedis;
}

export function getRepoPollQueue(): RepoPollQueue {
  globalForRealtime.repopulseRepoPollQueue ??= createRepoPollQueue(getRedis(), (err) =>
    console.error(`[realtime] repo-poll queue error: ${err.message}`),
  );
  return globalForRealtime.repopulseRepoPollQueue;
}

export function getReleaseBackfillQueue(): ReleaseBackfillQueue {
  globalForRealtime.repopulseReleaseBackfillQueue ??= createReleaseBackfillQueue(getRedis(), (err) =>
    console.error(`[realtime] release-backfill queue error: ${err.message}`),
  );
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

function getSubscriberState(): SubscriberState {
  if (!isRealtimeConfigured()) {
    throw new RealtimeUnavailableError("Live updates are not configured (REDIS_URL is not set).");
  }
  if (!globalForRealtime.repopulseSubscriberState) {
    const redis = createRedisConnection({ connectionName: "repopulse-web-sse", connectTimeout: 5_000 });
    const channels = new Map<string, Set<UserEventListener>>();
    const pendingSubscribes = new Map<string, Promise<unknown>>();

    redis.on("error", (err: Error) => console.error(`[sse] redis subscriber error: ${err.message}`));
    redis.on("message", (channel: string, raw: string) => {
      const listeners = channels.get(channel);
      if (!listeners) return;
      for (const listener of Array.from(listeners)) {
        try {
          listener(raw);
        } catch (err) {
          console.error("[sse] user event listener threw", err);
        }
      }
    });
    redis.on("ready", () => {
      if (channels.size === 0) return;
      void redis.subscribe(...channels.keys()).catch((err: unknown) => {
        console.error("[sse] could not re-subscribe active channels after reconnect", err);
      });
    });

    globalForRealtime.repopulseSubscriberState = { redis, channels, pendingSubscribes };
  }
  return globalForRealtime.repopulseSubscriberState;
}

/**
 * Subscribes a listener to `user:{userId}:events` over a single process-wide multiplexed Redis
 * subscriber connection. Reference-counts channels (`0 -> 1` subscribes, `1 -> 0` unsubscribes)
 * and returns an idempotent async `unsubscribe` callback.
 */
export async function subscribeUserEvents(userId: string, listener: UserEventListener): Promise<() => Promise<void>> {
  const state = getSubscriberState();
  const channel = userEventsChannel(userId);
  let listeners = state.channels.get(channel);
  if (!listeners) {
    listeners = new Set();
    state.channels.set(channel, listeners);
  }
  const wasEmpty = listeners.size === 0;
  listeners.add(listener);

  if (wasEmpty) {
    const pending = state.redis.subscribe(channel);
    state.pendingSubscribes.set(channel, pending);
    try {
      await pending;
    } catch (error) {
      listeners.delete(listener);
      if (listeners.size === 0) state.channels.delete(channel);
      throw error;
    } finally {
      if (state.pendingSubscribes.get(channel) === pending) {
        state.pendingSubscribes.delete(channel);
      }
    }
  } else {
    const pending = state.pendingSubscribes.get(channel);
    if (pending) {
      try {
        await pending;
      } catch (error) {
        listeners.delete(listener);
        if (listeners.size === 0) state.channels.delete(channel);
        throw error;
      }
    }
  }

  let removed = false;
  return async () => {
    if (removed) return;
    removed = true;
    const current = state.channels.get(channel);
    if (!current) return;
    current.delete(listener);
    if (current.size > 0) return;
    state.channels.delete(channel);
    try {
      await state.redis.unsubscribe(channel);
    } catch (err) {
      console.warn(`[sse] could not unsubscribe ${channel}`, err);
    }
  };
}

import { Redis, type RedisOptions } from "ioredis";
import { serializeRealtimeEvent, userEventsChannel, type RealtimeEvent } from "./events.js";

export { Redis, type RedisOptions };

/**
 * ioredis connection for BullMQ. `maxRetriesPerRequest: null` is required for workers: their
 * blocking commands must wait out a Redis restart instead of failing. Producers that should fail
 * fast (web requests) override it.
 */
export function createRedisConnection(options: RedisOptions & { url?: string } = {}): Redis {
  const { url = process.env.REDIS_URL, ...rest } = options;
  if (!url) {
    throw new Error("REDIS_URL is not set");
  }
  return new Redis(url, { maxRetriesPerRequest: null, ...rest });
}

/** Publishes an event to `user:{userId}:events`. Resolves to the number of live subscribers. */
export function publishUserEvent(
  redis: Pick<Redis, "publish">,
  userId: string,
  event: RealtimeEvent,
): Promise<number> {
  return redis.publish(userEventsChannel(userId), serializeRealtimeEvent(event));
}

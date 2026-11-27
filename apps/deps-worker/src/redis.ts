import { createRedisConnection, type Redis } from "@repopulse/queue";
import { createLogger } from "./logger.js";

const log = createLogger("redis");

/**
 * The deps-worker's shared ioredis connection: BullMQ queues and workers (workers duplicate it for their blocking
 * connection), Pub/Sub events, the heartbeat and the registry / blob caches.
 */
export function createWorkerRedis(): Redis {
  const redis = createRedisConnection({ connectionName: "repopulse-deps-worker" });
  redis.on("error", (err) => log.error("connection error", err.message));
  redis.on("reconnecting", (delayMs: number) => log.warn(`reconnecting in ${delayMs}ms`));
  redis.on("ready", () => log.info("connection ready"));
  return redis;
}

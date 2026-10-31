import { createRedisConnection, type Redis } from "@repopulse/queue";
import { createLogger } from "./logger";

const log = createLogger("redis");

/**
 * The worker's shared ioredis connection: BullMQ queues and workers use it (workers duplicate
 * it for their blocking connection) and processors publish Pub/Sub events on it.
 *
 * `maxRetriesPerRequest: null` (set by `createRedisConnection`) is required by BullMQ workers.
 */
export function createWorkerRedis(): Redis {
  const redis = createRedisConnection({ connectionName: "repopulse-worker" });
  redis.on("error", (err) => log.error("connection error", err.message));
  redis.on("ready", () => log.info("connection ready"));
  return redis;
}

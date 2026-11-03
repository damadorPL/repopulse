import {
  DEPS_WORKER_HEARTBEAT_INTERVAL_MS,
  DEPS_WORKER_HEARTBEAT_KEY,
  DEPS_WORKER_HEARTBEAT_TTL_SECONDS,
  type DepsWorkerHeartbeat,
} from "@repopulse/deps";
import type { Redis } from "@repopulse/queue";
import { createLogger } from "./logger";
import type { SandboxClient } from "./sandbox-client";

const log = createLogger("heartbeat");

/** One heartbeat: the sandbox's `GET /health` (`null` when unreachable or not configured) under a 90 s TTL. */
export async function writeHeartbeat(
  redis: Pick<Redis, "set">,
  sandbox: Pick<SandboxClient, "health"> | null,
  now: () => Date = () => new Date(),
): Promise<DepsWorkerHeartbeat> {
  const health = sandbox ? await sandbox.health() : null;
  const payload: DepsWorkerHeartbeat = { at: now().toISOString(), sandbox: health ? { status: "ok", tools: health.tools } : null };
  await redis.set(DEPS_WORKER_HEARTBEAT_KEY, JSON.stringify(payload), "EX", DEPS_WORKER_HEARTBEAT_TTL_SECONDS);
  return payload;
}

/** Writes the heartbeat now and every 30 s; returns a stop function. Failures are logged, never thrown. */
export function startHeartbeat(redis: Pick<Redis, "set">, sandbox: Pick<SandboxClient, "health"> | null): () => void {
  const beat = () =>
    writeHeartbeat(redis, sandbox).catch((error: unknown) => log.warn(`could not write the heartbeat: ${error instanceof Error ? error.message : String(error)}`));
  void beat();
  const timer = setInterval(beat, DEPS_WORKER_HEARTBEAT_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}

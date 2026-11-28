import { prisma } from "@repopulse/db";
import {
  resolveHealthPort as resolvePort,
  startHealthServer as startSharedHealthServer,
  type HealthServer,
} from "@repopulse/queue";

export type { HealthServer };

const DEFAULT_HEALTH_PORT = 3002;

const pingDb = () => prisma.$queryRaw`SELECT 1`;

export function resolveHealthPort(): number {
  return resolvePort("DEPS_HEALTH_PORT", DEFAULT_HEALTH_PORT);
}

export function startHealthServer(port = resolveHealthPort()): Promise<HealthServer> {
  return startSharedHealthServer({ pingDb, port });
}

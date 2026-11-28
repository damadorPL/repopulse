import { prisma } from "@repopulse/db";
import {
  checkDatabase as checkDatabaseWithPing,
  getHealthReport as getHealthReportWithPing,
  resolveHealthPort as resolvePort,
  startHealthServer as startSharedHealthServer,
  type CheckResult,
  type HealthReport,
  type HealthServer,
} from "@repopulse/queue";

/** @internal Exported for health unit tests. */
export type { CheckResult, HealthReport };
export type { HealthServer };

const DEFAULT_HEALTH_PORT = 3001;

const pingDb = () => prisma.$queryRaw`SELECT 1`;

/** @internal Exported for health unit tests. */
export function checkDatabase(): Promise<CheckResult> {
  return checkDatabaseWithPing(pingDb);
}

/** @internal Exported for health unit tests. */
export function getHealthReport(): Promise<HealthReport> {
  return getHealthReportWithPing(pingDb);
}

export function resolveHealthPort(): number {
  return resolvePort("HEALTH_PORT", DEFAULT_HEALTH_PORT);
}

export function startHealthServer(port = resolveHealthPort()): Promise<HealthServer> {
  return startSharedHealthServer({ pingDb, port });
}

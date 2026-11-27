import { prisma } from "@repopulse/db";
import {
  checkDatabase as checkDatabaseWithPing,
  checkRedis,
  getHealthReport as getHealthReportWithPing,
  pingRedis,
  resolveHealthPort as resolvePort,
  startHealthServer as startSharedHealthServer,
  type CheckResult,
  type HealthReport,
  type HealthServer,
} from "@repopulse/queue";

export { checkRedis, pingRedis, type CheckResult, type HealthReport, type HealthServer };

const DEFAULT_HEALTH_PORT = 3001;

const pingDb = () => prisma.$queryRaw`SELECT 1`;

export function checkDatabase(): Promise<CheckResult> {
  return checkDatabaseWithPing(pingDb);
}

export function getHealthReport(): Promise<HealthReport> {
  return getHealthReportWithPing(pingDb);
}

export function resolveHealthPort(): number {
  return resolvePort("HEALTH_PORT", DEFAULT_HEALTH_PORT);
}

export function startHealthServer(port = resolveHealthPort()): Promise<HealthServer> {
  return startSharedHealthServer({ pingDb, port });
}

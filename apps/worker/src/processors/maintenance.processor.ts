import type { PrismaClient } from "@repopulse/db";
import { QUEUE_NAMES } from "@repopulse/queue";
import { createLogger } from "../logger.js";

const log = createLogger("db-maintenance");

const DAY_MS = 24 * 60 * 60 * 1000;

export const MAINTENANCE_BATCH_SIZE = 5_000;
export const MAINTENANCE_MAX_BATCHES = 20;
export const INVITE_RETENTION_DAYS = 30;
export const BRANCH_WRITE_INTENT_RETENTION_DAYS = 7;
export const READ_STATE_RETENTION_DAYS = 90;

export interface MaintenanceDeps {
  prisma: Pick<PrismaClient, "$executeRaw">;
  now?: () => Date;
}

export interface MaintenanceResult {
  sessions: number;
  verifications: number;
  invites: number;
  branchWriteIntents: number;
  releaseStates: number;
}

async function deleteInBatches(table: string, deleteBatch: () => Promise<number>): Promise<number> {
  let total = 0;
  for (let batch = 0; batch < MAINTENANCE_MAX_BATCHES; batch += 1) {
    const deleted = await deleteBatch();
    total += deleted;
    if (deleted < MAINTENANCE_BATCH_SIZE) break;
  }
  if (total > 0) {
    log.info({ queue: QUEUE_NAMES.scheduler, table, deleted: total }, `pruned ${total} ${table} row(s)`);
  }
  return total;
}

/**
 * Daily data-lifecycle maintenance job: prunes expired auth tokens, stale branch-write intents,
 * and old read `UserReleaseState` rows in bounded `ctid` batches to avoid long table locks.
 *
 * `COMMIT` release states are never deleted because commit visibility depends on state row presence.
 */
export async function processMaintenanceTick(deps: MaintenanceDeps): Promise<MaintenanceResult> {
  const now = deps.now?.() ?? new Date();
  const inviteCutoff = new Date(now.getTime() - INVITE_RETENTION_DAYS * DAY_MS);
  const intentCutoff = new Date(now.getTime() - BRANCH_WRITE_INTENT_RETENTION_DAYS * DAY_MS);
  const readCutoff = new Date(now.getTime() - READ_STATE_RETENTION_DAYS * DAY_MS);

  const sessions = await deleteInBatches(
    "Session",
    () =>
      deps.prisma.$executeRaw`
      DELETE FROM "Session"
      WHERE ctid IN (
        SELECT ctid FROM "Session"
        WHERE "expiresAt" < ${now}
        LIMIT ${MAINTENANCE_BATCH_SIZE}
      )
    `,
  );

  const verifications = await deleteInBatches(
    "Verification",
    () =>
      deps.prisma.$executeRaw`
      DELETE FROM "Verification"
      WHERE ctid IN (
        SELECT ctid FROM "Verification"
        WHERE "expiresAt" < ${now}
        LIMIT ${MAINTENANCE_BATCH_SIZE}
      )
    `,
  );

  const invites = await deleteInBatches(
    "Invite",
    () =>
      deps.prisma.$executeRaw`
      DELETE FROM "Invite"
      WHERE ctid IN (
        SELECT ctid FROM "Invite"
        WHERE "usedAt" IS NULL AND "expiresAt" < ${inviteCutoff}
        LIMIT ${MAINTENANCE_BATCH_SIZE}
      )
    `,
  );

  const branchWriteIntents = await deleteInBatches(
    "DependencyBranchWriteIntent",
    () =>
      deps.prisma.$executeRaw`
      DELETE FROM "DependencyBranchWriteIntent"
      WHERE ctid IN (
        SELECT ctid FROM "DependencyBranchWriteIntent"
        WHERE "createdAt" < ${intentCutoff}
        LIMIT ${MAINTENANCE_BATCH_SIZE}
      )
    `,
  );

  // Never delete COMMIT UserReleaseState rows: commit feed visibility requires a state row.
  const releaseStates = await deleteInBatches(
    "UserReleaseState",
    () =>
      deps.prisma.$executeRaw`
      DELETE FROM "UserReleaseState"
      WHERE ctid IN (
        SELECT urs.ctid FROM "UserReleaseState" urs
        JOIN "Release" r ON r."id" = urs."releaseId"
        WHERE urs."isRead" = true
          AND urs."readAt" < ${readCutoff}
          AND r."source" <> 'COMMIT'::"ReleaseSource"
        LIMIT ${MAINTENANCE_BATCH_SIZE}
      )
    `,
  );

  const result: MaintenanceResult = {
    sessions,
    verifications,
    invites,
    branchWriteIntents,
    releaseStates,
  };
  log.info({ queue: QUEUE_NAMES.scheduler, ...result }, "daily database maintenance complete");
  return result;
}

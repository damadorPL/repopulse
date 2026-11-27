import { loadDepsEnabled, type Prisma, type PrismaClient } from "@repopulse/db";
import {
  deduplicatedJobOptions,
  DEPS_JOB_NAMES,
  DEPS_QUEUE_NAMES,
  DEPS_SCAN_PRIORITY,
  depsScanJobId,
  type DepsScanQueue,
} from "@repopulse/queue";

import { createLogger } from "../logger.js";

const log = createLogger("deps-scheduler");

/** A `SCANNING` project this old belongs to a worker that died mid-scan; scan it again. */
export const STALE_SCANNING_MS = 15 * 60_000;
export const SCHEDULER_BATCH_SIZE = 200;

/**
 * Due non-scanning projects (`DependencyProject_due_nextScanAt_id_idx`): `nextScanAt` reached or never set.
 * Paused projects (404 five times) simply have a `nextScanAt` far in the future.
 */
export function dueNonScanningProjectsWhere(now: Date): Prisma.DependencyProjectWhereInput {
  return {
    scanStatus: { not: "SCANNING" },
    OR: [{ nextScanAt: null }, { nextScanAt: { lte: now } }],
  };
}

/**
 * Stale `SCANNING` projects (`DependencyProject_scanning_updatedAt_idx`): belongs to a worker that died mid-scan.
 */
export function dueStaleScanningProjectsWhere(now: Date): Prisma.DependencyProjectWhereInput {
  return {
    scanStatus: "SCANNING",
    updatedAt: { lt: new Date(now.getTime() - STALE_SCANNING_MS) },
    OR: [{ nextScanAt: null }, { nextScanAt: { lte: now } }],
  };
}

export interface DepsSchedulerDeps {
  prisma: PrismaClient;
  scanQueue: Pick<DepsScanQueue, "addBulk">;
  loadDepsEnabled?: () => Promise<boolean>;
  now?: () => Date;
}

export type DepsSchedulerOutcome = { status: "DISABLED" } | { status: "OK"; due: number };

async function enqueueDuePass(
  deps: DepsSchedulerDeps,
  where: Prisma.DependencyProjectWhereInput,
  orderBy: Prisma.DependencyProjectOrderByWithRelationInput[],
  seen: Set<string>,
): Promise<number> {
  let enqueued = 0;
  let cursor: string | undefined;
  for (;;) {
    const batch = await deps.prisma.dependencyProject.findMany({
      where,
      select: { id: true },
      orderBy,
      take: SCHEDULER_BATCH_SIZE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    if (batch.length === 0) break;
    const fresh = batch.filter((project) => {
      if (seen.has(project.id)) return false;
      seen.add(project.id);
      return true;
    });
    if (fresh.length > 0) {
      await deps.scanQueue.addBulk(
        fresh.map((project) => ({
          name: DEPS_JOB_NAMES.scan,
          data: { projectId: project.id, trigger: "schedule" as const },
          opts: deduplicatedJobOptions(depsScanJobId(project.id), DEPS_SCAN_PRIORITY.schedule),
        })),
      );
      enqueued += fresh.length;
    }
    if (batch.length < SCHEDULER_BATCH_SIZE) break;
    cursor = batch.at(-1)!.id;
  }
  return enqueued;
}

/**
 * `deps-scheduler` tick: one `deps-scan` per due project across two indexed passes (non-scanning due, then stale
 * `SCANNING`), in batches of {@link SCHEDULER_BATCH_SIZE}. BullMQ's deduplication (`deps-scan-{projectId}`,
 * `keepLastIfActive: true`) prevents stacking scans when a scan is already queued or active. Nothing happens while
 * the module is disabled (Admin → Dependencies).
 */
export async function processDepsSchedulerTick(deps: DepsSchedulerDeps): Promise<DepsSchedulerOutcome> {
  const enabled = deps.loadDepsEnabled ? await deps.loadDepsEnabled() : await loadDepsEnabled(deps.prisma);
  if (!enabled) {
    log.info(
      { queue: DEPS_QUEUE_NAMES.scheduler },
      "dependency checks are disabled (Admin → Dependencies); nothing scheduled",
    );
    return { status: "DISABLED" };
  }
  const now = deps.now?.() ?? new Date();
  const seen = new Set<string>();
  const due =
    (await enqueueDuePass(
      deps,
      dueNonScanningProjectsWhere(now),
      [{ nextScanAt: { sort: "asc", nulls: "first" } }, { id: "asc" }],
      seen,
    )) + (await enqueueDuePass(deps, dueStaleScanningProjectsWhere(now), [{ updatedAt: "asc" }, { id: "asc" }], seen));
  log.info(
    { queue: DEPS_QUEUE_NAMES.scheduler, due },
    `${due} due dependency ${due === 1 ? "project" : "projects"} enqueued`,
  );
  return { status: "OK", due };
}

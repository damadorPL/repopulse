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
 * Due projects: `nextScanAt` reached (or never set: a lost first scan) and not being scanned, unless that scan is
 * stale. Paused projects (404 five times) simply have a `nextScanAt` far in the future.
 */
export function dueProjectsWhere(now: Date): Prisma.DependencyProjectWhereInput {
  return {
    AND: [
      { OR: [{ nextScanAt: null }, { nextScanAt: { lte: now } }] },
      {
        OR: [
          { scanStatus: { not: "SCANNING" } },
          { scanStatus: "SCANNING", updatedAt: { lt: new Date(now.getTime() - STALE_SCANNING_MS) } },
        ],
      },
    ],
  };
}

export interface DepsSchedulerDeps {
  prisma: PrismaClient;
  scanQueue: Pick<DepsScanQueue, "addBulk">;
  now?: () => Date;
}

export type DepsSchedulerOutcome = { status: "DISABLED" } | { status: "OK"; due: number };

/**
 * `deps-scheduler` tick: one `deps-scan` per due project, in batches of {@link SCHEDULER_BATCH_SIZE}.
 * BullMQ's deduplication (`deps-scan-{projectId}`, `keepLastIfActive: true`) prevents stacking
 * scans when a scan is already queued or active. Nothing happens while the module is disabled
 * (Admin → Dependencies).
 */
export async function processDepsSchedulerTick(deps: DepsSchedulerDeps): Promise<DepsSchedulerOutcome> {
  if (!(await loadDepsEnabled(deps.prisma))) {
    log.info(
      { queue: DEPS_QUEUE_NAMES.scheduler },
      "dependency checks are disabled (Admin → Dependencies); nothing scheduled",
    );
    return { status: "DISABLED" };
  }
  const now = deps.now?.() ?? new Date();
  let due = 0;
  let cursor: string | undefined;
  for (;;) {
    const batch = await deps.prisma.dependencyProject.findMany({
      where: dueProjectsWhere(now),
      select: { id: true },
      orderBy: { id: "asc" },
      take: SCHEDULER_BATCH_SIZE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    if (batch.length === 0) break;
    await deps.scanQueue.addBulk(
      batch.map((project) => ({
        name: DEPS_JOB_NAMES.scan,
        data: { projectId: project.id, trigger: "schedule" as const },
        opts: deduplicatedJobOptions(depsScanJobId(project.id), DEPS_SCAN_PRIORITY.schedule),
      })),
    );
    due += batch.length;
    if (batch.length < SCHEDULER_BATCH_SIZE) break;
    cursor = batch[batch.length - 1]!.id;
  }
  log.info(
    { queue: DEPS_QUEUE_NAMES.scheduler, due },
    `${due} due dependency ${due === 1 ? "project" : "projects"} enqueued`,
  );
  return { status: "OK", due };
}

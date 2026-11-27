import { loadDepsEnabled, type PrismaClient } from "@repopulse/db";
import { DEPS_JOB_NAMES, depsNotifyJobId, type DepsNotifyJobData } from "@repopulse/queue";
import { createLogger } from "./logger.js";
import type { NotifyQueue } from "./processors/notify-jobs.js";

const log = createLogger("deps-notification-outbox");
type OutboxClient = Pick<PrismaClient, "dependencyNotificationOutbox">;

export const OUTBOX_BATCH_SIZE = 100;
export const MAX_FLUSH_BATCHES = 20;

const PR_EVENTS = new Set(["opened", "updated", "edited", "access_lost"]);

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** Strict runtime validation matching `DepsNotifyJobData` so one corrupt row never blocks the outbox. */
export function parseDepsNotifyJobData(payload: unknown): DepsNotifyJobData | null {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
  const obj = payload as Record<string, unknown>;
  if (!isNonEmptyString(obj.ruleId) || !isNonEmptyString(obj.projectId)) return null;

  if (obj.kind === "digest") {
    if (
      !isNonEmptyString(obj.scanId) ||
      !Array.isArray(obj.updateIds) ||
      !obj.updateIds.every((id) => isNonEmptyString(id))
    ) {
      return null;
    }
    return {
      ruleId: obj.ruleId,
      projectId: obj.projectId,
      kind: "digest",
      scanId: obj.scanId,
      updateIds: [...obj.updateIds],
    };
  }

  if (obj.kind === "pull_request") {
    if (
      !isNonEmptyString(obj.prId) ||
      typeof obj.event !== "string" ||
      !PR_EVENTS.has(obj.event) ||
      !isNonEmptyString(obj.dedupKey)
    ) {
      return null;
    }
    return {
      ruleId: obj.ruleId,
      projectId: obj.projectId,
      kind: "pull_request",
      prId: obj.prId,
      event: obj.event as Extract<DepsNotifyJobData, { kind: "pull_request" }>["event"],
      dedupKey: obj.dedupKey,
    };
  }

  return null;
}

let inFlightFlush: Promise<number> | null = null;

/** Call inside the transaction that records the event, before marking its updates notified. */
export async function storeNotificationIntents(prisma: OutboxClient, jobs: DepsNotifyJobData[]): Promise<void> {
  if (jobs.length === 0) return;
  await prisma.dependencyNotificationOutbox.createMany({
    data: jobs.map((data) => ({ id: depsNotifyJobId(data), projectId: data.projectId, payload: data as never })),
    skipDuplicates: true,
  });
}

async function drainNotificationOutbox(prisma: OutboxClient, queue: NotifyQueue): Promise<number> {
  let totalFlushed = 0;
  for (let batch = 0; batch < MAX_FLUSH_BATCHES; batch++) {
    const rows = await prisma.dependencyNotificationOutbox.findMany({
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: OUTBOX_BATCH_SIZE,
      select: { id: true, payload: true },
    });
    if (rows.length === 0) break;

    const validJobs: Array<{ name: typeof DEPS_JOB_NAMES.notify; data: DepsNotifyJobData; opts: { jobId: string } }> =
      [];
    const validIds: string[] = [];
    const corruptIds: string[] = [];
    for (const row of rows) {
      const parsed = parseDepsNotifyJobData(row.payload);
      if (!parsed) {
        corruptIds.push(row.id);
        continue;
      }
      validJobs.push({ name: DEPS_JOB_NAMES.notify, data: parsed, opts: { jobId: row.id } });
      validIds.push(row.id);
    }

    if (corruptIds.length > 0) {
      log.error(
        { corruptIds, count: corruptIds.length },
        `deleting ${corruptIds.length} corrupt notification outbox row(s)`,
      );
      await prisma.dependencyNotificationOutbox.deleteMany({ where: { id: { in: corruptIds } } });
    }

    if (validJobs.length > 0) {
      await queue.addBulk(validJobs);
      await prisma.dependencyNotificationOutbox.deleteMany({ where: { id: { in: validIds } } });
      totalFlushed += validJobs.length;
    }

    if (rows.length < OUTBOX_BATCH_SIZE) break;
  }
  return totalFlushed;
}

/**
 * Drains durable outbox intents in batches up to {@link MAX_FLUSH_BATCHES} with an in-process single-flight guard
 * so concurrent scans and the periodic recovery timer never flush overlapping batches.
 */
export function flushNotificationOutbox(prisma: OutboxClient, queue: NotifyQueue): Promise<number> {
  if (inFlightFlush) return inFlightFlush;
  inFlightFlush = drainNotificationOutbox(prisma, queue).finally(() => {
    inFlightFlush = null;
  });
  return inFlightFlush;
}

/** Periodic recovery is independent of scans, including after a worker restart. */
export function startNotificationOutbox(
  prisma: PrismaClient,
  queue: NotifyQueue,
  loadEnabled: () => Promise<boolean> = () => loadDepsEnabled(prisma),
): () => Promise<void> {
  let stopped = false;
  let running: Promise<void> | undefined;
  const tick = () => {
    if (stopped || running) return;
    running = (async () => {
      if (await loadEnabled()) await flushNotificationOutbox(prisma, queue);
    })()
      .catch((error: unknown) => {
        log.error("could not flush notification intents; retrying on the next tick", error);
      })
      .finally(() => {
        running = undefined;
      });
  };
  const timer = setInterval(tick, 5_000);
  timer.unref();
  tick();
  return async () => {
    stopped = true;
    clearInterval(timer);
    await running;
  };
}

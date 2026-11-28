import { loadDepsEnabled, type Prisma, type PrismaClient } from "@repopulse/db";
import { DEPS_JOB_NAMES, depsNotifyJobId, type DepsNotifyJobData } from "@repopulse/queue";

import { createLogger } from "./logger.js";
import type { NotifyQueue } from "./processors/notify-jobs.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const log = createLogger("deps-notification-outbox");
type OutboxClient = Pick<PrismaClient, "dependencyNotificationOutbox">;

export const OUTBOX_BATCH_SIZE = 100;
export const MAX_FLUSH_BATCHES = 20;

type PrNotificationEvent = Extract<DepsNotifyJobData, { kind: "pull_request" }>["event"];

function parsePrEvent(value: unknown): PrNotificationEvent | null {
  switch (value) {
    case "opened":
    case "updated":
    case "edited":
    case "access_lost":
      return value;
    default:
      return null;
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** Strict runtime validation matching `DepsNotifyJobData` so one corrupt row never blocks the outbox. */
function parseDepsNotifyJobData(payload: unknown): DepsNotifyJobData | null {
  if (!isRecord(payload)) return null;
  if (!isNonEmptyString(payload.ruleId) || !isNonEmptyString(payload.projectId)) return null;

  if (payload.kind === "digest") {
    if (
      !isNonEmptyString(payload.scanId) ||
      !Array.isArray(payload.updateIds) ||
      !payload.updateIds.every((id) => isNonEmptyString(id))
    ) {
      return null;
    }
    return {
      ruleId: payload.ruleId,
      projectId: payload.projectId,
      kind: "digest",
      scanId: payload.scanId,
      updateIds: [...payload.updateIds],
    };
  }

  if (payload.kind === "pull_request") {
    const event = parsePrEvent(payload.event);
    if (!isNonEmptyString(payload.prId) || event === null || !isNonEmptyString(payload.dedupKey)) {
      return null;
    }
    return {
      ruleId: payload.ruleId,
      projectId: payload.projectId,
      kind: "pull_request",
      prId: payload.prId,
      event,
      dedupKey: payload.dedupKey,
    };
  }

  return null;
}

function toOutboxJsonPayload(data: DepsNotifyJobData): Prisma.InputJsonObject {
  if (data.kind === "digest") {
    return {
      ruleId: data.ruleId,
      projectId: data.projectId,
      kind: "digest",
      scanId: data.scanId,
      updateIds: [...data.updateIds],
    };
  }
  return {
    ruleId: data.ruleId,
    projectId: data.projectId,
    kind: "pull_request",
    prId: data.prId,
    event: data.event,
    dedupKey: data.dedupKey,
  };
}

let inFlightFlush: Promise<number> | null = null;

/** Call inside the transaction that records the event, before marking its updates notified. */
export async function storeNotificationIntents(prisma: OutboxClient, jobs: DepsNotifyJobData[]): Promise<void> {
  if (jobs.length === 0) return;
  await prisma.dependencyNotificationOutbox.createMany({
    data: jobs.map((data) => ({
      id: depsNotifyJobId(data),
      projectId: data.projectId,
      payload: toOutboxJsonPayload(data),
    })),
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

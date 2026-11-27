import { loadDepsEnabled, type PrismaClient } from "@repopulse/db";
import { DEPS_JOB_NAMES, depsNotifyJobId, type DepsNotifyJobData } from "@repopulse/queue";
import { createLogger } from "./logger.js";
import type { NotifyQueue } from "./processors/notify-jobs.js";

const log = createLogger("deps-notification-outbox");
type OutboxClient = Pick<PrismaClient, "dependencyNotificationOutbox">;

/** Call inside the transaction that records the event, before marking its updates notified. */
export async function storeNotificationIntents(prisma: OutboxClient, jobs: DepsNotifyJobData[]): Promise<void> {
  if (jobs.length === 0) return;
  await prisma.dependencyNotificationOutbox.createMany({
    data: jobs.map((data) => ({ id: depsNotifyJobId(data), projectId: data.projectId, payload: data as never })),
    skipDuplicates: true,
  });
}

/** A crash after enqueue is safe: retries use the same retained BullMQ job id. */
export async function flushNotificationOutbox(prisma: OutboxClient, queue: NotifyQueue): Promise<number> {
  const rows = await prisma.dependencyNotificationOutbox.findMany({
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: 100,
    select: { id: true, payload: true },
  });
  if (rows.length === 0) return 0;
  await queue.addBulk(
    rows.map((row) => ({
      name: DEPS_JOB_NAMES.notify,
      data: row.payload as unknown as DepsNotifyJobData,
      opts: { jobId: row.id },
    })),
  );
  await prisma.dependencyNotificationOutbox.deleteMany({ where: { id: { in: rows.map((row) => row.id) } } });
  return rows.length;
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

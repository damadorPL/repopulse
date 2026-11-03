import { afterEach, describe, expect, it, vi } from "vitest";
import { depsNotifyJobId, type DepsNotifyJobData } from "@repopulse/queue";
import { flushNotificationOutbox, startNotificationOutbox, storeNotificationIntents } from "./notification-outbox";
import { createFakePrisma, seed } from "./testing/fake-prisma";

const data: DepsNotifyJobData = { projectId: "p1", ruleId: "r1", kind: "digest", scanId: "scan1", updateIds: ["update1"] };
const setup = () => {
  const prisma = createFakePrisma();
  seed(prisma);
  const queue = { addBulk: vi.fn(async (_jobs: unknown[]) => []) };
  return { db: prisma as never, prisma, queue };
};

afterEach(() => vi.useRealTimers());

describe("dependency notification outbox", () => {
  it("retains a durable intent on Redis failure and enqueues it on recovery", async () => {
    const { db, prisma, queue } = setup();
    await storeNotificationIntents(db, [data]);
    queue.addBulk.mockRejectedValueOnce(new Error("Redis unavailable"));
    await expect(flushNotificationOutbox(db, queue)).rejects.toThrow("Redis unavailable");
    expect(prisma.dependencyNotificationOutbox.rows).toHaveLength(1);
    expect(await flushNotificationOutbox(db, queue)).toBe(1);
    expect(queue.addBulk).toHaveBeenLastCalledWith([expect.objectContaining({ data, opts: { jobId: depsNotifyJobId(data) } })]);
    expect(prisma.dependencyNotificationOutbox.rows).toHaveLength(0);
  });

  it("reuses the same job id if the process failed after enqueue but before acknowledgement", async () => {
    const { db, prisma, queue } = setup();
    await storeNotificationIntents(db, [data, data]);
    expect(prisma.dependencyNotificationOutbox.rows).toHaveLength(1);
    const remove = vi.spyOn(prisma.dependencyNotificationOutbox, "deleteMany");
    remove.mockRejectedValueOnce(new Error("Database unavailable"));
    await expect(flushNotificationOutbox(db, queue)).rejects.toThrow("Database unavailable");
    await flushNotificationOutbox(db, queue);
    expect(queue.addBulk.mock.calls[0]).toEqual(queue.addBulk.mock.calls[1]);
    expect(prisma.dependencyNotificationOutbox.rows).toHaveLength(0);
  });

  it("recovers persisted work after startup without another scan and stops cleanly", async () => {
    vi.useFakeTimers();
    const { db, prisma, queue } = setup();
    await storeNotificationIntents(db, [data]);
    queue.addBulk.mockRejectedValueOnce(new Error("Redis unavailable"));
    const stop = startNotificationOutbox(db, queue);
    await vi.advanceTimersByTimeAsync(0);
    expect(prisma.dependencyNotificationOutbox.rows).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(prisma.dependencyNotificationOutbox.rows).toHaveLength(0);
    await stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(queue.addBulk).toHaveBeenCalledTimes(2);
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";

import { depsNotifyJobId, type DepsNotifyJobData } from "@repopulse/queue";

import {
  flushNotificationOutbox,
  MAX_FLUSH_BATCHES,
  OUTBOX_BATCH_SIZE,
  startNotificationOutbox,
  storeNotificationIntents,
} from "./notification-outbox.js";
import { createFakePrisma, seed } from "./testing/fake-prisma.js";

const data: DepsNotifyJobData = {
  projectId: "p1",
  ruleId: "r1",
  kind: "digest",
  scanId: "scan1",
  updateIds: ["update1"],
};
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
    await expect(flushNotificationOutbox(db, queue)).resolves.toBe(1);
    expect(queue.addBulk).toHaveBeenLastCalledWith([
      expect.objectContaining({ data, opts: { jobId: depsNotifyJobId(data) } }),
    ]);
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

  it("serializes concurrent flush calls with a single-flight guard", async () => {
    const { db, prisma, queue } = setup();
    await storeNotificationIntents(db, [data]);
    let releaseAddBulk!: () => void;
    queue.addBulk.mockImplementationOnce(
      () =>
        new Promise<never[]>((resolve) => {
          releaseAddBulk = () => resolve([]);
        }),
    );

    const first = flushNotificationOutbox(db, queue);
    const second = flushNotificationOutbox(db, queue);
    await vi.waitFor(() => expect(queue.addBulk).toHaveBeenCalledTimes(1));
    releaseAddBulk();
    const [count1, count2] = await Promise.all([first, second]);
    expect(count1).toBe(1);
    expect(count2).toBe(1);
    expect(queue.addBulk).toHaveBeenCalledTimes(1);
    expect(prisma.dependencyNotificationOutbox.rows).toHaveLength(0);
  });

  it("drains multiple batches up to MAX_FLUSH_BATCHES", async () => {
    const { db, prisma, queue } = setup();
    const total = MAX_FLUSH_BATCHES * OUTBOX_BATCH_SIZE + 5;
    for (let i = 0; i < total; i++) {
      prisma.dependencyNotificationOutbox.rows.push({
        id: `job-${String(i).padStart(4, "0")}`,
        projectId: "p1",
        createdAt: new Date(1_700_000_000_000 + i),
        payload: { ...data, scanId: `scan-${i}` },
      });
    }

    const flushed = await flushNotificationOutbox(db, queue);
    expect(flushed).toBe(MAX_FLUSH_BATCHES * OUTBOX_BATCH_SIZE);
    expect(queue.addBulk).toHaveBeenCalledTimes(MAX_FLUSH_BATCHES);
    expect(prisma.dependencyNotificationOutbox.rows).toHaveLength(5);

    await expect(flushNotificationOutbox(db, queue)).resolves.toBe(5);
    expect(prisma.dependencyNotificationOutbox.rows).toHaveLength(0);
  });

  it("deletes corrupt rows without blocking valid digest or pull_request payloads", async () => {
    const { db, prisma, queue } = setup();
    const prPayload: DepsNotifyJobData = {
      ruleId: "r2",
      projectId: "p1",
      kind: "pull_request",
      prId: "pr1",
      event: "opened",
      dedupKey: "sha-1",
    };
    prisma.dependencyNotificationOutbox.rows.push(
      { id: "bad-1", projectId: "p1", createdAt: new Date(1), payload: { kind: "unknown" } },
      { id: "bad-2", projectId: "p1", createdAt: new Date(2), payload: { kind: "pull_request", event: "bogus" } },
      { id: "good-1", projectId: "p1", createdAt: new Date(3), payload: data },
      { id: "good-2", projectId: "p1", createdAt: new Date(4), payload: prPayload },
    );

    await expect(flushNotificationOutbox(db, queue)).resolves.toBe(2);
    expect(queue.addBulk).toHaveBeenCalledWith([
      { name: "dispatch-dependency-notification", data, opts: { jobId: "good-1" } },
      { name: "dispatch-dependency-notification", data: prPayload, opts: { jobId: "good-2" } },
    ]);
    expect(prisma.dependencyNotificationOutbox.rows).toHaveLength(0);
  });
});

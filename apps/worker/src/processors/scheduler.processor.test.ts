import { describe, expect, it, vi } from "vitest";

import {
  BACKFILL_SWEEP_BATCH,
  backfillSweepWhere,
  ENQUEUE_BATCH_SIZE,
  processSchedulerTick,
} from "./scheduler.processor.js";

function fakePrisma(due: string[], pendingBackfills: Array<{ id: string; backfillStatus: string }>) {
  return {
    repository: {
      findMany: vi.fn(
        async (args: { where: unknown; take?: number; skip?: number; cursor?: { id: string }; orderBy?: unknown }) => {
          if (args.where === undefined || JSON.stringify(args.where) === JSON.stringify(backfillSweepWhere())) {
            return pendingBackfills;
          }
          let items = due.map((id) => ({ id }));
          if (args.cursor) {
            const idx = items.findIndex((item) => item.id === args.cursor!.id);
            items = idx === -1 ? [] : items.slice(idx + (args.skip ?? 0));
          } else if (args.skip) {
            items = items.slice(args.skip);
          }
          if (args.take !== undefined) items = items.slice(0, args.take);
          return items;
        },
      ),
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
  };
}

describe("processSchedulerTick backfill sweep", () => {
  it("queues never-backfilled repositories and re-asserts in-flight ones", async () => {
    const prisma = fakePrisma(
      ["p1"],
      [
        { id: "a", backfillStatus: "NONE" },
        { id: "b", backfillStatus: "RUNNING" },
      ],
    );
    const repoPollQueue = { addBulk: vi.fn(async (_jobs: unknown[]) => []) };
    const releaseBackfillQueue = { addBulk: vi.fn(async () => []) };

    const result = await processSchedulerTick({ prisma: prisma as never, repoPollQueue, releaseBackfillQueue });

    expect(result).toEqual({ due: 1, backfills: 1 });
    expect(releaseBackfillQueue.addBulk).toHaveBeenCalledWith([
      {
        name: "backfill-releases",
        data: { repositoryId: "a", trigger: "sweep" },
        opts: { deduplication: { id: "backfill-a", keepLastIfActive: true }, priority: 10 },
      },
      {
        name: "backfill-releases",
        data: { repositoryId: "b", trigger: "sweep" },
        opts: { deduplication: { id: "backfill-b", keepLastIfActive: true }, priority: 10 },
      },
    ]);
    // Only NONE rows move to QUEUED.
    expect(prisma.repository.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["a"] }, backfillStatus: "NONE" },
      data: { backfillStatus: "QUEUED" },
    });
    expect(prisma.repository.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: BACKFILL_SWEEP_BATCH }));
  });

  it("re-asserts QUEUED and RUNNING backfills without calling updateMany when no NONE rows exist", async () => {
    const prisma = fakePrisma(
      [],
      [
        { id: "q1", backfillStatus: "QUEUED" },
        { id: "r1", backfillStatus: "RUNNING" },
      ],
    );
    const repoPollQueue = { addBulk: vi.fn(async (_jobs: unknown[]) => []) };
    const releaseBackfillQueue = { addBulk: vi.fn(async () => []) };

    const result = await processSchedulerTick({ prisma: prisma as never, repoPollQueue, releaseBackfillQueue });

    expect(result).toEqual({ due: 0, backfills: 0 });
    expect(repoPollQueue.addBulk).not.toHaveBeenCalled();
    expect(releaseBackfillQueue.addBulk).toHaveBeenCalledTimes(1);
    expect(prisma.repository.updateMany).not.toHaveBeenCalled();
  });

  it("enqueues > 500 due repositories via keyset cursor pagination in batches of 500", async () => {
    const dueIds = Array.from({ length: 505 }, (_, i) => `repo-${i + 1}`);
    const prisma = fakePrisma(dueIds, []);
    const repoPollQueue = { addBulk: vi.fn(async (_jobs: unknown[]) => []) };
    const releaseBackfillQueue = { addBulk: vi.fn(async () => []) };

    const result = await processSchedulerTick({ prisma: prisma as never, repoPollQueue, releaseBackfillQueue });

    expect(result).toEqual({ due: 505, backfills: 0 });
    expect(repoPollQueue.addBulk).toHaveBeenCalledTimes(2);
    expect(repoPollQueue.addBulk.mock.calls[0]![0]).toHaveLength(ENQUEUE_BATCH_SIZE);
    expect(repoPollQueue.addBulk.mock.calls[1]![0]).toHaveLength(5);
    expect(prisma.repository.findMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        take: ENQUEUE_BATCH_SIZE,
        orderBy: [{ lastPolledAt: { sort: "asc", nulls: "first" } }, { id: "asc" }],
      }),
    );
    expect(prisma.repository.findMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        take: ENQUEUE_BATCH_SIZE,
        cursor: { id: "repo-500" },
        skip: 1,
        orderBy: [{ lastPolledAt: { sort: "asc", nulls: "first" } }, { id: "asc" }],
      }),
    );
    expect(releaseBackfillQueue.addBulk).not.toHaveBeenCalled();
  });

  it("stops cleanly when due repositories are an exact multiple of ENQUEUE_BATCH_SIZE", async () => {
    const dueIds = Array.from({ length: ENQUEUE_BATCH_SIZE }, (_, i) => `repo-${i + 1}`);
    const prisma = fakePrisma(dueIds, []);
    const repoPollQueue = { addBulk: vi.fn(async (_jobs: unknown[]) => []) };
    const releaseBackfillQueue = { addBulk: vi.fn(async () => []) };

    const result = await processSchedulerTick({ prisma: prisma as never, repoPollQueue, releaseBackfillQueue });

    expect(result).toEqual({ due: ENQUEUE_BATCH_SIZE, backfills: 0 });
    expect(repoPollQueue.addBulk).toHaveBeenCalledTimes(1);
    expect(prisma.repository.findMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ cursor: { id: `repo-${ENQUEUE_BATCH_SIZE}` }, skip: 1 }),
    );
  });

  it("does not fail the poll tick when the backfill sweep fails", async () => {
    const prisma = fakePrisma(["p1"], [{ id: "a", backfillStatus: "NONE" }]);
    const releaseBackfillQueue = {
      addBulk: vi.fn(async () => {
        throw new Error("redis down");
      }),
    };
    const repoPollQueue = { addBulk: vi.fn(async (_jobs: unknown[]) => []) };

    await expect(
      processSchedulerTick({ prisma: prisma as never, repoPollQueue, releaseBackfillQueue }),
    ).resolves.toEqual({
      due: 1,
      backfills: 0,
    });
    expect(repoPollQueue.addBulk).toHaveBeenCalledOnce();
  });

  it("only sweeps subscribed repositories whose history is not imported yet", () => {
    expect(backfillSweepWhere()).toEqual({
      subscriptions: { some: {} },
      backfillStatus: { in: ["NONE", "QUEUED", "RUNNING"] },
    });
  });
});

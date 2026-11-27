import { describe, expect, it, vi } from "vitest";
import { createFakePrisma, PROJECT_DEFAULTS } from "../testing/fake-prisma.js";
import { NOW } from "../testing/fixtures.js";
import { processDepsSchedulerTick, SCHEDULER_BATCH_SIZE, STALE_SCANNING_MS } from "./deps-scheduler.processor.js";

function setup(depsEnabled = true) {
  const prisma = createFakePrisma();
  prisma.instanceSettings.rows.push({ id: 1, depsEnabled });
  const project = (id: string, data: Record<string, unknown>) =>
    prisma.dependencyProject.rows.push({ ...PROJECT_DEFAULTS, id, updatedAt: NOW, ...data });
  const scanQueue = {
    addBulk: vi.fn(
      async (
        _jobs: Array<{
          data: { projectId: string };
          opts?: { deduplication?: { id: string; keepLastIfActive?: boolean }; priority?: number };
        }>,
      ) => [],
    ),
  };
  return { prisma, project, scanQueue, deps: { prisma: prisma as never, scanQueue, now: () => NOW } };
}

const queued = (scanQueue: ReturnType<typeof setup>["scanQueue"]) =>
  scanQueue.addBulk.mock.calls.flatMap(([jobs]) => jobs.map((j) => j.data.projectId)).sort();

describe("processDepsSchedulerTick", () => {
  it("does nothing while the module is disabled", async () => {
    const { deps, project, scanQueue } = setup(false);
    project("p1", { nextScanAt: null });
    expect(await processDepsSchedulerTick(deps)).toEqual({ status: "DISABLED" });
    expect(scanQueue.addBulk).not.toHaveBeenCalled();
  });

  it("enqueues due projects only", async () => {
    const { deps, project, scanQueue } = setup();
    project("due", { nextScanAt: new Date(NOW.getTime() - 1) });
    project("never", { nextScanAt: null, scanStatus: "QUEUED" });
    project("errored", { nextScanAt: new Date(NOW.getTime() - 1), scanStatus: "ERROR" });
    project("later", { nextScanAt: new Date(NOW.getTime() + 60_000) });
    project("scanning", {
      nextScanAt: new Date(NOW.getTime() - 1),
      scanStatus: "SCANNING",
      updatedAt: new Date(NOW.getTime() - 60_000),
    });
    project("stale", {
      nextScanAt: new Date(NOW.getTime() - 1),
      scanStatus: "SCANNING",
      updatedAt: new Date(NOW.getTime() - STALE_SCANNING_MS - 1),
    });

    expect(await processDepsSchedulerTick(deps)).toEqual({ status: "OK", due: 4 });
    expect(queued(scanQueue)).toEqual(["due", "errored", "never", "stale"]);
    const [first] = scanQueue.addBulk.mock.calls[0]![0];
    expect(first!.opts).toEqual({
      deduplication: { id: expect.stringMatching(/^deps-scan-/), keepLastIfActive: true },
      priority: 10,
    });
  });

  it("works through large sets in batches and orders nulls first for non-scanning projects", async () => {
    const { deps, project, scanQueue } = setup();
    for (let i = 0; i < SCHEDULER_BATCH_SIZE + 5; i++) {
      project(`p${String(i).padStart(4, "0")}`, {
        nextScanAt: i < 5 ? new Date(NOW.getTime() - (10 - i) * 1000) : null,
      });
    }
    expect(await processDepsSchedulerTick(deps)).toEqual({ status: "OK", due: SCHEDULER_BATCH_SIZE + 5 });
    expect(scanQueue.addBulk).toHaveBeenCalledTimes(2);
    expect(new Set(queued(scanQueue)).size).toBe(SCHEDULER_BATCH_SIZE + 5);
    const firstBatchIds = scanQueue.addBulk.mock.calls[0]![0].map((j) => j.data.projectId);
    expect(firstBatchIds.slice(0, 5)).toEqual(["p0005", "p0006", "p0007", "p0008", "p0009"]);
  });

  it("deduplicates projects returned by both non-scanning and stale-scanning passes", async () => {
    const { deps, prisma, scanQueue } = setup();
    const findMany = vi
      .spyOn(prisma.dependencyProject, "findMany")
      .mockResolvedValueOnce([{ id: "p1" }, { id: "p2" }] as never)
      .mockResolvedValueOnce([{ id: "p2" }, { id: "p3" }] as never);

    expect(await processDepsSchedulerTick(deps)).toEqual({ status: "OK", due: 3 });
    expect(findMany).toHaveBeenCalledTimes(2);
    expect(queued(scanQueue)).toEqual(["p1", "p2", "p3"]);
  });
});

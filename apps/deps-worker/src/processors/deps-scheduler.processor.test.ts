import { describe, expect, it, vi } from "vitest";
import { createFakePrisma, PROJECT_DEFAULTS } from "../testing/fake-prisma";
import { NOW } from "../testing/fixtures";
import { processDepsSchedulerTick, SCHEDULER_BATCH_SIZE, STALE_SCANNING_MS } from "./deps-scheduler.processor";

function setup(depsEnabled = true) {
  const prisma = createFakePrisma();
  prisma.instanceSettings.rows.push({ id: 1, depsEnabled });
  const project = (id: string, data: Record<string, unknown>) =>
    prisma.dependencyProject.rows.push({ ...PROJECT_DEFAULTS, id, updatedAt: NOW, ...data });
  const scanQueue = { addBulk: vi.fn(async (_jobs: Array<{ data: { projectId: string }; opts: Record<string, unknown> }>) => []) };
  return { prisma, project, scanQueue, deps: { prisma: prisma as never, scanQueue, now: () => NOW } };
}

const queued = (scanQueue: ReturnType<typeof setup>["scanQueue"]) => scanQueue.addBulk.mock.calls.flatMap(([jobs]) => jobs.map((j) => j.data.projectId)).sort();

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
    project("scanning", { nextScanAt: new Date(NOW.getTime() - 1), scanStatus: "SCANNING", updatedAt: new Date(NOW.getTime() - 60_000) });
    project("stale", { nextScanAt: new Date(NOW.getTime() - 1), scanStatus: "SCANNING", updatedAt: new Date(NOW.getTime() - STALE_SCANNING_MS - 1) });

    expect(await processDepsSchedulerTick(deps)).toEqual({ status: "OK", due: 4 });
    expect(queued(scanQueue)).toEqual(["due", "errored", "never", "stale"]);
    const [first] = scanQueue.addBulk.mock.calls[0]![0];
    expect(first!.opts).toEqual({ jobId: expect.stringMatching(/^deps-scan-/), priority: 10 });
  });

  it("works through large sets in batches", async () => {
    const { deps, project, scanQueue } = setup();
    for (let i = 0; i < SCHEDULER_BATCH_SIZE + 5; i++) project(`p${String(i).padStart(4, "0")}`, { nextScanAt: null });
    expect(await processDepsSchedulerTick(deps)).toEqual({ status: "OK", due: SCHEDULER_BATCH_SIZE + 5 });
    expect(scanQueue.addBulk).toHaveBeenCalledTimes(2);
    expect(new Set(queued(scanQueue)).size).toBe(SCHEDULER_BATCH_SIZE + 5);
  });
});

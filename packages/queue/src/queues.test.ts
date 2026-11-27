import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import { DEPS_NOTIFY_JOB_OPTIONS, DEPS_SCAN_JOB_OPTIONS, DEPS_UPDATE_JOB_OPTIONS } from "./deps.js";
import { NOTIFICATION_JOB_OPTIONS, RELEASE_BACKFILL_JOB_OPTIONS, REPO_POLL_JOB_OPTIONS } from "./names.js";
import { attachWorkerListeners, deduplicatedJobOptions, enqueueDeduplicated } from "./queues.js";
import { rateLimitDelayMs } from "./rate-limit.js";

describe("job options retention bounds", () => {
  it("uses bounded retention and keepLogs on deduplicated recurring job options", () => {
    for (const opts of [
      REPO_POLL_JOB_OPTIONS,
      RELEASE_BACKFILL_JOB_OPTIONS,
      DEPS_SCAN_JOB_OPTIONS,
      DEPS_UPDATE_JOB_OPTIONS,
    ]) {
      expect(opts.removeOnComplete).toEqual({ count: 200 });
      expect(opts.removeOnFail).toEqual({ age: 7 * 24 * 3600, count: 200 });
      expect(opts.keepLogs).toBe(50);
    }
  });

  it("caps removeOnFail count on notification job options", () => {
    expect(NOTIFICATION_JOB_OPTIONS.removeOnFail).toEqual({ age: 7 * 24 * 3600, count: 5000 });
    expect(DEPS_NOTIFY_JOB_OPTIONS.removeOnFail).toEqual({ age: 7 * 24 * 3600, count: 5000 });
  });
});

describe("deduplicatedJobOptions & enqueueDeduplicated", () => {
  it("builds deduplication options with keepLastIfActive: true", () => {
    expect(deduplicatedJobOptions("poll-r1")).toEqual({
      deduplication: { id: "poll-r1", keepLastIfActive: true },
    });
    expect(deduplicatedJobOptions("poll-r1", 1)).toEqual({
      deduplication: { id: "poll-r1", keepLastIfActive: true },
      priority: 1,
    });
  });

  it("adds a new deduplicated job when getDeduplicationJobId returns null", async () => {
    const queue = {
      add: vi.fn(async () => ({}) as never),
      getDeduplicationJobId: vi.fn(async () => null),
      getJob: vi.fn(async () => undefined),
    };
    await enqueueDeduplicated({
      queue,
      name: "poll-repository",
      data: { repositoryId: "r1" },
      deduplicationId: "poll-r1",
      priority: 1,
    });
    expect(queue.getJob).not.toHaveBeenCalled();
    expect(queue.add).toHaveBeenCalledWith(
      "poll-repository",
      { repositoryId: "r1" },
      { deduplication: { id: "poll-r1", keepLastIfActive: true }, priority: 1 },
    );
  });

  it("updates data and bumps priority for waiting/prioritized jobs when updateExistingData is true", async () => {
    const updateData = vi.fn(async () => undefined);
    const changePriority = vi.fn(async () => undefined);
    const queue = {
      add: vi.fn(async () => ({}) as never),
      getDeduplicationJobId: vi.fn(async () => "42"),
      getJob: vi.fn(async () => ({ getState: async () => "prioritized", updateData, changePriority }) as never),
    };
    await enqueueDeduplicated({
      queue,
      name: "poll-repository",
      data: { repositoryId: "r1", trigger: "manual" },
      deduplicationId: "poll-r1",
      priority: 1,
      updateExistingData: true,
    });
    expect(updateData).toHaveBeenCalledWith({ repositoryId: "r1", trigger: "manual" });
    expect(changePriority).toHaveBeenCalledWith({ priority: 1 });
    expect(queue.add).not.toHaveBeenCalled();
  });

  it("does not changePriority on delayed jobs and leaves active jobs alone unless queueIfActive is true", async () => {
    const updateData = vi.fn(async () => undefined);
    const changePriority = vi.fn(async () => undefined);
    const queue = {
      add: vi.fn(async () => ({}) as never),
      getDeduplicationJobId: vi.fn(async () => "42"),
      getJob: vi.fn(async () => ({ getState: async () => "delayed", updateData, changePriority }) as never),
    };
    await enqueueDeduplicated({
      queue,
      name: "poll-repository",
      data: { repositoryId: "r1" },
      deduplicationId: "poll-r1",
      priority: 1,
      updateExistingData: true,
    });
    expect(updateData).toHaveBeenCalledTimes(1);
    expect(changePriority).not.toHaveBeenCalled();

    queue.getJob.mockResolvedValueOnce({ getState: async () => "active", updateData, changePriority } as never);
    await enqueueDeduplicated({
      queue,
      name: "poll-repository",
      data: { repositoryId: "r1" },
      deduplicationId: "poll-r1",
      priority: 1,
      queueIfActive: false,
    });
    expect(queue.add).not.toHaveBeenCalled();

    queue.getJob.mockResolvedValueOnce({ getState: async () => "active", updateData, changePriority } as never);
    await enqueueDeduplicated({
      queue,
      name: "poll-repository",
      data: { repositoryId: "r1" },
      deduplicationId: "poll-r1",
      priority: 1,
      queueIfActive: true,
    });
    expect(queue.add).toHaveBeenCalledTimes(1);
  });
});

describe("attachWorkerListeners", () => {
  it("logs failed (with and without job), stalled, lockRenewalFailed, and error events", () => {
    const emitter = new EventEmitter();
    const log = { warn: vi.fn(), error: vi.fn() };
    attachWorkerListeners(emitter as never, log);

    emitter.emit("failed", { id: "j1", attemptsMade: 2, opts: { attempts: 3 } }, new Error("boom"));
    emitter.emit("failed", undefined, new Error("stalled out"));
    emitter.emit("stalled", "j2", "active");
    emitter.emit("lockRenewalFailed", ["j3", "j4"]);
    emitter.emit("error", new Error("redis down"));

    expect(log.error).toHaveBeenCalledWith("job j1 failed (attempt 2/3)", "boom");
    expect(log.error).toHaveBeenCalledWith("job failed (job record removed)", "stalled out");
    expect(log.warn).toHaveBeenCalledWith("job j2 stalled (previous state: active)");
    expect(log.error).toHaveBeenCalledWith("lock renewal failed for job(s): j3, j4");
    expect(log.error).toHaveBeenCalledWith("worker error", expect.any(Error));
  });
});

describe("rateLimitDelayMs", () => {
  const now = new Date("2026-11-05T12:00:00Z");

  it("defaults to 60s when resetAt is null", () => {
    expect(rateLimitDelayMs(null, now)).toBe(60_000);
  });

  it("adds 1s margin and clamps to [5s, 1h]", () => {
    expect(rateLimitDelayMs(new Date(now.getTime() + 10_000), now)).toBe(11_000);
    expect(rateLimitDelayMs(new Date(now.getTime() - 5_000), now)).toBe(5_000);
    expect(rateLimitDelayMs(new Date(now.getTime() + 1_000), now)).toBe(5_000);
    expect(rateLimitDelayMs(new Date(now.getTime() + 2 * 3600_000), now)).toBe(3600_000);
  });
});

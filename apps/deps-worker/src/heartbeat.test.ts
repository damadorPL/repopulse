import { afterEach, describe, expect, it, vi } from "vitest";
import { DEPS_WORKER_HEARTBEAT_INTERVAL_MS, DEPS_WORKER_HEARTBEAT_KEY } from "@repopulse/deps";
import { startHeartbeat, writeHeartbeat } from "./heartbeat";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("writeHeartbeat & startHeartbeat", () => {
  const now = () => new Date("2026-11-03T12:00:00Z");

  it("stores the sandbox health under the heartbeat key with a 90 s TTL", async () => {
    const redis = { set: vi.fn(async () => "OK" as const) };
    await writeHeartbeat(redis as never, { health: async () => ({ status: "ok", tools: { npm: "11.0.0" } }) }, now);
    expect(redis.set).toHaveBeenCalledWith(
      DEPS_WORKER_HEARTBEAT_KEY,
      JSON.stringify({ at: "2026-11-03T12:00:00.000Z", sandbox: { status: "ok", tools: { npm: "11.0.0" } } }),
      "EX",
      90,
    );
  });

  it("writes sandbox: null when the sandbox is unreachable", async () => {
    const redis = { set: vi.fn(async () => "OK" as const) };
    expect(await writeHeartbeat(redis as never, { health: async () => null }, now)).toEqual({ at: "2026-11-03T12:00:00.000Z", sandbox: null });
  });

  it("startHeartbeat beats immediately, repeats every interval, swallows errors, and stops on cleanup", async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const redis = {
      set: vi
        .fn<() => Promise<"OK">>()
        .mockRejectedValueOnce(new Error("redis connection lost"))
        .mockResolvedValue("OK"),
    };
    const stop = startHeartbeat(redis as never, null);
    await vi.advanceTimersByTimeAsync(0);
    expect(redis.set).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(DEPS_WORKER_HEARTBEAT_INTERVAL_MS);
    expect(redis.set).toHaveBeenCalledTimes(2);

    stop();
    await vi.advanceTimersByTimeAsync(DEPS_WORKER_HEARTBEAT_INTERVAL_MS * 2);
    expect(redis.set).toHaveBeenCalledTimes(2);
  });
});

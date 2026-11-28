import { EventEmitter } from "node:events";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as QueueModule from "@repopulse/queue";

class FakeRedis extends EventEmitter {
  readonly options: Record<string, unknown>;
  subscribe = vi.fn(async (..._channels: string[]) => 1);
  unsubscribe = vi.fn(async (..._channels: string[]) => 0);
  publish = vi.fn(async () => 1);
  constructor(options: Record<string, unknown>) {
    super();
    this.options = options;
  }
}

const createdConnections: FakeRedis[] = [];
const createRedisConnection = vi.fn((options: Record<string, unknown>) => {
  const conn = new FakeRedis(options);
  createdConnections.push(conn);
  return conn;
});

vi.mock("@repopulse/queue", async (importOriginal) => {
  const actual = await importOriginal<typeof QueueModule>();
  return {
    ...actual,
    createRedisConnection,
  };
});

const realtime = await import("./realtime");

const originalRedisUrl = process.env.REDIS_URL;

function resetGlobalRealtime() {
  const g = globalThis as Record<string, unknown>;
  delete g.repopulseRedis;
  delete g.repopulseRepoPollQueue;
  delete g.repopulseReleaseBackfillQueue;
  delete g.repopulseSubscriberState;
}

beforeEach(() => {
  vi.clearAllMocks();
  createdConnections.length = 0;
  resetGlobalRealtime();
  process.env.REDIS_URL = "redis://127.0.0.1:6379";
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  resetGlobalRealtime();
  if (originalRedisUrl === undefined) delete process.env.REDIS_URL;
  else process.env.REDIS_URL = originalRedisUrl;
});

describe("getRedis", () => {
  it("configures fail-fast options including maxRetriesPerRequest: 1 and enableOfflineQueue: false", () => {
    const conn = realtime.getRedis();
    expect(conn).toBe(createdConnections[0]);
    expect(createRedisConnection).toHaveBeenCalledWith({
      connectionName: "repopulse-web",
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      connectTimeout: 5_000,
    });
  });
});

describe("subscribeUserEvents", () => {
  it("multiplexes multiple tabs and users on one shared Redis connection with ref-counted subscribe/unsubscribe", async () => {
    const l1 = vi.fn<(message: string) => void>();
    const l2 = vi.fn<(message: string) => void>();
    const lOther = vi.fn<(message: string) => void>();

    const unsub1 = await realtime.subscribeUserEvents("u1", l1);
    const unsub2 = await realtime.subscribeUserEvents("u1", l2);
    const unsubOther = await realtime.subscribeUserEvents("u2", lOther);

    // Only one subscriber connection created for all tabs & users.
    expect(createdConnections).toHaveLength(1);
    const sub = createdConnections[0]!;
    expect(sub.subscribe).toHaveBeenCalledTimes(2);
    expect(sub.subscribe).toHaveBeenNthCalledWith(1, "user:u1:events");
    expect(sub.subscribe).toHaveBeenNthCalledWith(2, "user:u2:events");

    sub.emit("message", "user:u1:events", '{"type":"SYNC_STARTED"}');
    expect(l1).toHaveBeenCalledWith('{"type":"SYNC_STARTED"}');
    expect(l2).toHaveBeenCalledWith('{"type":"SYNC_STARTED"}');
    expect(lOther).not.toHaveBeenCalled();

    // 2 -> 1 does not unsubscribe Redis channel.
    await unsub1();
    expect(sub.unsubscribe).not.toHaveBeenCalled();

    // Calling unsub1 again is an idempotent no-op.
    await unsub1();
    expect(sub.unsubscribe).not.toHaveBeenCalled();

    // Reconnect re-subscribes active channels.
    sub.subscribe.mockClear();
    sub.emit("ready");
    expect(sub.subscribe).toHaveBeenCalledTimes(1);
    expect(sub.subscribe).toHaveBeenCalledWith("user:u1:events", "user:u2:events");

    // 1 -> 0 unsubscribes each channel.
    await unsub2();
    expect(sub.unsubscribe).toHaveBeenCalledTimes(1);
    expect(sub.unsubscribe).toHaveBeenLastCalledWith("user:u1:events");

    await unsubOther();
    expect(sub.unsubscribe).toHaveBeenCalledTimes(2);
    expect(sub.unsubscribe).toHaveBeenLastCalledWith("user:u2:events");

    // Ready with 0 active channels does not call subscribe.
    sub.subscribe.mockClear();
    sub.emit("ready");
    expect(sub.subscribe).not.toHaveBeenCalled();
  });

  it("cleans up the channel entry when initial subscribe fails", async () => {
    createRedisConnection.mockImplementationOnce((options: Record<string, unknown>) => {
      const conn = new FakeRedis(options);
      conn.subscribe.mockRejectedValueOnce(new Error("redis down"));
      createdConnections.push(conn);
      return conn;
    });

    await expect(realtime.subscribeUserEvents("u1", vi.fn<() => void>())).rejects.toThrow("redis down");

    // Channel entry was removed on failure, so a subsequent subscriber triggers 0 -> 1 subscribe again.
    const unsub = await realtime.subscribeUserEvents("u1", vi.fn<() => void>());
    expect(createdConnections[0]!.subscribe).toHaveBeenCalledTimes(2);
    await unsub();
    expect(createdConnections[0]!.unsubscribe).toHaveBeenCalledWith("user:u1:events");
  });
});

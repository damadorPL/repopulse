import { describe, expect, it, vi } from "vitest";

vi.mock("@repopulse/db", () => ({ prisma: {}, INSTANCE_SETTINGS_ID: 1, loadDepsEnabled: vi.fn() }));
vi.mock("@/server/queries/github-app", () => ({ isGitHubAppConfigured: vi.fn() }));
vi.mock("@/server/realtime", () => ({ getRedis: vi.fn(), isRealtimeConfigured: () => false, withRedisTimeout: vi.fn() }));

const { lockfileRegenerationAvailable, parseDepsWorkerHeartbeat, readDepsWorkerStatus } = await import("./deps-status");

describe("parseDepsWorkerHeartbeat", () => {
  it("treats a missing or malformed heartbeat as not running", () => {
    expect(parseDepsWorkerHeartbeat(null)).toEqual({ state: "missing" });
    expect(parseDepsWorkerHeartbeat("not json")).toEqual({ state: "missing" });
    expect(parseDepsWorkerHeartbeat(JSON.stringify({ at: "yesterday", sandbox: null }))).toEqual({ state: "missing" });
    expect(parseDepsWorkerHeartbeat("null")).toEqual({ state: "missing" });
  });

  it("reports an unreachable sandbox", () => {
    expect(parseDepsWorkerHeartbeat(JSON.stringify({ at: "2026-11-03T10:00:00.000Z", sandbox: null }))).toEqual({
      state: "running",
      at: new Date("2026-11-03T10:00:00.000Z"),
      sandbox: null,
    });
  });

  it("keeps only string tool versions", () => {
    const raw = JSON.stringify({ at: "2026-11-03T10:00:00.000Z", sandbox: { status: "ok", tools: { npm: "11.6.0", uv: "0.9.1", bad: 3 } } });
    expect(parseDepsWorkerHeartbeat(raw)).toEqual({
      state: "running",
      at: new Date("2026-11-03T10:00:00.000Z"),
      sandbox: { status: "ok", tools: { npm: "11.6.0", uv: "0.9.1" } },
    });
  });
});

describe("readDepsWorkerStatus", () => {
  it("is unknown without Redis", async () => {
    await expect(readDepsWorkerStatus()).resolves.toEqual({ state: "unknown" });
  });
});

describe("lockfileRegenerationAvailable", () => {
  it("needs a running deps-worker whose last sandbox probe succeeded", () => {
    const at = new Date("2026-11-03T10:00:00.000Z");
    expect(lockfileRegenerationAvailable({ state: "running", at, sandbox: { status: "ok", tools: { npm: "12.2.1" } } })).toBe(true);
    expect(lockfileRegenerationAvailable({ state: "running", at, sandbox: null })).toBe(false);
    expect(lockfileRegenerationAvailable({ state: "missing" })).toBe(false);
    expect(lockfileRegenerationAvailable({ state: "unknown" })).toBe(false);
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

const prisma = {
  instanceSettings: { findUnique: vi.fn() },
  dependencyProject: { count: vi.fn() },
  user: { count: vi.fn() },
  dependencyPullRequest: { count: vi.fn() },
};
const loadDepsEnabled = vi.fn();
const isGitHubAppConfigured = vi.fn();

vi.mock("@repopulse/db", () => ({ prisma, INSTANCE_SETTINGS_ID: 1, loadDepsEnabled }));
vi.mock("@/server/queries/github-app", () => ({ isGitHubAppConfigured }));
vi.mock("@/server/realtime", () => ({ getRedis: vi.fn(), isRealtimeConfigured: () => false, withRedisTimeout: vi.fn() }));

const {
  countOutdatedDependencyProjects,
  getDepsAdminView,
  getDepsSidebarInfo,
  lockfileRegenerationAvailable,
  parseDepsWorkerHeartbeat,
  readDepsWorkerStatus,
} = await import("./deps-status");

beforeEach(() => {
  vi.clearAllMocks();
});

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
    expect(lockfileRegenerationAvailable({ state: "running", at, sandbox: { status: "ok", tools: { npm: "12.2.2" } } })).toBe(true);
    expect(lockfileRegenerationAvailable({ state: "running", at, sandbox: null })).toBe(false);
    expect(lockfileRegenerationAvailable({ state: "missing" })).toBe(false);
    expect(lockfileRegenerationAvailable({ state: "unknown" })).toBe(false);
  });
});

describe("countOutdatedDependencyProjects and getDepsSidebarInfo", () => {
  it("counts outdated projects scoped to the user and skips counting when disabled", async () => {
    prisma.dependencyProject.count.mockResolvedValueOnce(3);
    await expect(countOutdatedDependencyProjects("u1")).resolves.toBe(3);
    expect(prisma.dependencyProject.count).toHaveBeenCalledWith({
      where: { userId: "u1", updates: { some: { status: "OUTDATED" } } },
    });

    loadDepsEnabled.mockResolvedValueOnce(false);
    await expect(getDepsSidebarInfo("u1")).resolves.toEqual({ enabled: false, outdatedProjects: 0 });

    loadDepsEnabled.mockResolvedValueOnce(true);
    prisma.dependencyProject.count.mockResolvedValueOnce(2);
    await expect(getDepsSidebarInfo("u2")).resolves.toEqual({ enabled: true, outdatedProjects: 2 });
  });
});

describe("getDepsAdminView", () => {
  it("returns instance-wide numbers for the admin dependencies page", async () => {
    prisma.instanceSettings.findUnique.mockResolvedValueOnce({ depsEnabled: true });
    isGitHubAppConfigured.mockResolvedValueOnce(true);
    prisma.dependencyProject.count.mockResolvedValueOnce(12).mockResolvedValueOnce(5);
    prisma.user.count.mockResolvedValueOnce(4);
    prisma.dependencyPullRequest.count.mockResolvedValueOnce(3);

    await expect(getDepsAdminView()).resolves.toEqual({
      enabled: true,
      worker: { state: "unknown" },
      appConfigured: true,
      projects: 12,
      users: 4,
      outdatedProjects: 5,
      openPullRequests: 3,
    });
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { RELEASE_BACKFILL_PRIORITY } from "@repopulse/queue";

class UnauthorizedError extends Error {}
class ForbiddenError extends Error {}

const currentUser = { id: "admin1", isSuperAdmin: true };

const prisma = {
  instanceSettings: { upsert: vi.fn() },
  repository: { findMany: vi.fn(), updateMany: vi.fn() },
};

const enqueueReleaseBackfill = vi.fn();
const getBackfillConfig = vi.fn();
const getBackfillSettingsView = vi.fn();
const isRealtimeConfigured = vi.fn();

vi.mock("@/lib/auth", () => ({
  UnauthorizedError,
  ForbiddenError,
  getCurrentUserOrThrow: vi.fn(async () => currentUser),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@repopulse/db", () => ({ prisma, INSTANCE_SETTINGS_ID: 1 }));
vi.mock("@repopulse/github", () => ({
  GitHubRateLimitError: class extends Error {},
  GitHubRepositoryNotFoundError: class extends Error {},
  InvalidRepositoryInputError: class extends Error {},
}));
vi.mock("@/server/backfill-queue", () => ({ enqueueReleaseBackfill }));
vi.mock("@/server/backfill-settings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/backfill-settings")>()),
  getBackfillConfig,
  getBackfillSettingsView,
}));
vi.mock("@/server/realtime", () => ({ isRealtimeConfigured }));

const { getCurrentUserOrThrow } = await import("@/lib/auth");
const { reapplyBackfillSettingsAction, saveBackfillSettingsAction } = await import("./backfill-settings");

const validInput = {
  defaultTarget: 200,
  maxAgeDays: 365,
  hardCap: 1000,
  minQuota: 500,
  deepStep: 100,
  deepCooldownMinutes: 10,
};

beforeEach(() => {
  vi.clearAllMocks();
  currentUser.isSuperAdmin = true;
  vi.mocked(getCurrentUserOrThrow).mockResolvedValue(currentUser as never);
  isRealtimeConfigured.mockReturnValue(true);
  getBackfillConfig.mockResolvedValue({ defaultTarget: 200 });
  getBackfillSettingsView.mockResolvedValue([]);
});

describe("super admin guard across backfill-settings actions", () => {
  it("returns FORBIDDEN for regular users and UNAUTHORIZED when signed out", async () => {
    currentUser.isSuperAdmin = false;
    expect(await saveBackfillSettingsAction(validInput)).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    expect(await reapplyBackfillSettingsAction()).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });

    vi.mocked(getCurrentUserOrThrow).mockRejectedValue(new UnauthorizedError("Not signed in"));
    expect(await saveBackfillSettingsAction(validInput)).toMatchObject({ ok: false, error: { code: "UNAUTHORIZED" } });
    expect(await reapplyBackfillSettingsAction()).toMatchObject({ ok: false, error: { code: "UNAUTHORIZED" } });
  });
});

describe("saveBackfillSettingsAction", () => {
  it("validates bounds and rejects defaultTarget > effective.hardCap", async () => {
    expect(await saveBackfillSettingsAction({ ...validInput, defaultTarget: -1 })).toMatchObject({
      ok: false,
      error: { code: "INVALID_INPUT" },
    });
    expect(await saveBackfillSettingsAction({ ...validInput, defaultTarget: 600, hardCap: 400 })).toMatchObject({
      ok: false,
      error: { code: "INVALID_INPUT" },
    });
    expect(prisma.instanceSettings.upsert).not.toHaveBeenCalled();
  });

  it("saves valid overrides to instanceSettings", async () => {
    const result = await saveBackfillSettingsAction(validInput);
    expect(result).toEqual({ ok: true, data: [] });
    expect(prisma.instanceSettings.upsert).toHaveBeenCalledWith({
      where: { id: 1 },
      create: {
        id: 1,
        backfillDefaultTarget: 200,
        backfillMaxAgeDays: 365,
        backfillHardCap: 1000,
        backfillMinQuota: 500,
        backfillDeepStep: 100,
        backfillDeepCooldownMinutes: 10,
      },
      update: {
        backfillDefaultTarget: 200,
        backfillMaxAgeDays: 365,
        backfillHardCap: 1000,
        backfillMinQuota: 500,
        backfillDeepStep: 100,
        backfillDeepCooldownMinutes: 10,
      },
    });
  });
});

describe("reapplyBackfillSettingsAction", () => {
  it("returns queued: 0 fast-path when there are no candidates", async () => {
    prisma.repository.findMany.mockResolvedValueOnce([]);
    const result = await reapplyBackfillSettingsAction();
    expect(result).toEqual({ ok: true, data: { queued: 0 } });
    expect(prisma.repository.updateMany).not.toHaveBeenCalled();
    expect(enqueueReleaseBackfill).not.toHaveBeenCalled();
  });

  it("updates candidates to QUEUED, enqueues jobs, and tolerates a mid-loop queue error", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    prisma.repository.findMany.mockResolvedValueOnce([{ id: "r1" }, { id: "r2" }, { id: "r3" }]);
    enqueueReleaseBackfill
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("Redis timeout"));

    const result = await reapplyBackfillSettingsAction();
    expect(result).toEqual({ ok: true, data: { queued: 3 } });
    expect(prisma.repository.updateMany).toHaveBeenCalledWith({
      where: {
        subscriptions: { some: {} },
        backfillStatus: "DONE",
        backfillNextPage: { not: null },
        backfillTarget: { lte: 200 },
        id: { in: ["r1", "r2", "r3"] },
      },
      data: { backfillTarget: 200, backfillStatus: "QUEUED" },
    });
    expect(enqueueReleaseBackfill).toHaveBeenCalledTimes(2);
    expect(enqueueReleaseBackfill).toHaveBeenNthCalledWith(
      1,
      { repositoryId: "r1", trigger: "sweep" },
      RELEASE_BACKFILL_PRIORITY.automatic,
    );
  });
});

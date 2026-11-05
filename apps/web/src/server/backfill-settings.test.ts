import { describe, expect, it, vi } from "vitest";
import { NO_BACKFILL_OVERRIDES } from "@repopulse/db";

const { prisma } = vi.hoisted(() => ({
  prisma: {
    repository: {
      findMany: vi.fn(),
      count: vi.fn(),
    },
  },
}));

vi.mock("@repopulse/db", async (importOriginal) => ({ ...(await importOriginal<object>()), prisma }));

const { buildBackfillSettingsView, countReapplyCandidates, getReapplyCandidates, reapplyCandidatesWhere } = await import("./backfill-settings");

const byKey = (view: ReturnType<typeof buildBackfillSettingsView>) => Object.fromEntries(view.map((s) => [s.key, s]));

describe("buildBackfillSettingsView", () => {
  it("reports defaults, environment values and admin overrides with their source", () => {
    const view = byKey(
      buildBackfillSettingsView(
        { RELEASE_BACKFILL_MAX_AGE_DAYS: "30" },
        { ...NO_BACKFILL_OVERRIDES, defaultTarget: 250, deepCooldownMinutes: 0 },
      ),
    );
    expect(view.defaultTarget).toMatchObject({ value: 250, override: 250, fallback: 100, fallbackSource: "default", source: "admin" });
    expect(view.maxAgeDays).toMatchObject({ value: 30, override: null, fallback: 30, fallbackSource: "env", source: "env" });
    expect(view.hardCap).toMatchObject({ value: 1000, source: "default", envVar: "RELEASE_BACKFILL_HARD_CAP", min: 1 });
    expect(view.deepCooldownMinutes).toMatchObject({ value: 0, source: "admin", envVar: null });
  });

  it("shows the clamped value in effect when the target exceeds the hard cap", () => {
    const view = byKey(buildBackfillSettingsView({}, { ...NO_BACKFILL_OVERRIDES, defaultTarget: 500, hardCap: 200 }));
    expect(view.defaultTarget?.value).toBe(200);
  });
});

describe("reapplyCandidatesWhere and countReapplyCandidates", () => {
  it("only matches tracked repositories with older releases left and an automatic target", () => {
    expect(reapplyCandidatesWhere(300)).toEqual({
      subscriptions: { some: {} },
      backfillStatus: "DONE",
      backfillNextPage: { not: null },
      backfillTarget: { lte: 300 },
    });
  });

  it("calls prisma count with reapplyCandidatesWhere", async () => {
    prisma.repository.count.mockResolvedValueOnce(3);
    expect(await countReapplyCandidates(100)).toBe(3);
    expect(prisma.repository.count).toHaveBeenCalledWith({ where: reapplyCandidatesWhere(100) });
  });
});

describe("getReapplyCandidates", () => {
  it("computes missing releases and returns candidate details", async () => {
    const oldestDate = new Date("2024-01-01T00:00:00Z");
    prisma.repository.findMany.mockResolvedValueOnce([
      {
        id: "repo1",
        fullName: "facebook/react",
        avatarUrl: "https://avatar/react",
        backfillTarget: 50,
        backfillNextPage: 2,
        _count: { releases: 30 },
        releases: [{ tagName: "v17.0.0", publishedAt: oldestDate }],
      },
      {
        id: "repo2",
        fullName: "vuejs/core",
        avatarUrl: null,
        backfillTarget: 100,
        backfillNextPage: 3,
        _count: { releases: 100 },
        releases: [],
      },
    ]);

    const candidates = await getReapplyCandidates(100);

    expect(candidates).toEqual([
      {
        id: "repo1",
        fullName: "facebook/react",
        avatarUrl: "https://avatar/react",
        releaseCount: 30,
        backfillTarget: 50,
        backfillNextPage: 2,
        missingReleases: 70, // 100 - 30
        oldestRelease: { tagName: "v17.0.0", publishedAt: oldestDate },
      },
      {
        id: "repo2",
        fullName: "vuejs/core",
        avatarUrl: null,
        releaseCount: 100,
        backfillTarget: 100,
        backfillNextPage: 3,
        missingReleases: 0, // 100 - 100
        oldestRelease: null,
      },
    ]);
  });
});

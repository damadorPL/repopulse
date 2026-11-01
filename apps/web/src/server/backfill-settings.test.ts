import { describe, expect, it, vi } from "vitest";
import { NO_BACKFILL_OVERRIDES } from "@repopulse/db";

vi.mock("@repopulse/db", async (importOriginal) => ({ ...(await importOriginal<object>()), prisma: {} }));

const { buildBackfillSettingsView, reapplyCandidatesWhere } = await import("./backfill-settings");

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

describe("reapplyCandidatesWhere", () => {
  it("only matches tracked repositories with older releases left and an automatic target", () => {
    expect(reapplyCandidatesWhere(300)).toEqual({
      subscriptions: { some: {} },
      backfillStatus: "DONE",
      backfillNextPage: { not: null },
      backfillTarget: { lte: 300 },
    });
  });
});

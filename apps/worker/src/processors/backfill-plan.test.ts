import { describe, expect, it } from "vitest";
import type { MappedRelease } from "@repopulse/github";
import { effectiveTarget, maxAgeCutoff, planBackfillPage, targetStop, type BackfillPageInput } from "./backfill-plan";

const NOW = new Date("2026-10-31T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

/** Release `id` published `daysAgo` days before NOW. */
function rel(id: number, daysAgo: number): MappedRelease {
  return {
    githubReleaseId: BigInt(id),
    tagName: `v${id}`,
    title: `v${id}`,
    bodyMarkdown: "",
    htmlUrl: `https://github.com/acme/widget/releases/tag/v${id}`,
    isPrerelease: false,
    isDraft: false,
    semverType: "PATCH",
    publishedAt: new Date(NOW.getTime() - daysAgo * DAY),
  };
}

/** A newest-first page of `count` releases, ids descending from `firstId`, one per day from `firstDaysAgo`. */
function page(firstId: number, count: number, firstDaysAgo: number): MappedRelease[] {
  return Array.from({ length: count }, (_, i) => rel(firstId - i, firstDaysAgo + i));
}

function input(overrides: Partial<BackfillPageInput>): BackfillPageInput {
  return {
    page: 1,
    releases: [],
    hasNextPage: true,
    storedIds: new Set(),
    storedCount: 0,
    target: 100,
    hardCap: 1000,
    newestKnownAt: NOW,
    cutoff: null,
    ...overrides,
  };
}

const ids = (releases: MappedRelease[]) => releases.map((r) => Number(r.githubReleaseId));

describe("planBackfillPage", () => {
  it("inserts only releases not stored yet and moves to the next page", () => {
    const releases = page(100, 5, 1);
    const plan = planBackfillPage(input({ releases, storedIds: new Set([100n, 99n]), storedCount: 2 }));
    expect(ids(plan.insert)).toEqual([98, 97, 96]);
    expect(plan.nextPage).toBe(2);
    expect(plan.stop).toBeNull();
  });

  it("never imports releases newer than the newest stored one (left for repo-poll)", () => {
    const releases = page(100, 4, 0);
    const plan = planBackfillPage(input({ releases, storedIds: new Set([98n]), storedCount: 1, newestKnownAt: releases[2]!.publishedAt }));
    // 100 and 99 are newer than the newest stored release (98).
    expect(ids(plan.insert)).toEqual([97]);
    expect(plan.nextPage).toBe(2);
  });

  it("stops DONE (complete) on the last page", () => {
    const plan = planBackfillPage(input({ releases: page(10, 3, 1), hasNextPage: false, storedCount: 20 }));
    expect(ids(plan.insert)).toEqual([10, 9, 8]);
    expect(plan.stop).toEqual({ status: "DONE", reason: "COMPLETE" });
  });

  it("caps the insert at the target and stays on the page", () => {
    const plan = planBackfillPage(input({ page: 3, releases: page(300, 100, 1), storedCount: 280, target: 300 }));
    expect(plan.insert).toHaveLength(20);
    expect(ids(plan.insert).slice(0, 2)).toEqual([300, 299]);
    expect(plan.nextPage).toBe(3);
    expect(plan.stop).toEqual({ status: "DONE", reason: "TARGET" });
  });

  it("stops PARTIAL when the target is the hard cap", () => {
    const plan = planBackfillPage(input({ page: 10, releases: page(100, 100, 1), storedCount: 950, target: 1000, hardCap: 1000 }));
    expect(plan.insert).toHaveLength(50);
    expect(plan.stop).toEqual({ status: "PARTIAL", reason: "TARGET" });
  });

  it("prefers COMPLETE when the last page exactly fills the target", () => {
    const plan = planBackfillPage(input({ releases: page(10, 10, 1), hasNextPage: false, storedCount: 90, target: 100 }));
    expect(plan.insert).toHaveLength(10);
    expect(plan.stop).toEqual({ status: "DONE", reason: "COMPLETE" });
  });

  it("stops at the age cutoff, importing only newer releases and keeping the page for later", () => {
    const cutoff = new Date(NOW.getTime() - 365 * DAY);
    const releases = [rel(5, 300), rel(4, 364), rel(3, 366), rel(2, 400)];
    const plan = planBackfillPage(input({ page: 4, releases, storedCount: 30, cutoff }));
    expect(ids(plan.insert)).toEqual([5, 4]);
    expect(plan.nextPage).toBe(4);
    expect(plan.stop).toEqual({ status: "DONE", reason: "MAX_AGE" });
  });

  it("is idempotent: a fully stored page inserts nothing", () => {
    const releases = page(100, 3, 1);
    const plan = planBackfillPage(input({ releases, storedIds: new Set(releases.map((r) => r.githubReleaseId)), storedCount: 3 }));
    expect(plan.insert).toEqual([]);
    expect(plan.nextPage).toBe(2);
  });
});

describe("targets and cutoffs", () => {
  it("clamps the target to the hard cap", () => {
    expect(effectiveTarget(1200, 1000)).toBe(1000);
    expect(effectiveTarget(300, 1000)).toBe(300);
  });

  it("reports PARTIAL only at the hard cap", () => {
    expect(targetStop(1000, 1000).status).toBe("PARTIAL");
    expect(targetStop(300, 1000).status).toBe("DONE");
  });

  it("applies the age limit only to the automatic backfill", () => {
    const config = { maxAgeDays: 365, defaultTarget: 100 };
    expect(maxAgeCutoff(config, 100, NOW)).toEqual(new Date(NOW.getTime() - 365 * DAY));
    // "Load older releases" raised the target past the default.
    expect(maxAgeCutoff(config, 300, NOW)).toBeNull();
    expect(maxAgeCutoff({ maxAgeDays: 0, defaultTarget: 100 }, 100, NOW)).toBeNull();
  });
});

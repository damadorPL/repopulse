import { describe, expect, it } from "vitest";
import {
  activityThresholds,
  bucketByLocalDay,
  buildWeeks,
  computeActivityStats,
  dayKey,
  describeDay,
  levelFor,
  localDayKey,
  monthLabels,
  type ActivityItem,
} from "./activity-grid";

let seq = 0;
function item(at: string, extra: Partial<ActivityItem> = {}): ActivityItem {
  seq += 1;
  return { id: `r${seq}`, at, source: "RELEASE", semverType: "MINOR", ...extra };
}

describe("dayKey / bucketByLocalDay", () => {
  it("buckets by the day in the given time zone, not UTC", () => {
    // 03:30 UTC on Oct 15 is still Oct 14 in New York (UTC-4).
    expect(dayKey(new Date("2026-10-15T03:30:00Z"), "America/New_York")).toBe("2026-10-14");
    expect(dayKey(new Date("2026-10-15T03:30:00Z"), "UTC")).toBe("2026-10-15");
    expect(dayKey(new Date("2026-10-14T23:30:00Z"), "Europe/Warsaw")).toBe("2026-10-15");
  });

  it("counts per source, flags major releases and remembers the newest item", () => {
    const items = [
      item("2026-10-14T08:00:00Z", { id: "old" }),
      item("2026-10-14T20:00:00Z", { id: "new", source: "COMMIT", semverType: "OTHER" }),
      item("2026-10-14T12:00:00Z", { id: "major", source: "TAG", semverType: "MAJOR" }),
      item("2026-10-16T12:00:00Z", { id: "other-day" }),
      item("not a date"),
    ];
    const buckets = bucketByLocalDay(items, "UTC");
    expect([...buckets.keys()]).toEqual(["2026-10-14", "2026-10-16"]);
    expect(buckets.get("2026-10-14")).toEqual({
      count: 3,
      bySource: { RELEASE: 1, TAG: 1, COMMIT: 1 },
      hasMajor: true,
      newestId: "new",
      newestAt: Date.parse("2026-10-14T20:00:00Z"),
    });
    expect(buckets.get("2026-10-16")?.hasMajor).toBe(false);
  });

  it("does not flag a day as major because of a commit", () => {
    const buckets = bucketByLocalDay([item("2026-10-14T08:00:00Z", { source: "COMMIT", semverType: "MAJOR" })], "UTC");
    expect(buckets.get("2026-10-14")?.hasMajor).toBe(false);
  });
});

describe("buildWeeks", () => {
  const today = new Date(2026, 9, 14, 15, 30); // Wed, 14 Oct 2026, local time

  it("builds 53 weeks of 7 days ending with the week of today", () => {
    const weeks = buildWeeks(today);
    expect(weeks).toHaveLength(53);
    expect(weeks.every((week) => week.length === 7)).toBe(true);
    const last = weeks.at(-1)!;
    expect(last[0]!.key).toBe("2026-10-11"); // Sunday
    expect(last[3]!.key).toBe("2026-10-14");
    expect(last[3]!.outOfRange).toBe(false);
    expect(last.slice(4).every((day) => day.outOfRange)).toBe(true);
    expect(weeks[0]![0]!.key).toBe("2025-10-12");
  });

  it("has consecutive, unique days (no DST gaps)", () => {
    const keys = buildWeeks(today).flat().map((day) => day.key);
    expect(new Set(keys).size).toBe(53 * 7);
    for (let i = 1; i < keys.length; i++) expect(keys[i]! > keys[i - 1]!).toBe(true);
  });

  it("honors weekStartsOn", () => {
    expect(buildWeeks(today, 1).at(-1)![0]!.key).toBe("2026-10-12"); // Monday
  });
});

describe("activityThresholds / levelFor", () => {
  it("is 0 for empty days and 4 for the busiest", () => {
    const t = activityThresholds([1, 2, 3, 4, 5, 6, 7, 8, 30]);
    expect(levelFor(0, t)).toBe(0);
    expect(levelFor(30, t)).toBe(4);
    expect(levelFor(1, t)).toBe(1);
    expect(levelFor(5, t)).toBe(2);
    expect(levelFor(7, t)).toBe(3);
    expect(levelFor(8, t)).toBe(4);
  });

  it("uses the full scale for sparse repositories too", () => {
    // Three releases a year, one per day: every active day is the busiest.
    const sparse = activityThresholds([1, 1, 1, 0, 0]);
    expect(levelFor(1, sparse)).toBe(4);
    // Thirty commits a week spread unevenly still spread over levels 1–4.
    const busy = activityThresholds([2, 4, 6, 8, 10]);
    expect([2, 4, 6, 8, 10].map((c) => levelFor(c, busy))).toEqual([1, 1, 2, 3, 4]);
  });

  it("handles no activity", () => {
    expect(levelFor(0, activityThresholds([]))).toBe(0);
  });
});

describe("monthLabels", () => {
  it("labels the week holding the 1st of each month", () => {
    const weeks = buildWeeks(new Date(2026, 9, 14));
    const labels = monthLabels(weeks);
    const oct = labels.find((l) => l.label === "Oct" && l.index > 0)!;
    expect(weeks[oct.index]!.some((day) => day.key === "2026-10-01")).toBe(true);
    // Twelve month starts in 53 weeks (plus possibly the first column).
    expect(labels.filter((l) => l.index > 0).length).toBeGreaterThanOrEqual(12);
    expect(labels.map((l) => l.index)).toEqual([...labels.map((l) => l.index)].sort((a, b) => a - b));
  });
});

describe("computeActivityStats", () => {
  const now = new Date(2026, 9, 14, 12, 0); // Wed, local

  it("summarizes the last year, cadence, busiest month and streak", () => {
    const local = (y: number, m: number, d: number, extra: Partial<ActivityItem> = {}) => item(new Date(y, m, d, 12).toISOString(), extra);
    const items = [
      local(2026, 9, 13), // this week
      local(2026, 9, 6), // last week
      local(2026, 8, 30), // two weeks ago
      local(2026, 8, 10, { source: "COMMIT" }),
      local(2026, 8, 3),
      local(2025, 5, 1), // older than a year
    ];
    const stats = computeActivityStats(items, now);
    expect(stats.lastYear).toBe(5);
    expect(stats.lastUpdateAt?.getTime()).toBe(new Date(2026, 9, 13, 12).getTime());
    // Release gaps (commits excluded): Jun 1 2025 → Sep 3, 27, … median in days.
    expect(stats.medianDaysBetweenReleases).not.toBeNull();
    expect(stats.busiestMonth?.key).toBe("2026-09");
    expect(stats.busiestMonth?.count).toBe(3);
    expect(stats.currentStreakWeeks).toBe(3);
  });

  it("counts the streak from last week when this week has nothing yet", () => {
    const items = [item(new Date(2026, 9, 7, 12).toISOString()), item(new Date(2026, 8, 30, 12).toISOString())];
    expect(computeActivityStats(items, now).currentStreakWeeks).toBe(2);
    expect(computeActivityStats([item(new Date(2026, 8, 20, 12).toISOString())], now).currentStreakWeeks).toBe(0);
  });

  it("needs three releases for a median gap", () => {
    const items = [item(new Date(2026, 9, 1).toISOString()), item(new Date(2026, 9, 11).toISOString())];
    expect(computeActivityStats(items, now).medianDaysBetweenReleases).toBeNull();
    const three = [...items, item(new Date(2026, 9, 13).toISOString())];
    expect(computeActivityStats(three, now).medianDaysBetweenReleases).toBeCloseTo(6, 0);
  });

  it("is empty without items", () => {
    expect(computeActivityStats([], now)).toEqual({
      lastYear: 0,
      lastUpdateAt: null,
      medianDaysBetweenReleases: null,
      busiestMonth: null,
      currentStreakWeeks: 0,
    });
  });
});

describe("describeDay / localDayKey", () => {
  it("writes the tooltip", () => {
    const date = new Date(2026, 9, 14);
    expect(localDayKey(date)).toBe("2026-10-14");
    expect(describeDay(date, undefined)).toBe("No updates on Wed, 14 Oct 2026");
    const [bucket] = bucketByLocalDay(
      [item(new Date(2026, 9, 14, 9).toISOString()), item(new Date(2026, 9, 14, 10).toISOString(), { source: "COMMIT" }), item(new Date(2026, 9, 14, 11).toISOString(), { source: "COMMIT" })],
    ).values();
    expect(describeDay(date, bucket)).toBe("3 updates on Wed, 14 Oct 2026 · 1 release, 2 commits");
  });
});

/**
 * The repository activity grid (Slice 07): a GitHub-style heatmap of the updates a user can see
 * for one repository over the last 53 weeks. Pure, browser-safe helpers; the server sends
 * timestamps and the browser buckets them by the viewer's local day, so a release at 23:30 local
 * time lands on the right square whatever the server's clock says.
 */

import { format } from "date-fns";

export const ACTIVITY_SOURCES = ["RELEASE", "TAG", "COMMIT"] as const;
export type ActivitySource = (typeof ACTIVITY_SOURCES)[number];

export const ACTIVITY_WEEKS = 53;
/** Days of history the server sends: 53 weeks plus the partial current week. */
export const ACTIVITY_WINDOW_DAYS = 371;

export interface ActivityItem {
  id: string;
  /** ISO timestamp (`publishedAt`). */
  at: string;
  source: ActivitySource;
  semverType: string;
}

export interface DayBucket {
  count: number;
  bySource: Record<ActivitySource, number>;
  /** A `MAJOR` release or tag was published that day. */
  hasMajor: boolean;
  /** The newest item of the day (opened in the reader on click). */
  newestId: string;
  newestAt: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function pad(value: number): string {
  return value.toString().padStart(2, "0");
}

/** `YYYY-MM-DD` of a date in the local time zone of the runtime. */
export function localDayKey(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** `YYYY-MM-DD` of an instant in `timeZone` (IANA name), or in the runtime's local zone. */
export function dayKey(date: Date, timeZone?: string): string {
  if (!timeZone) return localDayKey(date);
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** Groups items by local day, with per-source counts, a major-release flag and the newest item of each day. */
export function bucketByLocalDay(items: readonly ActivityItem[], timeZone?: string): Map<string, DayBucket> {
  const buckets = new Map<string, DayBucket>();
  for (const item of items) {
    const at = new Date(item.at);
    const time = at.getTime();
    if (Number.isNaN(time)) continue;
    const key = dayKey(at, timeZone);
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { count: 0, bySource: { RELEASE: 0, TAG: 0, COMMIT: 0 }, hasMajor: false, newestId: item.id, newestAt: time };
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    bucket.bySource[item.source] += 1;
    if (item.semverType === "MAJOR" && item.source !== "COMMIT") bucket.hasMajor = true;
    if (time > bucket.newestAt) {
      bucket.newestAt = time;
      bucket.newestId = item.id;
    }
  }
  return buckets;
}

export interface GridDay {
  key: string;
  /** Local midnight of the day. */
  date: Date;
  /** After today: rendered as an empty slot. */
  outOfRange: boolean;
}

/** Local midnight `days` after `date` (calendar arithmetic, so DST changes never skip or repeat a day). */
function addDays(date: Date, days: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

/**
 * 53 week columns of 7 days, oldest first, the last column holding `today`. Weeks start on
 * `weekStartsOn` (0 = Sunday, like GitHub). Days after today are marked `outOfRange`.
 */
export function buildWeeks(today: Date, weekStartsOn = 0): GridDay[][] {
  const midnight = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const offset = (midnight.getDay() - weekStartsOn + 7) % 7;
  const firstDay = addDays(midnight, -offset - (ACTIVITY_WEEKS - 1) * 7);
  const weeks: GridDay[][] = [];
  for (let w = 0; w < ACTIVITY_WEEKS; w++) {
    const week: GridDay[] = [];
    for (let d = 0; d < 7; d++) {
      const date = addDays(firstDay, w * 7 + d);
      week.push({ key: localDayKey(date), date, outOfRange: date.getTime() > midnight.getTime() });
    }
    weeks.push(week);
  }
  return weeks;
}

/**
 * Level thresholds from the quartiles of the non-zero day counts (GitHub-style), so a repository
 * with 3 releases a year and one with 30 commits a week both use the whole color scale.
 */
export function activityThresholds(counts: Iterable<number>): { q1: number; q2: number; q3: number; max: number } {
  const values = [...counts].filter((c) => c > 0).sort((a, b) => a - b);
  if (values.length === 0) return { q1: 0, q2: 0, q3: 0, max: 0 };
  const at = (p: number) => values[Math.floor(p * (values.length - 1))]!;
  return { q1: at(0.25), q2: at(0.5), q3: at(0.75), max: values.at(-1)! };
}

/** Color level 0–4 of a day: 0 = nothing, 4 = the busiest days. */
export function levelFor(count: number, thresholds: { q1: number; q2: number; q3: number; max: number }): 0 | 1 | 2 | 3 | 4 {
  if (count <= 0) return 0;
  if (count >= thresholds.max) return 4;
  if (count <= thresholds.q1) return 1;
  if (count <= thresholds.q2) return 2;
  if (count <= thresholds.q3) return 3;
  return 4;
}

const shortMonth = new Intl.DateTimeFormat("en", { month: "short" });

/** Month labels: the column index of the week holding the 1st of each month, with its short name. */
export function monthLabels(weeks: readonly GridDay[][]): Array<{ index: number; label: string }> {
  const labels: Array<{ index: number; label: string }> = [];
  weeks.forEach((week, index) => {
    const first = week.find((day) => day.date.getDate() === 1);
    if (first) labels.push({ index, label: shortMonth.format(first.date) });
  });
  // Label the first column too when the first month change is far enough away not to collide.
  const firstDay = weeks[0]?.[0];
  if (firstDay && (labels.length === 0 || labels[0]!.index >= 3)) {
    labels.unshift({ index: 0, label: shortMonth.format(firstDay.date) });
  }
  return labels;
}

export interface ActivityStats {
  /** Updates in the last 365 days. */
  lastYear: number;
  lastUpdateAt: Date | null;
  /** Median days between consecutive releases / tags; `null` with fewer than 3. */
  medianDaysBetweenReleases: number | null;
  /** The month with the most updates in the window (`YYYY-MM`, local). */
  busiestMonth: { key: string; date: Date; count: number } | null;
  /** Consecutive weeks with at least one update, ending this week (or last week, if this one is still empty). */
  currentStreakWeeks: number;
}

/** Summary numbers shown next to the grid. Local time zone, like the grid. */
export function computeActivityStats(items: readonly ActivityItem[], now: Date, weekStartsOn = 0): ActivityStats {
  const times = items.map((item) => ({ ...item, time: new Date(item.at).getTime() })).filter((item) => !Number.isNaN(item.time));
  const yearAgo = now.getTime() - 365 * DAY_MS;
  const lastYear = times.filter((item) => item.time >= yearAgo && item.time <= now.getTime()).length;
  const lastUpdate = times.reduce<number | null>((max, item) => (max === null || item.time > max ? item.time : max), null);

  const releases = times
    .filter((item) => item.source !== "COMMIT")
    .map((item) => item.time)
    .sort((a, b) => a - b);
  let medianDaysBetweenReleases: number | null = null;
  if (releases.length >= 3) {
    const gaps = releases.slice(1).map((time, i) => (time - releases[i]!) / DAY_MS).sort((a, b) => a - b);
    const mid = Math.floor(gaps.length / 2);
    medianDaysBetweenReleases = gaps.length % 2 === 1 ? gaps[mid]! : (gaps[mid - 1]! + gaps[mid]!) / 2;
  }

  const byMonth = new Map<string, { date: Date; count: number }>();
  for (const item of times) {
    const date = new Date(item.time);
    const key = `${date.getFullYear()}-${pad(date.getMonth() + 1)}`;
    const entry = byMonth.get(key) ?? { date: new Date(date.getFullYear(), date.getMonth(), 1), count: 0 };
    entry.count += 1;
    byMonth.set(key, entry);
  }
  let busiestMonth: ActivityStats["busiestMonth"] = null;
  for (const [key, entry] of byMonth) {
    // Ties go to the more recent month.
    if (!busiestMonth || entry.count > busiestMonth.count || (entry.count === busiestMonth.count && key > busiestMonth.key)) {
      busiestMonth = { key, ...entry };
    }
  }

  const weekKey = (time: number) => {
    const date = new Date(time);
    const offset = (date.getDay() - weekStartsOn + 7) % 7;
    return localDayKey(addDays(date, -offset));
  };
  const activeWeeks = new Set(times.map((item) => weekKey(item.time)));
  let cursor = addDays(new Date(now.getFullYear(), now.getMonth(), now.getDate()), -((now.getDay() - weekStartsOn + 7) % 7));
  if (!activeWeeks.has(localDayKey(cursor))) cursor = addDays(cursor, -7);
  let currentStreakWeeks = 0;
  while (activeWeeks.has(localDayKey(cursor))) {
    currentStreakWeeks += 1;
    cursor = addDays(cursor, -7);
  }

  return {
    lastYear,
    lastUpdateAt: lastUpdate === null ? null : new Date(lastUpdate),
    medianDaysBetweenReleases,
    busiestMonth,
    currentStreakWeeks,
  };
}

const SOURCE_WORDS: Record<ActivitySource, [string, string]> = {
  RELEASE: ["release", "releases"],
  TAG: ["tag", "tags"],
  COMMIT: ["commit", "commits"],
};

/** "3 updates on Mon, 14 Oct 2026 · 1 release, 2 commits" (or "No updates on …"). */
export function describeDay(date: Date, bucket: DayBucket | undefined): string {
  const day = format(date, "EEE, d MMM yyyy");
  if (!bucket || bucket.count === 0) return `No updates on ${day}`;
  const parts = ACTIVITY_SOURCES.filter((source) => bucket.bySource[source] > 0).map((source) => {
    const count = bucket.bySource[source];
    return `${count} ${SOURCE_WORDS[source][count === 1 ? 0 : 1]}`;
  });
  return `${bucket.count} update${bucket.count === 1 ? "" : "s"} on ${day} · ${parts.join(", ")}`;
}

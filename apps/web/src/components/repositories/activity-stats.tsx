"use client";

import { useMemo, type ReactNode } from "react";
import { format } from "date-fns";
import { RelativeTime } from "@/components/feed/relative-time";
import { Skeleton } from "@/components/ui/skeleton";
import { computeActivityStats, type ActivityItem } from "@/lib/activity-grid";
import { useClientNow } from "./activity-grid";

function Stat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 truncate text-sm font-medium tabular-nums">{children}</dd>
    </div>
  );
}

function formatDays(days: number): string {
  if (days < 1) return "under a day";
  const rounded = Math.round(days);
  return `${rounded} day${rounded === 1 ? "" : "s"}`;
}

/**
 * Totals next to the activity grid: updates in the last 12 months, last update, median days between
 * releases (releases and tags only), busiest month and the current streak of weeks with an update.
 * Computed in the browser, in the viewer's time zone, like the grid.
 */
export function ActivityStats({ items }: { items: ActivityItem[] }) {
  const now = useClientNow();
  const stats = useMemo(() => (now ? computeActivityStats(items, now) : null), [items, now]);

  if (!stats) {
    return (
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-5" aria-busy="true">
        {Array.from({ length: 5 }, (_, i) => (
          <Skeleton key={i} className="h-10" />
        ))}
      </div>
    );
  }

  return (
    <dl className="grid grid-cols-2 gap-4 sm:grid-cols-5">
      <Stat label="Last 12 months">
        {stats.lastYear.toLocaleString("en")} update{stats.lastYear === 1 ? "" : "s"}
      </Stat>
      <Stat label="Last update">{stats.lastUpdateAt ? <RelativeTime date={stats.lastUpdateAt} /> : "—"}</Stat>
      <Stat label="Typical gap between releases">
        {stats.medianDaysBetweenReleases === null ? "—" : formatDays(stats.medianDaysBetweenReleases)}
      </Stat>
      <Stat label="Busiest month">
        {stats.busiestMonth ? `${format(stats.busiestMonth.date, "MMM yyyy")} (${stats.busiestMonth.count})` : "—"}
      </Stat>
      <Stat label="Weekly streak">
        {stats.currentStreakWeeks > 0 ? `${stats.currentStreakWeeks} week${stats.currentStreakWeeks === 1 ? "" : "s"}` : "—"}
      </Stat>
    </dl>
  );
}

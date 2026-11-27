"use client";

import { format } from "date-fns";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";

import { Skeleton } from "@/components/ui/skeleton";
import {
  activityThresholds,
  bucketByLocalDay,
  buildWeeks,
  describeDay,
  levelFor,
  monthLabels,
  type ActivityItem,
  type ActivitySource,
  type DayBucket,
} from "@/lib/activity-grid";
import { feedHref } from "@/lib/feed-filters";
import { cn } from "@/lib/utils";

const emptySubscribe = () => () => {};
let cachedClientNow: Date | null = null;
const getClientNow = () => (cachedClientNow ??= new Date());
const getServerNow = () => null;

/**
 * The current time on the client. `null` during the server render and hydration: bucketing by
 * local day needs the browser's time zone, so nothing date-dependent is rendered on the server.
 */
export function useClientNow(): Date | null {
  return useSyncExternalStore(emptySubscribe, getClientNow, getServerNow);
}

const LEVEL_CLASSES = [
  "bg-muted",
  "bg-(--activity-1)",
  "bg-(--activity-2)",
  "bg-(--activity-3)",
  "bg-(--activity-4)",
] as const;

const SOURCE_FILTERS: ReadonlyArray<{ value: ActivitySource | "ALL"; label: string }> = [
  { value: "ALL", label: "All" },
  { value: "RELEASE", label: "Releases" },
  { value: "TAG", label: "Tags" },
  { value: "COMMIT", label: "Commits" },
];

const WEEKDAY_ROWS = [
  { key: "sun", label: "" },
  { key: "mon", label: "Mon" },
  { key: "tue", label: "" },
  { key: "wed", label: "Wed" },
  { key: "thu", label: "" },
  { key: "fri", label: "Fri" },
  { key: "sat", label: "" },
] as const;

/**
 * GitHub-style heatmap of a repository's updates over the last 53 weeks (Slice 07). Bucketed in the
 * browser by local day. A day with a major release gets a ring; clicking a day opens its newest
 * item in the reader.
 */
export function ActivityGrid({
  repositoryId,
  items,
  sources,
  total,
  firstStoredAt,
  truncated,
  showHistoryLink,
}: {
  repositoryId: string;
  items: ActivityItem[];
  /** Sources the subscription tracks (the filter offers only these). */
  sources: ActivitySource[];
  total: number;
  firstStoredAt: string | null;
  truncated: boolean;
  /** Link the shallow-history note to the History section ("Load older releases"). */
  showHistoryLink: boolean;
}) {
  const router = useRouter();
  const now = useClientNow();
  const [source, setSource] = useState<ActivitySource | "ALL">("ALL");
  const scrollRef = useRef<HTMLDivElement>(null);

  const filtered = source === "ALL" ? items : items.filter((item) => item.source === source);
  const buckets = now ? bucketByLocalDay(filtered) : new Map<string, DayBucket>();
  const weeks = now ? buildWeeks(now) : [];
  const months = monthLabels(weeks);
  const thresholds = activityThresholds([...buckets.values()].map((b) => b.count));

  // Newest week in view on narrow screens.
  useLayoutEffect(() => {
    if (weeks.length === 0) return;
    const el = scrollRef.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [weeks.length]);

  const filterOptions = SOURCE_FILTERS.filter((option) => option.value === "ALL" || sources.includes(option.value));
  // "Shallow" history: the stored rows start inside the grid window, so older squares are empty for lack of data.
  const firstStored = firstStoredAt ? new Date(firstStoredAt) : null;
  const shallow = weeks.length > 0 && firstStored !== null && firstStored > weeks[0]![0]!.date;

  return (
    <div className="space-y-3">
      <div ref={scrollRef} className="overflow-x-auto pb-1">
        {now ? (
          <div className="inline-grid min-w-max grid-cols-[auto_1fr] gap-x-2 text-[10px] text-muted-foreground">
            <span />
            <div className="relative h-4" style={{ width: `${weeks.length * 13 - 3}px` }} aria-hidden>
              {months.map((month) => (
                <span
                  key={`${month.index}-${month.label}`}
                  className="absolute top-0"
                  style={{ left: `${month.index * 13}px` }}
                >
                  {month.label}
                </span>
              ))}
            </div>
            <div className="grid grid-rows-7 gap-[3px]" aria-hidden>
              {WEEKDAY_ROWS.map((row) => (
                <span key={row.key} className="h-2.5 leading-[10px]">
                  {row.label}
                </span>
              ))}
            </div>
            <div
              className="grid grid-flow-col grid-rows-7 gap-[3px]"
              role="group"
              aria-label="Updates per day over the last year"
            >
              {weeks.flatMap((week) =>
                week.map((day) => {
                  if (day.outOfRange) return <span key={day.key} className="size-2.5" aria-hidden />;
                  const bucket = buckets.get(day.key);
                  const level = levelFor(bucket?.count ?? 0, thresholds);
                  const label = describeDay(day.date, bucket);
                  return (
                    <button
                      key={day.key}
                      type="button"
                      title={label}
                      aria-label={label}
                      disabled={!bucket}
                      onClick={() => bucket && router.push(feedHref({ repositoryId }, bucket.newestId))}
                      className={cn(
                        "size-2.5 rounded-[2px] outline-hidden focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default",
                        LEVEL_CLASSES[level],
                        bucket?.hasMajor && "ring-1 ring-amber-500 ring-offset-1 ring-offset-card dark:ring-amber-400",
                      )}
                    />
                  );
                }),
              )}
            </div>
          </div>
        ) : (
          <Skeleton className="h-[106px] w-full max-w-[700px]" />
        )}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-muted-foreground">
        {filterOptions.length > 2 ? (
          <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Show updates of">
            {filterOptions.map((option) => (
              <button
                key={option.value}
                type="button"
                aria-pressed={source === option.value}
                onClick={() => setSource(option.value)}
                className={cn(
                  "rounded-full border px-2 py-0.5 transition-colors",
                  source === option.value
                    ? "border-foreground/40 bg-secondary font-medium text-foreground"
                    : "hover:bg-accent",
                )}
              >
                {option.label}
              </button>
            ))}
          </div>
        ) : (
          <span />
        )}
        <div className="flex items-center gap-1" aria-hidden>
          <span className="mr-1">Less</span>
          {LEVEL_CLASSES.map((cls) => (
            <span key={cls} className={cn("size-2.5 rounded-[2px]", cls)} />
          ))}
          <span className="ml-1">More</span>
          <span className="ml-3 inline-flex items-center gap-1">
            <span className="size-2.5 rounded-[2px] bg-muted ring-1 ring-amber-500 ring-offset-1 ring-offset-card dark:ring-amber-400" />
            Major release
          </span>
        </div>
      </div>

      {shallow || truncated ? (
        <p className="text-xs text-muted-foreground">
          {truncated
            ? `Showing the newest ${items.length.toLocaleString("en")} updates of the last year.`
            : `Based on ${total.toLocaleString("en")} stored update${total === 1 ? "" : "s"} since ${format(firstStored!, "d MMM yyyy")}.`}{" "}
          {shallow && showHistoryLink ? (
            <Link href="#history" className="font-medium text-foreground hover:underline">
              Load older releases to fill the grid.
            </Link>
          ) : null}
        </p>
      ) : null}
    </div>
  );
}

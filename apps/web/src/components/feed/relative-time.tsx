"use client";

import { useSyncExternalStore } from "react";
import { format } from "date-fns";
import { cn } from "@/lib/utils";

const emptySubscribe = () => () => {};
const getClientTrue = () => true;
const getServerFalse = () => false;

const INTL_FORMATTERS: Record<string, Intl.DateTimeFormat> = {
  PPpp: new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" }),
  PPp: new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }),
  PP: new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }),
};

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const MONTH_MS = 30 * DAY_MS;
const YEAR_MS = 365 * DAY_MS;

function formatLocal(value: Date, pattern: string): string {
  const formatter = INTL_FORMATTERS[pattern];
  return formatter ? formatter.format(value) : format(value, pattern);
}

/**
 * Zero-allocation relative time formatter matching English distance strings without invoking
 * `date-fns` `formatDistanceToNow` across dozens of feed cards per render.
 */
function formatRelativeTime(value: Date, nowMs = Date.now()): string {
  const diffMs = nowMs - value.getTime();
  const absMs = Math.abs(diffMs);
  const past = diffMs >= 0;

  let distance: string;
  if (absMs < 45_000) {
    distance = "less than a minute";
  } else if (absMs < 90_000) {
    distance = "1 minute";
  } else if (absMs < 45 * MINUTE_MS) {
    distance = `${Math.round(absMs / MINUTE_MS)} minutes`;
  } else if (absMs < 90 * MINUTE_MS) {
    distance = "about 1 hour";
  } else if (absMs < 24 * HOUR_MS) {
    distance = `about ${Math.round(absMs / HOUR_MS)} hours`;
  } else if (absMs < 42 * HOUR_MS) {
    distance = "1 day";
  } else if (absMs < MONTH_MS) {
    distance = `${Math.round(absMs / DAY_MS)} days`;
  } else if (absMs < 45 * DAY_MS) {
    distance = "about 1 month";
  } else if (absMs < YEAR_MS) {
    distance = `${Math.max(2, Math.round(absMs / MONTH_MS))} months`;
  } else if (absMs < 15 * MONTH_MS) {
    distance = "about 1 year";
  } else {
    distance = `over ${Math.max(1, Math.floor(absMs / YEAR_MS))} years`;
  }

  return past ? `${distance} ago` : `in ${distance}`;
}

function useIsClient(): boolean {
  return useSyncExternalStore(emptySubscribe, getClientTrue, getServerFalse);
}

/**
 * "3 days ago" with the exact timestamp on hover. The localized tooltip is formatted lazily on
 * hover/focus so rendering large lists triggers zero `Intl.DateTimeFormat` calls during hydration.
 */
export function RelativeTime({ date, className }: { date: Date | string; className?: string }) {
  const isClient = useIsClient();
  const value = typeof date === "string" ? new Date(date) : date;
  const iso = value.toISOString();
  const utcFallback = `${iso.slice(0, 16).replace("T", " ")} UTC`;
  const title = isClient ? formatLocal(value, "PPpp") : utcFallback;

  return (
    <time dateTime={iso} title={title} className={cn("whitespace-nowrap", className)} suppressHydrationWarning>
      {formatRelativeTime(value)}
    </time>
  );
}

/**
 * An absolute date and time ("Oct 14, 2026, 11:30 PM") in the viewer's time zone. The server
 * renders it in UTC and the client replaces it once mounted, so hydration never mismatches.
 */
export function LocalDateTime({
  date,
  pattern = "PPp",
  className,
}: {
  date: Date | string;
  pattern?: string;
  className?: string;
}) {
  const isClient = useIsClient();
  const value = typeof date === "string" ? new Date(date) : date;
  const iso = value.toISOString();
  const label = isClient ? formatLocal(value, pattern) : `${iso.slice(0, 16).replace("T", " ")} UTC`;
  return (
    <time dateTime={iso} className={cn("whitespace-nowrap", className)} suppressHydrationWarning>
      {label}
    </time>
  );
}

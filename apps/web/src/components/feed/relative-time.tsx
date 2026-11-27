"use client";

import { useSyncExternalStore } from "react";
import { format, formatDistanceToNow } from "date-fns";
import { cn } from "@/lib/utils";

const emptySubscribe = () => () => {};
const getClientTrue = () => true;
const getServerFalse = () => false;

const INTL_FORMATTERS: Record<string, Intl.DateTimeFormat> = {
  PPpp: new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" }),
  PPp: new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }),
  PP: new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }),
};

function formatLocal(value: Date, pattern: string): string {
  const formatter = INTL_FORMATTERS[pattern];
  return formatter ? formatter.format(value) : format(value, pattern);
}

function useIsClient(): boolean {
  return useSyncExternalStore(emptySubscribe, getClientTrue, getServerFalse);
}

/**
 * "3 days ago" with the exact timestamp on hover. The tooltip is formatted on the client so it
 * uses the viewer's time zone, not the server's. Server and client clocks differ by the render
 * latency, which can flip the relative label at a boundary — hence `suppressHydrationWarning`.
 */
export function RelativeTime({ date, className }: { date: Date | string; className?: string }) {
  const isClient = useIsClient();
  const value = typeof date === "string" ? new Date(date) : date;
  const iso = value.toISOString();
  const title = isClient ? formatLocal(value, "PPpp") : `${iso.slice(0, 16).replace("T", " ")} UTC`;

  return (
    <time dateTime={iso} title={title} className={cn("whitespace-nowrap", className)} suppressHydrationWarning>
      {formatDistanceToNow(value, { addSuffix: true })}
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

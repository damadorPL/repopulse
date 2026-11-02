"use client";

import { useEffect, useState } from "react";
import { format, formatDistanceToNow } from "date-fns";
import { cn } from "@/lib/utils";

/**
 * "3 days ago" with the exact timestamp on hover. The tooltip is formatted after mount so it
 * uses the viewer's time zone, not the server's. Server and client clocks differ by the render
 * latency, which can flip the relative label at a boundary — hence `suppressHydrationWarning`.
 */
export function RelativeTime({ date, className }: { date: Date | string; className?: string }) {
  const value = typeof date === "string" ? new Date(date) : date;
  const iso = value.toISOString();
  const [title, setTitle] = useState(() => `${iso.slice(0, 16).replace("T", " ")} UTC`);
  useEffect(() => setTitle(format(new Date(iso), "PPpp")), [iso]);

  return (
    <time dateTime={iso} title={title} className={cn("whitespace-nowrap", className)} suppressHydrationWarning>
      {formatDistanceToNow(value, { addSuffix: true })}
    </time>
  );
}

/**
 * An absolute date and time ("Oct 14, 2026, 11:30 PM") in the viewer's time zone. The server
 * renders it in UTC and the browser replaces it after mount, so hydration never mismatches.
 */
export function LocalDateTime({ date, pattern = "PPp", className }: { date: Date | string; pattern?: string; className?: string }) {
  const iso = (typeof date === "string" ? new Date(date) : date).toISOString();
  const [label, setLabel] = useState(() => `${iso.slice(0, 16).replace("T", " ")} UTC`);
  useEffect(() => setLabel(format(new Date(iso), pattern)), [iso, pattern]);
  return (
    <time dateTime={iso} className={cn("whitespace-nowrap", className)} suppressHydrationWarning>
      {label}
    </time>
  );
}

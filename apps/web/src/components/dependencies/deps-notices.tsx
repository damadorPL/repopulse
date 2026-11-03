import { CircleSlashIcon, TriangleAlertIcon } from "lucide-react";
import type { LevelCounts } from "@/lib/dependency-settings";
import { cn } from "@/lib/utils";

/** `/dependencies` and the project pages while Admin → Dependencies is off. */
export function DepsDisabledNotice() {
  return (
    <div className="flex flex-col items-center rounded-lg border border-dashed px-6 py-14 text-center">
      <span className="flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <CircleSlashIcon className="size-5" aria-hidden />
      </span>
      <h2 className="mt-4 font-medium">Dependency checks are turned off by the administrator</h2>
      <p className="mt-1 max-w-md text-sm text-muted-foreground">
        Your projects and their settings are kept. They are checked again once the module is turned back on in Admin → Dependencies.
      </p>
    </div>
  );
}

/** Non-blocking: the `deps-worker` heartbeat is missing, so nothing is checked right now. */
export function DepsWorkerMissingNotice() {
  return (
    <p role="status" className="flex items-start gap-2 rounded-lg border border-amber-300/60 bg-amber-500/10 px-4 py-3 text-sm text-amber-800 dark:text-amber-300">
      <TriangleAlertIcon className="mt-0.5 size-4 shrink-0" aria-hidden />
      <span>
        <span className="font-medium">Dependency checks are not running.</span> The background service that checks projects is not
        reporting. Checks you start are queued and run once it is back.
      </span>
    </p>
  );
}

const LEVEL_TONES = {
  major: "text-rose-700 dark:text-rose-300",
  minor: "text-blue-700 dark:text-blue-300",
  patch: "text-emerald-700 dark:text-emerald-300",
  other: "text-muted-foreground",
} as const;

/** `3 major · 5 minor · 2 patch`, colored by level; "Up to date" when empty. */
export function OutdatedCounts({ counts, className, emptyLabel = "Up to date" }: { counts: LevelCounts; className?: string; emptyLabel?: string }) {
  const parts = (["major", "minor", "patch", "other"] as const).filter((level) => counts[level] > 0);
  if (parts.length === 0) return <span className={cn("text-muted-foreground", className)}>{emptyLabel}</span>;
  return (
    <span className={cn("inline-flex flex-wrap items-center gap-x-1.5", className)}>
      {parts.map((level, index) => (
        <span key={level} className="inline-flex items-center gap-1.5">
          {index > 0 ? <span aria-hidden className="text-muted-foreground">·</span> : null}
          <span className={cn("tabular-nums", LEVEL_TONES[level])}>
            {counts[level]} {level}
          </span>
        </span>
      ))}
    </span>
  );
}

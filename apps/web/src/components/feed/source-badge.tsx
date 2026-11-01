import { GitCommitHorizontalIcon, TagIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/** Marks a Git tag without a GitHub Release ("Releases + tags" subscriptions, Slice 04c). */
export function TagSourceBadge({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-md border border-violet-200 bg-violet-50 px-1.5 py-0.5 text-[11px] font-medium leading-none text-violet-700",
        "dark:border-violet-500/30 dark:bg-violet-500/10 dark:text-violet-300",
        className,
      )}
      title="Git tag without a GitHub release: the notes list the commits since the previous tag"
    >
      <TagIcon className="size-3" aria-hidden />
      Tag
    </span>
  );
}

/** Marks a commit touching a watched path ("Files / folders" subscriptions, Slice 06). */
export function CommitSourceBadge({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-md border border-teal-200 bg-teal-50 px-1.5 py-0.5 text-[11px] font-medium leading-none text-teal-700",
        "dark:border-teal-500/30 dark:bg-teal-500/10 dark:text-teal-300",
        className,
      )}
      title="Commit touching one of your watched files or folders: the notes list the changed files"
    >
      <GitCommitHorizontalIcon className="size-3" aria-hidden />
      Commit
    </span>
  );
}

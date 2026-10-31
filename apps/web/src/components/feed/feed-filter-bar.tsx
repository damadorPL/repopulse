"use client";

import { useTransition, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CheckCheckIcon, XIcon } from "lucide-react";
import { toast } from "sonner";
import { useReader } from "@/components/reader/reader-context";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { feedHref, SEMVER_TYPES, type FeedFilters, type FeedSort, type SemverTypeValue } from "@/lib/feed-filters";
import { cn } from "@/lib/utils";
import { markAllReadAction } from "@/server/actions/release-state";
import { SEMVER_META } from "./semver-badge";
import { TagDot } from "./tag-pill";

const ALL = "all";

export function FeedFilterBar({
  filters,
  tag,
  repositoryName,
  unreadInView,
}: {
  filters: FeedFilters;
  /** Resolved active tag (for the chip), if `filters.tagSlug` matches one. */
  tag: { name: string; colorHex: string } | null;
  repositoryName: string | null;
  /** Whether the current view has anything to mark read (disables the button otherwise). */
  unreadInView: boolean;
}) {
  const router = useRouter();
  const { resetReadOverrides } = useReader();
  const [marking, startMarking] = useTransition();

  const go = (next: Partial<FeedFilters>) => router.push(feedHref({ ...filters, ...next }), { scroll: false });

  function markAllRead() {
    startMarking(async () => {
      const result = await markAllReadAction({
        tagSlug: filters.tagSlug,
        repositoryId: filters.repositoryId,
        semverType: filters.semverType,
        searchQuery: filters.searchQuery,
      });
      if (!result.ok) {
        toast.error(result.error.message);
        return;
      }
      resetReadOverrides();
      toast.success(
        result.data.count === 0
          ? "Nothing to mark — already caught up."
          : `Marked ${result.data.count} release${result.data.count === 1 ? "" : "s"} as read`,
      );
    });
  }

  const chips: { key: string; label: ReactNode; clear: Partial<FeedFilters> }[] = [];
  if (filters.tagSlug) {
    chips.push({
      key: "tag",
      label: (
        <>
          {tag ? <TagDot color={tag.colorHex} /> : null}
          Tag: {tag?.name ?? filters.tagSlug}
        </>
      ),
      clear: { tagSlug: undefined },
    });
  }
  if (filters.repositoryId) {
    chips.push({ key: "repo", label: <>Repo: {repositoryName ?? "unknown"}</>, clear: { repositoryId: undefined } });
  }
  if (filters.searchQuery) {
    chips.push({ key: "q", label: <>Search: “{filters.searchQuery}”</>, clear: { searchQuery: undefined } });
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div role="group" aria-label="Read status" className="inline-flex h-8 rounded-md border p-0.5">
          {[
            { label: "All", unread: false },
            { label: "Unread", unread: true },
          ].map((option) => (
            <Link
              key={option.label}
              href={feedHref({ ...filters, onlyUnread: option.unread })}
              scroll={false}
              aria-current={filters.onlyUnread === option.unread ? "true" : undefined}
              className={cn(
                "inline-flex items-center rounded px-3 text-sm text-muted-foreground transition-colors hover:text-foreground",
                filters.onlyUnread === option.unread && "bg-secondary font-medium text-foreground shadow-xs",
              )}
            >
              {option.label}
            </Link>
          ))}
        </div>

        <Select
          value={filters.semverType ?? ALL}
          onValueChange={(value) => go({ semverType: value === ALL ? undefined : (value as SemverTypeValue) })}
        >
          <SelectTrigger aria-label="Release type" className="min-w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All release types</SelectItem>
            {SEMVER_TYPES.map((type) => (
              <SelectItem key={type} value={type}>
                {SEMVER_META[type].label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={filters.sort} onValueChange={(value) => go({ sort: value as FeedSort })}>
          <SelectTrigger aria-label="Sort order" className="min-w-32">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="newest">Newest first</SelectItem>
            <SelectItem value="oldest">Oldest first</SelectItem>
          </SelectContent>
        </Select>

        <Button variant="ghost" size="sm" className="ml-auto" onClick={markAllRead} disabled={marking || !unreadInView}>
          <CheckCheckIcon />
          {marking ? "Marking…" : "Mark all as read"}
        </Button>
      </div>

      {chips.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2">
          {chips.map((chip) => (
            <Link
              key={chip.key}
              href={feedHref({ ...filters, ...chip.clear })}
              scroll={false}
              className="inline-flex max-w-full items-center gap-1.5 rounded-full border bg-secondary/60 py-0.5 pl-2.5 pr-1.5 text-xs hover:bg-secondary"
            >
              <span className="flex min-w-0 items-center gap-1.5 truncate">{chip.label}</span>
              <XIcon className="size-3 shrink-0" aria-hidden />
              <span className="sr-only">Remove filter</span>
            </Link>
          ))}
          {chips.length > 1 ? (
            <Link
              href={feedHref({ onlyUnread: filters.onlyUnread, sort: filters.sort })}
              scroll={false}
              className="text-xs text-muted-foreground hover:text-foreground hover:underline"
            >
              Clear all
            </Link>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

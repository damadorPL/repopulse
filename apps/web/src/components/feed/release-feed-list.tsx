"use client";

import { useState, useTransition, type ReactNode } from "react";
import { LoaderCircleIcon } from "lucide-react";
import { toast } from "sonner";
import { useReader } from "@/components/reader/reader-context";
import { Button } from "@/components/ui/button";
import { loadMoreReleasesAction } from "@/server/actions/feed";
import type { FeedItem, FeedPage } from "@/server/queries/feed";
import { ReleaseCard } from "./release-card";

/**
 * Renders the server-provided first page and appends further pages via a Server Action.
 * The parent keys this component by the filter string, so a filter change starts fresh;
 * re-renders with the same filters (e.g. after marking a release read) refresh page one
 * in place and keep the appended pages.
 */
export function ReleaseFeedList({
  initialPage,
  query,
  emptyState,
}: {
  initialPage: FeedPage;
  /** Filter query string, forwarded to `loadMoreReleasesAction`. */
  query: string;
  emptyState: ReactNode;
}) {
  const { selectedId, openRelease, isRead, readEpoch } = useReader();
  // Appended pages; discarded after a bulk read change (their read flags would be stale).
  const [extra, setExtra] = useState<{ epoch: number; items: FeedItem[]; cursor: string | null | undefined }>({
    epoch: readEpoch,
    items: [],
    cursor: undefined,
  });
  const current = extra.epoch === readEpoch ? extra : { epoch: readEpoch, items: [], cursor: undefined };
  const extraItems = current.items;
  const extraCursor = current.cursor;
  const [loading, startLoading] = useTransition();

  // `undefined` = nothing appended yet → follow page one's cursor.
  const nextCursor = extraCursor === undefined ? initialPage.nextCursor : extraCursor;

  const seen = new Set<string>();
  const items = [...initialPage.items, ...extraItems].filter((item) => !seen.has(item.id) && seen.add(item.id));

  function loadMore() {
    if (!nextCursor) return;
    startLoading(async () => {
      const result = await loadMoreReleasesAction({ query, cursor: nextCursor });
      if (!result.ok) {
        toast.error(result.error.message);
        return;
      }
      setExtra((prev) => ({
        epoch: readEpoch,
        items: [...(prev.epoch === readEpoch ? prev.items : []), ...result.data.items],
        cursor: result.data.nextCursor,
      }));
    });
  }

  if (items.length === 0) return <>{emptyState}</>;

  return (
    <div className="space-y-2">
      <ul className="space-y-2" aria-label="Releases">
        {items.map((item) => (
          <li key={item.id}>
            <ReleaseCard item={item} isRead={isRead(item)} isActive={item.id === selectedId} onOpen={openRelease} />
          </li>
        ))}
      </ul>
      {nextCursor ? (
        <div className="flex justify-center pt-2">
          <Button variant="outline" onClick={loadMore} disabled={loading}>
            {loading ? <LoaderCircleIcon className="animate-spin" /> : null}
            {loading ? "Loading…" : "Load more"}
          </Button>
        </div>
      ) : items.length > 10 ? (
        <p className="pt-2 text-center text-xs text-muted-foreground">You&apos;re all caught up — that&apos;s every release.</p>
      ) : null}
    </div>
  );
}

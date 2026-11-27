"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { Route } from "next";
import { usePathname, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { useOptionalUnread } from "@/components/layout/unread-context";
import { PARAM } from "@/lib/feed-filters";
import { getReleaseDrawerAction } from "@/server/actions/feed";
import { toggleReleaseReadAction } from "@/server/actions/release-state";
import type { FeedItem } from "@/server/queries/feed";

const MAX_CLIENT_DRAWER_CACHE = 30;

export interface DrawerEntry {
  detail: FeedItem;
  content: ReactNode;
}

/**
 * Client state shared by the feed list and the changelog drawer.
 *
 * The open release lives in the URL (`?release=<id>`). Direct page loads SSR the sanitized
 * changelog; clicking a card updates the URL shallowly (`history.pushState`) and loads the
 * sanitized HTML via a lightweight Server Action without re-rendering the full dashboard page.
 *
 * Read state is updated optimistically: `readOverrides` and `UnreadProvider` update immediately
 * without triggering a full-layout `router.refresh()`.
 */
interface ReaderContextValue {
  selectedId: string | null;
  preview: FeedItem | null;
  loadedEntry: DrawerEntry | null;
  isLoadingDetail: boolean;
  openRelease: (item: FeedItem) => void;
  closeRelease: () => void;
  isRead: (item: { id: string; isRead: boolean }) => boolean;
  setRead: (releaseId: string, isRead: boolean, item?: FeedItem) => Promise<boolean>;
  resetReadOverrides: () => void;
  /** Bumped by `resetReadOverrides` (bulk read change) so lists can drop stale appended pages. */
  readEpoch: number;
}

const ReaderContext = createContext<ReaderContextValue | null>(null);

export function ReaderProvider({
  children,
  initialDetail = null,
}: {
  children: ReactNode;
  initialDetail?: FeedItem | null;
}) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const urlReleaseId = searchParams.get(PARAM.release);
  const unread = useOptionalUnread();

  const [preview, setPreview] = useState<FeedItem | null>(null);
  const [loadedEntries, setLoadedEntries] = useState<Record<string, DrawerEntry>>({});
  const [failedIds, setFailedIds] = useState<Record<string, boolean>>({});
  const [readOverrides, setReadOverrides] = useState<Record<string, boolean>>({});
  const [readEpoch, setReadEpoch] = useState(0);

  const selectedId = urlReleaseId;
  const hasSsrDetail = Boolean(selectedId && initialDetail?.id === selectedId);
  const loadedEntry = selectedId ? (loadedEntries[selectedId] ?? null) : null;
  const hasFailed = Boolean(selectedId && failedIds[selectedId]);
  const isLoadingDetail = Boolean(selectedId && !hasSsrDetail && !loadedEntry && !hasFailed);

  useEffect(() => {
    if (!selectedId || hasSsrDetail || loadedEntry || hasFailed) return;
    let cancelled = false;

    void getReleaseDrawerAction({ releaseId: selectedId }).then((result) => {
      if (cancelled) return;
      if (!result.ok) {
        setFailedIds((current) => ({ ...current, [selectedId]: true }));
        if (result.error.code !== "NOT_FOUND") {
          toast.error(result.error.message);
        }
        return;
      }
      setLoadedEntries((current) => {
        const keys = Object.keys(current);
        const next = { ...current, [selectedId]: result.data };
        if (keys.length >= MAX_CLIENT_DRAWER_CACHE) {
          const oldest = keys[0];
          if (oldest && oldest !== selectedId) delete next[oldest];
        }
        return next;
      });
    });

    return () => {
      cancelled = true;
    };
  }, [selectedId, hasSsrDetail, loadedEntry, hasFailed]);

  function hrefWithRelease(releaseId: string | null): Route {
    const params = new URLSearchParams(searchParams.toString());
    if (releaseId) params.set(PARAM.release, releaseId);
    else params.delete(PARAM.release);
    const query = params.toString();
    return (query ? `${pathname}?${query}` : pathname) as Route;
  }

  function openRelease(item: FeedItem) {
    setPreview(item);
    window.history.pushState(null, "", hrefWithRelease(item.id));
  }

  function closeRelease() {
    window.history.pushState(null, "", hrefWithRelease(null));
  }

  function isRead(item: { id: string; isRead: boolean }) {
    return readOverrides[item.id] ?? item.isRead;
  }

  async function setRead(releaseId: string, nextIsRead: boolean, item?: FeedItem) {
    const targetItem =
      item ??
      (preview?.id === releaseId ? preview : undefined) ??
      loadedEntries[releaseId]?.detail ??
      (initialDetail?.id === releaseId ? initialDetail : undefined);

    const previous = readOverrides[releaseId];
    const wasRead = previous ?? targetItem?.isRead ?? nextIsRead;
    const changed = wasRead !== nextIsRead;
    setReadOverrides((current) => ({ ...current, [releaseId]: nextIsRead }));

    if (targetItem && changed) {
      unread?.adjustUnread(targetItem, nextIsRead ? -1 : 1);
    }

    const result = await toggleReleaseReadAction({ releaseId, isRead: nextIsRead, skipRevalidate: true });
    if (!result.ok) {
      setReadOverrides((current) => {
        const next = { ...current };
        if (previous === undefined) delete next[releaseId];
        else next[releaseId] = previous;
        return next;
      });
      if (targetItem && changed) {
        unread?.adjustUnread(targetItem, nextIsRead ? 1 : -1);
      }
      toast.error(result.error.message);
      return false;
    }
    return true;
  }

  function resetReadOverrides() {
    setReadOverrides({});
    setLoadedEntries({});
    setReadEpoch((epoch) => epoch + 1);
  }

  const value: ReaderContextValue = {
    selectedId,
    preview,
    loadedEntry,
    isLoadingDetail,
    openRelease,
    closeRelease,
    isRead,
    setRead,
    resetReadOverrides,
    readEpoch,
  };

  return <ReaderContext value={value}>{children}</ReaderContext>;
}

export function useReader(): ReaderContextValue {
  const value = useContext(ReaderContext);
  if (!value) throw new Error("useReader must be used inside <ReaderProvider>");
  return value;
}

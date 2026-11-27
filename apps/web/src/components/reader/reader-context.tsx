"use client";

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import type { Route } from "next";
import { useSearchParams } from "next/navigation";
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

function currentHrefWithRelease(releaseId: string | null): Route {
  const params = new URLSearchParams(window.location.search);
  if (releaseId) params.set(PARAM.release, releaseId);
  else params.delete(PARAM.release);
  const query = params.toString();
  return (query ? `${window.location.pathname}?${query}` : window.location.pathname) as Route;
}

/**
 * Client state shared by the feed list and the changelog drawer, split into list vs drawer slices so
 * async drawer loads (`preview`, `loadedEntry`, `isLoadingDetail`) do not re-render `ReleaseFeedList`
 * or unrelated `ReleaseCard` rows.
 */
interface ReaderListContextValue {
  selectedId: string | null;
  openRelease: (item: FeedItem) => void;
  isRead: (item: { id: string; isRead: boolean }) => boolean;
  resetReadOverrides: () => void;
  /** Bumped by `resetReadOverrides` (bulk read change) so lists can drop stale appended pages. */
  readEpoch: number;
}

interface ReaderDrawerContextValue {
  preview: FeedItem | null;
  loadedEntry: DrawerEntry | null;
  isLoadingDetail: boolean;
  closeRelease: () => void;
  setRead: (releaseId: string, isRead: boolean, item?: FeedItem) => Promise<boolean>;
}

const ReaderListContext = createContext<ReaderListContextValue | null>(null);
const ReaderDrawerContext = createContext<ReaderDrawerContextValue | null>(null);

export function ReaderProvider({
  children,
  initialDetail = null,
}: {
  children: ReactNode;
  initialDetail?: FeedItem | null;
}) {
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

  const openRelease = useCallback((item: FeedItem) => {
    setPreview(item);
    window.history.pushState(null, "", currentHrefWithRelease(item.id));
  }, []);

  const closeRelease = useCallback(() => {
    window.history.pushState(null, "", currentHrefWithRelease(null));
  }, []);

  const isRead = useCallback(
    (item: { id: string; isRead: boolean }) => readOverrides[item.id] ?? item.isRead,
    [readOverrides],
  );

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

  const resetReadOverrides = useCallback(() => {
    setReadOverrides({});
    setLoadedEntries({});
    setReadEpoch((epoch) => epoch + 1);
  }, []);

  const listValue: ReaderListContextValue = {
    selectedId,
    openRelease,
    isRead,
    resetReadOverrides,
    readEpoch,
  };

  const drawerValue: ReaderDrawerContextValue = {
    preview,
    loadedEntry,
    isLoadingDetail,
    closeRelease,
    setRead,
  };

  return (
    <ReaderListContext value={listValue}>
      <ReaderDrawerContext value={drawerValue}>{children}</ReaderDrawerContext>
    </ReaderListContext>
  );
}

export function useReaderList(): ReaderListContextValue {
  const value = useContext(ReaderListContext);
  if (!value) throw new Error("useReaderList must be used inside <ReaderProvider>");
  return value;
}

export function useReaderDrawer(): ReaderDrawerContextValue {
  const value = useContext(ReaderDrawerContext);
  if (!value) throw new Error("useReaderDrawer must be used inside <ReaderProvider>");
  return value;
}

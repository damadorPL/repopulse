"use client";

import type { Route } from "next";
import { useSearchParams } from "next/navigation";
import { createContext, useContext, useState, type ReactNode } from "react";
import { toast } from "sonner";

import { useOptionalUnread } from "@/components/layout/unread-context";
import { PARAM } from "@/lib/feed-filters";
import { versionTagCandidates } from "@/lib/version-compare";
import type { ActionResult } from "@/server/action-result";
import { getReleaseDrawerAction } from "@/server/actions/feed";
import { toggleReleaseReadAction } from "@/server/actions/release-state";
import type { FeedItem } from "@/server/queries/feed";

const MAX_CLIENT_DRAWER_CACHE = 30;

export interface DrawerEntry {
  detail: FeedItem;
  content: ReactNode;
}

const drawerPromiseCache = new Map<string, Promise<ActionResult<DrawerEntry>>>();
const resolvedDrawerDetails = new Map<string, FeedItem>();

function getOrFetchDrawerEntry(releaseId: string): Promise<ActionResult<DrawerEntry>> {
  const existing = drawerPromiseCache.get(releaseId);
  if (existing) {
    drawerPromiseCache.delete(releaseId);
    drawerPromiseCache.set(releaseId, existing);
    return existing;
  }

  const promise = getReleaseDrawerAction({ releaseId }).then(
    (result) => {
      if (result.ok) {
        resolvedDrawerDetails.set(releaseId, result.data.detail);
      } else if (result.error.code !== "NOT_FOUND") {
        toast.error(result.error.message);
      }
      return result;
    },
    () => {
      const message = "Could not load release notes.";
      toast.error(message);
      return { ok: false as const, error: { code: "INTERNAL" as const, message } };
    },
  );

  drawerPromiseCache.set(releaseId, promise);
  if (drawerPromiseCache.size > MAX_CLIENT_DRAWER_CACHE) {
    const oldest = drawerPromiseCache.keys().next().value;
    if (oldest !== undefined) {
      drawerPromiseCache.delete(oldest);
      resolvedDrawerDetails.delete(oldest);
    }
  }
  return promise;
}

function currentHrefWithRelease(releaseId: string | null): Route {
  const params = new URLSearchParams(window.location.search);
  if (releaseId) params.set(PARAM.release, releaseId);
  else params.delete(PARAM.release);
  const query = params.toString();
  return (query ? `${window.location.pathname}?${query}` : window.location.pathname) as Route;
}

function closeRelease() {
  window.history.pushState(null, "", currentHrefWithRelease(null));
}

/**
 * Client state shared by the feed list and the changelog drawer, split into list vs drawer slices so
 * async drawer state does not re-render `ReleaseFeedList` or unrelated `ReleaseCard` rows.
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
  getEntryPromise: (releaseId: string) => Promise<ActionResult<DrawerEntry>>;
  closeRelease: () => void;
  setRead: (releaseId: string, isRead: boolean, item?: FeedItem) => Promise<boolean>;
  clearDrawerCache: (patch?: { repositoryId: string; currentVersion: string | null }) => void;
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
  const [readOverrides, setReadOverrides] = useState<Record<string, boolean>>({});
  const [readEpoch, setReadEpoch] = useState(0);

  const selectedId = urlReleaseId;

  function openRelease(item: FeedItem) {
    void getOrFetchDrawerEntry(item.id);
    setPreview(item);
    window.history.pushState(null, "", currentHrefWithRelease(item.id));
  }

  function isRead(item: { id: string; isRead: boolean }) {
    return readOverrides[item.id] ?? item.isRead;
  }

  async function setRead(releaseId: string, nextIsRead: boolean, item?: FeedItem) {
    const targetItem =
      item ??
      (preview?.id === releaseId ? preview : undefined) ??
      resolvedDrawerDetails.get(releaseId) ??
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

  function clearDrawerCache(patch?: { repositoryId: string; currentVersion: string | null }) {
    drawerPromiseCache.clear();
    resolvedDrawerDetails.clear();
    if (!patch) return;
    setPreview((current) => {
      if (!current || current.repository.id !== patch.repositoryId) return current;
      const candidates = patch.currentVersion ? versionTagCandidates(patch.currentVersion) : [];
      const isMyVersion = current.source !== "COMMIT" && candidates.includes(current.tagName);
      return {
        ...current,
        isMyVersion,
        newerThanMine: isMyVersion ? false : patch.currentVersion === null ? false : current.newerThanMine,
      };
    });
  }

  function resetReadOverrides() {
    clearDrawerCache();
    setReadOverrides({});
    setReadEpoch((epoch) => epoch + 1);
  }

  const listValue: ReaderListContextValue = {
    selectedId,
    openRelease,
    isRead,
    resetReadOverrides,
    readEpoch,
  };

  const drawerValue: ReaderDrawerContextValue = {
    preview,
    getEntryPromise: getOrFetchDrawerEntry,
    closeRelease,
    setRead,
    clearDrawerCache,
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

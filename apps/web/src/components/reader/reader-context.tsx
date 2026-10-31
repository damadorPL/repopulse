"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useOptimistic,
  useState,
  useTransition,
  type ReactNode,
} from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { PARAM } from "@/lib/feed-filters";
import { toggleReleaseReadAction } from "@/server/actions/release-state";
import type { FeedItem } from "@/server/queries/feed";

/**
 * Client state shared by the feed list and the changelog drawer.
 *
 * The open release lives in the URL (`?release=<id>`), so the drawer is server-rendered with
 * the sanitized changelog and is linkable / back-button friendly. While the navigation is in
 * flight, `useOptimistic` opens the drawer immediately with the card's data as a preview.
 *
 * Read state is updated optimistically: `readOverrides` wins over server data until the next
 * bulk change ("mark all read" clears it). The Server Actions revalidate the layout, which
 * refreshes the sidebar / navbar unread counters.
 */
interface ReaderContextValue {
  selectedId: string | null;
  preview: FeedItem | null;
  isNavigating: boolean;
  openRelease: (item: FeedItem) => void;
  closeRelease: () => void;
  isRead: (item: { id: string; isRead: boolean }) => boolean;
  setRead: (releaseId: string, isRead: boolean) => Promise<boolean>;
  resetReadOverrides: () => void;
  /** Bumped by `resetReadOverrides` (bulk read change) so lists can drop stale appended pages. */
  readEpoch: number;
}

const ReaderContext = createContext<ReaderContextValue | null>(null);

export function ReaderProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const urlReleaseId = searchParams.get(PARAM.release);

  const [isNavigating, startTransition] = useTransition();
  const [selectedId, setSelectedId] = useOptimistic<string | null>(urlReleaseId);
  const [preview, setPreview] = useState<FeedItem | null>(null);
  const [readOverrides, setReadOverrides] = useState<Record<string, boolean>>({});
  const [readEpoch, setReadEpoch] = useState(0);

  const hrefWithRelease = useCallback(
    (releaseId: string | null) => {
      const params = new URLSearchParams(searchParams.toString());
      if (releaseId) params.set(PARAM.release, releaseId);
      else params.delete(PARAM.release);
      const query = params.toString();
      return query ? `${pathname}?${query}` : pathname;
    },
    [pathname, searchParams],
  );

  const openRelease = useCallback(
    (item: FeedItem) => {
      setPreview(item);
      startTransition(() => {
        setSelectedId(item.id);
        router.push(hrefWithRelease(item.id), { scroll: false });
      });
    },
    [hrefWithRelease, router, setSelectedId],
  );

  const closeRelease = useCallback(() => {
    startTransition(() => {
      setSelectedId(null);
      router.push(hrefWithRelease(null), { scroll: false });
    });
  }, [hrefWithRelease, router, setSelectedId]);

  const isRead = useCallback(
    (item: { id: string; isRead: boolean }) => readOverrides[item.id] ?? item.isRead,
    [readOverrides],
  );

  const setRead = useCallback(async (releaseId: string, nextIsRead: boolean) => {
    let previous: boolean | undefined;
    setReadOverrides((current) => {
      previous = current[releaseId];
      return { ...current, [releaseId]: nextIsRead };
    });
    const result = await toggleReleaseReadAction({ releaseId, isRead: nextIsRead });
    if (!result.ok) {
      setReadOverrides((current) => {
        const next = { ...current };
        if (previous === undefined) delete next[releaseId];
        else next[releaseId] = previous;
        return next;
      });
      toast.error(result.error.message);
      return false;
    }
    return true;
  }, []);

  const resetReadOverrides = useCallback(() => {
    setReadOverrides({});
    setReadEpoch((epoch) => epoch + 1);
  }, []);

  const value = useMemo<ReaderContextValue>(
    () => ({ selectedId, preview, isNavigating, openRelease, closeRelease, isRead, setRead, resetReadOverrides, readEpoch }),
    [selectedId, preview, isNavigating, openRelease, closeRelease, isRead, setRead, resetReadOverrides, readEpoch],
  );

  return <ReaderContext.Provider value={value}>{children}</ReaderContext.Provider>;
}

export function useReader(): ReaderContextValue {
  const value = useContext(ReaderContext);
  if (!value) throw new Error("useReader must be used inside <ReaderProvider>");
  return value;
}

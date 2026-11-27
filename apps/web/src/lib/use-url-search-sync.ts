"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { createUrlSearchSyncState, reconcileUrlSearchQuery, type UrlSearchSyncState } from "@/lib/url-search";

/**
 * Keeps a search input synchronized with URL query changes made externally (back/forward,
 * "Clear" links) while ignoring in-flight navigations triggered by the input itself.
 */
export function useUrlSearchSync(urlQuery: string) {
  const [syncState, setSyncState] = useState<UrlSearchSyncState>(() => createUrlSearchSyncState(urlQuery));
  const [value, setValue] = useState(urlQuery);
  const [resetNonce, setResetNonce] = useState(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  if (urlQuery !== syncState.lastUrlQuery) {
    const nextSync: UrlSearchSyncState = {
      lastUrlQuery: syncState.lastUrlQuery,
      pendingPushes: [...syncState.pendingPushes],
    };
    const shouldReset = reconcileUrlSearchQuery(nextSync, urlQuery);
    setSyncState(nextSync);
    if (shouldReset) {
      setValue(urlQuery);
      setResetNonce((n) => n + 1);
    }
  }

  useLayoutEffect(() => {
    if (resetNonce > 0) {
      clearTimeout(timerRef.current);
    }
  }, [resetNonce]);

  useEffect(() => () => clearTimeout(timerRef.current), []);

  function recordPush(rawQuery: string): string {
    const trimmed = rawQuery.trim();
    setSyncState((prev) => {
      const expected = prev.pendingPushes.at(-1) ?? prev.lastUrlQuery;
      if (trimmed === expected) return prev;
      return {
        lastUrlQuery: prev.lastUrlQuery,
        pendingPushes: [...prev.pendingPushes, trimmed],
      };
    });
    return trimmed;
  }

  function schedulePush(delayMs: number, fn: () => void) {
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(fn, delayMs);
  }

  function cancelPush() {
    clearTimeout(timerRef.current);
  }

  return { value, setValue, recordPush, schedulePush, cancelPush };
}

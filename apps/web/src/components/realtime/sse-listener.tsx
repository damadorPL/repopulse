"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { parseRealtimeEvent, type RealtimeEvent } from "@repopulse/queue/events";
import { feedHref } from "@/lib/feed-filters";

type NewReleaseEvent = Extract<RealtimeEvent, { type: "NEW_RELEASE" }>;

/** NEW_RELEASE events arriving within this window are shown as one toast and one refresh. */
const BATCH_WINDOW_MS = 500;

/** Toast id shared with `SyncRepoButton`, so the outcome replaces the "Syncing…" toast. */
export function syncToastId(repositoryId: string): string {
  return `sync-${repositoryId}`;
}

/**
 * Subscribes to `/api/events/stream` and keeps the dashboard live: toasts for new releases and
 * manual-sync outcomes, a quiet refresh after a history backfill, plus `router.refresh()` so the server-rendered feed, sidebar and unread
 * counters update without a page reload. EventSource reconnects on its own; after a reconnect
 * the page refreshes once, since events sent while disconnected are lost.
 */
export function SseListener() {
  // Stable across renders in the App Router, so the stream is opened once per mount.
  const router = useRouter();

  useEffect(() => {
    if (typeof EventSource === "undefined") return;

    const source = new EventSource("/api/events/stream");
    let pending: NewReleaseEvent[] = [];
    let flushTimer: ReturnType<typeof setTimeout> | undefined;
    let hasConnected = false;

    const refresh = () => router.refresh();

    const flushReleases = () => {
      flushTimer = undefined;
      const releases = pending;
      pending = [];
      if (releases.length === 0) return;

      const [first] = releases;
      if (releases.length === 1 && first) {
        toast(`New release: ${first.repositoryName} ${first.tagName}`, {
          action: { label: "Open", onClick: () => router.push(feedHref({}, first.releaseId)) },
        });
      } else {
        const repositories = [...new Set(releases.map((r) => r.repositoryName))];
        toast(`${releases.length} new releases`, {
          description: repositories.length <= 3 ? repositories.join(", ") : `${repositories.slice(0, 3).join(", ")} and ${repositories.length - 3} more`,
        });
      }
      refresh();
    };

    const handle = (event: RealtimeEvent) => {
      switch (event.type) {
        case "NEW_RELEASE":
          pending.push(event);
          flushTimer ??= setTimeout(flushReleases, BATCH_WINDOW_MS);
          break;
        case "SYNC_STARTED":
          toast.loading(`Syncing ${event.repositoryName}…`, { id: syncToastId(event.repositoryId) });
          break;
        case "SYNC_COMPLETED": {
          const id = syncToastId(event.repositoryId);
          if (event.newReleases > 0) {
            toast.success(`${event.newReleases} new release${event.newReleases === 1 ? "" : "s"} in ${event.repositoryName}`, { id });
          } else {
            toast.success(`${event.repositoryName} is up to date`, { id });
          }
          refresh();
          break;
        }
        case "SYNC_FAILED": {
          const id = syncToastId(event.repositoryId);
          if (event.reason === "RATE_LIMITED") toast.warning(event.message, { id });
          else toast.error(event.message, { id });
          refresh();
          break;
        }
        case "HISTORY_BACKFILLED":
          // History is stored as read: update the page (status line, "Load more") without a toast.
          refresh();
          break;
      }
    };

    source.onopen = () => {
      if (hasConnected) refresh();
      hasConnected = true;
    };
    source.onmessage = (message: MessageEvent<string>) => {
      const event = parseRealtimeEvent(message.data);
      if (event) handle(event);
    };

    return () => {
      source.close();
      if (flushTimer) clearTimeout(flushTimer);
    };
  }, [router]);

  return null;
}

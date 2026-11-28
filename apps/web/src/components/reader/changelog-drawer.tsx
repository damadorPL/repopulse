"use client";

import { CircleDotIcon, ExternalLinkIcon, MailOpenIcon } from "lucide-react";
import Link from "next/link";
import { Suspense, use, useEffect, useEffectEvent, useRef, useTransition, type ReactNode } from "react";
import { browser } from "react-dom";

import { RelativeTime } from "@/components/feed/relative-time";
import { RepoAvatar } from "@/components/feed/repo-avatar";
import { SemverBadge } from "@/components/feed/semver-badge";
import { CommitSourceBadge, TagSourceBadge } from "@/components/feed/source-badge";
import { TagPill } from "@/components/feed/tag-pill";
import { SetMyVersionButton } from "@/components/repositories/set-my-version-button";
import { SyncRepoButton } from "@/components/repositories/sync-repo-button";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { feedHref } from "@/lib/feed-filters";
import type { FeedItem } from "@/server/queries/feed";

import { useReaderDrawer, useReaderList } from "./reader-context";

const CLIENT_DRAWER_FETCH = browser("Changelog drawer loads release details on the client");

function publishedVerb(source: FeedItem["source"]): string {
  if (source === "TAG") return "Tagged";
  if (source === "COMMIT") return "Committed";
  return "Published";
}

function useAutoMarkRead(item: FeedItem) {
  const { isRead } = useReaderList();
  const { setRead } = useReaderDrawer();
  // Auto-mark as read once per open (not again after "Mark as unread" while the drawer stays
  // open). Unmounting when the drawer closes resets this, so reopening marks it read again.
  const autoMarked = useRef(new Set<string>());
  const markReadOnOpen = useEffectEvent((target: FeedItem) => {
    if (autoMarked.current.has(target.id)) return;
    autoMarked.current.add(target.id);
    if (!isRead(target)) void setRead(target.id, true, target);
  });

  useEffect(() => {
    markReadOnOpen(item);
  }, [item]);
}

function DrawerHeader({
  item,
  read,
  toggling,
  onToggleRead,
  onVersionChange,
}: {
  item: FeedItem;
  read: boolean;
  toggling: boolean;
  onToggleRead: () => void;
  onVersionChange: (currentVersion: string | null) => void;
}) {
  return (
    <header className="border-b px-5 pt-5 pr-12 pb-4">
      <div className="flex items-center gap-3">
        <RepoAvatar src={item.repository.avatarUrl} name={item.repository.name} className="size-8" />
        <div className="min-w-0 text-sm">
          <Link
            href={feedHref({ repositoryId: item.repository.id })}
            prefetch={false}
            className="block truncate font-medium hover:underline"
          >
            {item.repository.fullName}
          </Link>
          <span className="text-xs text-muted-foreground">
            {publishedVerb(item.source)} <RelativeTime date={item.publishedAt} />
          </span>
        </div>
      </div>

      <SheetTitle className="mt-4 text-xl/tight wrap-break-word">{item.title}</SheetTitle>
      <SheetDescription asChild>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <code className="rounded-sm bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">{item.tagName}</code>
          {item.source === "TAG" ? <TagSourceBadge /> : null}
          {item.source === "COMMIT" ? <CommitSourceBadge /> : <SemverBadge type={item.semverType} />}
          {item.isPrerelease && item.semverType !== "PRERELEASE" ? <SemverBadge type="PRERELEASE" /> : null}
          {item.tags.map((tag) => (
            <TagPill key={tag.id} name={tag.name} colorHex={tag.colorHex} />
          ))}
        </div>
      </SheetDescription>

      <div className="mt-4 flex flex-wrap gap-2">
        <Button asChild size="sm">
          <a href={item.htmlUrl} target="_blank" rel="noopener noreferrer">
            <ExternalLinkIcon />
            View on GitHub
          </a>
        </Button>
        <Button variant="outline" size="sm" onClick={onToggleRead} disabled={toggling}>
          {read ? <CircleDotIcon className="text-unread" /> : <MailOpenIcon />}
          {read ? "Mark as unread" : "Mark as read"}
        </Button>
        <SyncRepoButton repositoryId={item.repository.id} label="Sync repo now" />
        {item.source !== "COMMIT" && item.subscriptionId ? (
          <SetMyVersionButton
            // Reset the optimistic state when another release opens.
            key={item.id}
            subscriptionId={item.subscriptionId}
            fullName={item.repository.fullName}
            tagName={item.tagName}
            isMyVersion={item.isMyVersion}
            onVersionChange={onVersionChange}
          />
        ) : null}
      </div>
    </header>
  );
}

function LoadedDrawerView({ item, body }: { item: FeedItem; body: ReactNode }) {
  const { isRead } = useReaderList();
  const { setRead, clearDrawerCache } = useReaderDrawer();
  const [toggling, startToggle] = useTransition();
  const read = isRead(item);

  useAutoMarkRead(item);

  function toggleRead() {
    startToggle(async () => {
      await setRead(item.id, !read, item);
    });
  }

  return (
    <>
      <DrawerHeader
        item={item}
        read={read}
        toggling={toggling}
        onToggleRead={toggleRead}
        onVersionChange={(nextVersion) =>
          clearDrawerCache({ repositoryId: item.repository.id, currentVersion: nextVersion })
        }
      />
      <div className="flex-1 overflow-y-auto p-5">{body}</div>
    </>
  );
}

function LoadingDrawerState() {
  return (
    <div className="p-6">
      <SheetTitle className="sr-only">Loading release</SheetTitle>
      <BodySkeleton />
    </div>
  );
}

function AsyncDrawerBody({ releaseId }: { releaseId: string }) {
  use(CLIENT_DRAWER_FETCH);
  const { getEntryPromise } = useReaderDrawer();
  const result = use(getEntryPromise(releaseId));
  if (!result.ok) {
    return <p className="text-sm text-muted-foreground">{result.error.message}</p>;
  }
  return result.data.content;
}

function AsyncDrawerSheet({ releaseId }: { releaseId: string }) {
  use(CLIENT_DRAWER_FETCH);
  const { getEntryPromise } = useReaderDrawer();
  const result = use(getEntryPromise(releaseId));
  if (!result.ok) {
    return (
      <div className="p-6">
        <SheetTitle>Release not found</SheetTitle>
        <p className="mt-2 text-sm text-muted-foreground">
          It may belong to a repository you no longer track, or be a pre-release hidden by your settings.
        </p>
      </div>
    );
  }
  return <LoadedDrawerView item={result.data.detail} body={result.data.content} />;
}

function DrawerSlot({
  selectedId,
  detail,
  preview,
  children,
}: {
  selectedId: string | null;
  detail: FeedItem | null;
  preview: FeedItem | null;
  children: ReactNode;
}) {
  if (selectedId === null) return <LoadingDrawerState />;
  if (detail?.id === selectedId) return <LoadedDrawerView item={detail} body={children} />;
  if (preview?.id === selectedId) {
    return (
      <LoadedDrawerView
        item={preview}
        body={
          <Suspense fallback={<BodySkeleton />}>
            <AsyncDrawerBody releaseId={selectedId} />
          </Suspense>
        }
      />
    );
  }
  return (
    <Suspense fallback={<LoadingDrawerState />}>
      <AsyncDrawerSheet releaseId={selectedId} />
    </Suspense>
  );
}

/**
 * Slide-over changelog reader. `detail` + `children` (the sanitized markdown, rendered on the
 * server) arrive with the `?release=` navigation; client clicks stream via `use()` + `<Suspense>`.
 */
export function ChangelogDrawer({ detail, children }: { detail: FeedItem | null; children?: ReactNode }) {
  const { selectedId } = useReaderList();
  const { preview, closeRelease } = useReaderDrawer();

  return (
    <Sheet open={selectedId !== null} onOpenChange={(open) => (open ? undefined : closeRelease())}>
      <SheetContent side="right" className="w-full gap-0 p-0 sm:max-w-2xl lg:max-w-3xl" aria-describedby={undefined}>
        <DrawerSlot selectedId={selectedId} detail={detail} preview={preview}>
          {children}
        </DrawerSlot>
      </SheetContent>
    </Sheet>
  );
}

function BodySkeleton() {
  return (
    <div className="space-y-3" aria-busy="true" aria-label="Loading release notes">
      <Skeleton className="h-5 w-2/5" />
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-11/12" />
      <Skeleton className="h-4 w-4/5" />
      <Skeleton className="mt-6 h-5 w-1/3" />
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-3/4" />
      <Skeleton className="h-24 w-full" />
    </div>
  );
}

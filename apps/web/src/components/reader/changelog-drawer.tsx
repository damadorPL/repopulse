"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { CircleDotIcon, ExternalLinkIcon, MailOpenIcon } from "lucide-react";
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
import { useReader } from "./reader-context";

/**
 * Slide-over changelog reader. `detail` + `children` (the sanitized markdown, rendered on the
 * server) arrive with the `?release=` navigation; until then the card's data is shown as a
 * preview with a skeleton body.
 */
export function ChangelogDrawer({ detail, children }: { detail: FeedItem | null; children?: ReactNode }) {
  const { selectedId, preview, isNavigating, closeRelease, isRead, setRead } = useReader();

  const loaded = detail !== null && detail.id === selectedId;
  const current: FeedItem | null = loaded ? detail : preview?.id === selectedId ? preview : null;
  const notFound = selectedId !== null && !current && !isNavigating;
  const read = current ? isRead(current) : true;

  // Auto-mark as read once per open (not again after "Mark as unread" while the drawer stays
  // open). Closing the drawer resets this, so reopening the release marks it read again.
  const autoMarked = useRef(new Set<string>());
  useEffect(() => {
    if (selectedId === null) autoMarked.current.clear();
  }, [selectedId]);
  useEffect(() => {
    if (!current || autoMarked.current.has(current.id)) return;
    autoMarked.current.add(current.id);
    if (!isRead(current)) void setRead(current.id, true);
  }, [current, isRead, setRead]);

  const [toggling, setToggling] = useState(false);
  async function toggleRead() {
    if (!current) return;
    setToggling(true);
    await setRead(current.id, !read);
    setToggling(false);
  }

  return (
    <Sheet open={selectedId !== null} onOpenChange={(open) => (open ? undefined : closeRelease())}>
      <SheetContent side="right" className="w-full gap-0 p-0 sm:max-w-2xl lg:max-w-3xl" aria-describedby={undefined}>
        {current ? (
          <>
            <header className="border-b px-5 pb-4 pt-5 pr-12">
              <div className="flex items-center gap-3">
                <RepoAvatar src={current.repository.avatarUrl} name={current.repository.name} className="size-8" />
                <div className="min-w-0 text-sm">
                  <Link
                    href={feedHref({ repositoryId: current.repository.id })}
                    className="block truncate font-medium hover:underline"
                  >
                    {current.repository.fullName}
                  </Link>
                  <span className="text-xs text-muted-foreground">
                    {current.source === "TAG" ? "Tagged" : current.source === "COMMIT" ? "Committed" : "Published"} <RelativeTime date={current.publishedAt} />
                  </span>
                </div>
              </div>

              <SheetTitle className="mt-4 text-xl leading-tight break-words">{current.title}</SheetTitle>
              <SheetDescription asChild>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">{current.tagName}</code>
                  {current.source === "TAG" ? <TagSourceBadge /> : null}
                  {current.source === "COMMIT" ? <CommitSourceBadge /> : <SemverBadge type={current.semverType} />}
                  {current.isPrerelease && current.semverType !== "PRERELEASE" ? <SemverBadge type="PRERELEASE" /> : null}
                  {current.tags.map((tag) => (
                    <TagPill key={tag.id} name={tag.name} colorHex={tag.colorHex} />
                  ))}
                </div>
              </SheetDescription>

              <div className="mt-4 flex flex-wrap gap-2">
                <Button asChild size="sm">
                  <a href={current.htmlUrl} target="_blank" rel="noopener noreferrer">
                    <ExternalLinkIcon />
                    View on GitHub
                  </a>
                </Button>
                <Button variant="outline" size="sm" onClick={toggleRead} disabled={toggling}>
                  {read ? <CircleDotIcon className="text-unread" /> : <MailOpenIcon />}
                  {read ? "Mark as unread" : "Mark as read"}
                </Button>
                <SyncRepoButton repositoryId={current.repository.id} label="Sync repo now" />
                {current.source !== "COMMIT" && current.subscriptionId ? (
                  <SetMyVersionButton
                    // Reset the optimistic state when another release opens.
                    key={current.id}
                    subscriptionId={current.subscriptionId}
                    fullName={current.repository.fullName}
                    tagName={current.tagName}
                    isMyVersion={current.isMyVersion}
                  />
                ) : null}
              </div>
            </header>

            <div className="flex-1 overflow-y-auto px-5 py-5">
              {loaded ? children : <BodySkeleton />}
            </div>
          </>
        ) : notFound ? (
          <div className="p-6">
            <SheetTitle>Release not found</SheetTitle>
            <p className="mt-2 text-sm text-muted-foreground">
              It may belong to a repository you no longer track, or be a pre-release hidden by your settings.
            </p>
          </div>
        ) : (
          <div className="p-6">
            <SheetTitle className="sr-only">Loading release</SheetTitle>
            <BodySkeleton />
          </div>
        )}
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

"use client";

import { ExternalLinkIcon, PackageCheckIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import type { FeedItem } from "@/server/queries/feed";

import { RelativeTime } from "./relative-time";
import { RepoAvatar } from "./repo-avatar";
import { SemverBadge } from "./semver-badge";
import { CommitSourceBadge, TagSourceBadge } from "./source-badge";
import { TagPill } from "./tag-pill";

function sourceNoun(source: FeedItem["source"]): string {
  if (source === "TAG") return "tag";
  if (source === "COMMIT") return "commit";
  return "release";
}

function VersionComparisonBadge({ newerThanMine, isMyVersion }: { newerThanMine: boolean; isMyVersion: boolean }) {
  if (newerThanMine) {
    return (
      <span
        className="inline-flex items-center rounded-md border border-dashed px-1.5 py-0.5 text-[11px] text-muted-foreground"
        title="Published after the version you set as yours. Open a release or repository settings to update it."
      >
        Newer than yours
      </span>
    );
  }
  if (isMyVersion) {
    return (
      <span
        className="inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] text-muted-foreground"
        title="The version you marked as currently running. Open this release or go to repository settings to edit or remove it."
      >
        <PackageCheckIcon className="size-3" aria-hidden />
        Your version
      </span>
    );
  }
  return null;
}

function ReleaseBadges({ item }: { item: FeedItem }) {
  const showPrereleaseFlag = item.isPrerelease && item.semverType !== "PRERELEASE";

  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-2">
      <code className="rounded-sm bg-muted px-1.5 py-0.5 font-mono text-xs">{item.tagName}</code>
      {item.source === "TAG" ? <TagSourceBadge /> : null}
      {item.source === "COMMIT" ? <CommitSourceBadge /> : <SemverBadge type={item.semverType} />}
      {showPrereleaseFlag ? <SemverBadge type="PRERELEASE" /> : null}
      <VersionComparisonBadge newerThanMine={item.newerThanMine} isMyVersion={item.isMyVersion} />
    </div>
  );
}

export function ReleaseCard({
  item,
  isRead,
  isActive,
  onOpen,
}: {
  item: FeedItem;
  isRead: boolean;
  isActive: boolean;
  onOpen: (item: FeedItem) => void;
}) {
  return (
    <article
      className={cn(
        "group relative flex gap-3 rounded-lg border bg-card p-4 text-card-foreground transition-colors hover:bg-accent/40",
        isActive && "border-ring/60 bg-accent/50",
      )}
    >
      {/* Stretched button: the whole card opens the reader; inner links sit above it. */}
      <button
        type="button"
        onClick={() => onOpen(item)}
        className="absolute inset-0 z-0 rounded-lg outline-hidden focus-visible:ring-[3px] focus-visible:ring-ring/50"
        aria-label={`Read ${sourceNoun(item.source)} notes for ${item.repository.fullName} ${item.tagName}${isRead ? "" : " (unread)"}`}
      />

      <RepoAvatar
        src={item.repository.avatarUrl}
        name={item.repository.name}
        className="pointer-events-none relative"
      />

      <div className="pointer-events-none relative min-w-0 flex-1">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="truncate">
            <span>{item.repository.owner}/</span>
            <span className="font-medium text-foreground">{item.repository.name}</span>
          </span>
          <span aria-hidden>·</span>
          <RelativeTime date={item.publishedAt} />
        </div>

        <ReleaseBadges item={item} />

        <h3
          className={cn(
            "mt-1.5 line-clamp-2 text-sm wrap-break-word",
            isRead ? "font-normal text-foreground/80" : "font-semibold",
          )}
        >
          {item.title}
        </h3>

        {item.tags.length > 0 ? (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {item.tags.map((tag) => (
              <TagPill key={tag.id} name={tag.name} colorHex={tag.colorHex} />
            ))}
          </div>
        ) : null}
      </div>

      <div className="relative flex flex-col items-end justify-between gap-2">
        <span
          className={cn(
            "pointer-events-none mt-1 size-2.5 rounded-full bg-unread transition-opacity",
            isRead && "opacity-0",
          )}
          aria-hidden
          title={isRead ? undefined : "Unread"}
        />
        <a
          href={item.htmlUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="z-10 rounded-sm p-1 text-muted-foreground opacity-60 outline-hidden transition-opacity group-hover:opacity-100 hover:text-foreground focus-visible:opacity-100 focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          <ExternalLinkIcon className="size-4" />
          <span className="sr-only">Open {item.tagName} on GitHub</span>
        </a>
      </div>
    </article>
  );
}

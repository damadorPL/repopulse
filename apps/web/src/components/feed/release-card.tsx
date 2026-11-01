"use client";

import { ExternalLinkIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import type { FeedItem } from "@/server/queries/feed";
import { RelativeTime } from "./relative-time";
import { RepoAvatar } from "./repo-avatar";
import { SemverBadge } from "./semver-badge";
import { TagSourceBadge } from "./source-badge";
import { TagPill } from "./tag-pill";

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
  const showPrereleaseFlag = item.isPrerelease && item.semverType !== "PRERELEASE";

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
        className="absolute inset-0 z-0 rounded-lg outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        aria-label={`Read ${item.source === "TAG" ? "tag" : "release"} notes for ${item.repository.fullName} ${item.tagName}${isRead ? "" : " (unread)"}`}
      />

      <RepoAvatar src={item.repository.avatarUrl} name={item.repository.name} className="pointer-events-none relative" />

      <div className="pointer-events-none relative min-w-0 flex-1">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="truncate">
            <span>{item.repository.owner}/</span>
            <span className="font-medium text-foreground">{item.repository.name}</span>
          </span>
          <span aria-hidden>·</span>
          <RelativeTime date={item.publishedAt} />
        </div>

        <div className="mt-1.5 flex flex-wrap items-center gap-2">
          <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{item.tagName}</code>
          {item.source === "TAG" ? <TagSourceBadge /> : null}
          <SemverBadge type={item.semverType} />
          {showPrereleaseFlag ? <SemverBadge type="PRERELEASE" /> : null}
        </div>

        <h3 className={cn("mt-1.5 line-clamp-2 text-sm break-words", isRead ? "font-normal text-foreground/80" : "font-semibold")}>
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
          className={cn("pointer-events-none mt-1 size-2.5 rounded-full bg-unread transition-opacity", isRead && "opacity-0")}
          aria-hidden
          title={isRead ? undefined : "Unread"}
        />
        <a
          href={item.htmlUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="z-10 rounded p-1 text-muted-foreground opacity-0 outline-none transition-opacity hover:text-foreground focus-visible:opacity-100 focus-visible:ring-[3px] focus-visible:ring-ring/50 group-hover:opacity-100"
          title="Open on GitHub"
        >
          <ExternalLinkIcon className="size-4" />
          <span className="sr-only">Open {item.tagName} on GitHub</span>
        </a>
      </div>
    </article>
  );
}

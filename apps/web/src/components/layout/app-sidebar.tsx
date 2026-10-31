"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { ActivityIcon, BoxesIcon, InboxIcon, PlusIcon, Settings2Icon } from "lucide-react";
import { TagDot } from "@/components/feed/tag-pill";
import { ManageTagsModal } from "@/components/modals/manage-tags-modal";
import { Button } from "@/components/ui/button";
import { feedHref, parseFeedFilters } from "@/lib/feed-filters";
import { cn } from "@/lib/utils";
import type { SidebarTag } from "@/server/queries/feed";

function CountBadge({ count, accent = false }: { count: number; accent?: boolean }) {
  if (count <= 0) return null;
  return (
    <span
      className={cn(
        "ml-auto min-w-5 rounded-full px-1.5 py-0.5 text-center text-[11px] font-medium leading-none tabular-nums",
        accent ? "bg-unread text-white" : "bg-sidebar-accent text-muted-foreground",
      )}
    >
      {count > 999 ? "999+" : count}
    </span>
  );
}

function NavLink({
  href,
  active,
  icon,
  children,
  badge,
}: {
  href: string;
  active: boolean;
  icon: ReactNode;
  children: ReactNode;
  badge?: ReactNode;
}) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex h-8 items-center gap-2.5 rounded-md px-2 text-sm text-sidebar-foreground/80 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground [&_svg]:size-4 [&_svg]:shrink-0",
        active && "bg-sidebar-accent font-medium text-sidebar-accent-foreground",
      )}
    >
      {icon}
      <span className="min-w-0 truncate">{children}</span>
      {badge}
    </Link>
  );
}

export function AppSidebar({
  tags,
  totalUnread,
  repositoryCount,
}: {
  tags: SidebarTag[];
  totalUnread: number;
  repositoryCount: number;
}) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const onFeed = pathname === "/";
  const filters = parseFeedFilters(searchParams);
  const unfiltered = !filters.tagSlug && !filters.repositoryId && !filters.searchQuery && !filters.semverType;

  return (
    <nav aria-label="Main" className="flex h-full flex-col gap-6 overflow-y-auto px-3 py-4">
      <Link href="/" className="flex items-center gap-2 px-2 font-semibold tracking-tight">
        <span className="flex size-7 items-center justify-center rounded-md bg-primary text-primary-foreground">
          <ActivityIcon className="size-4" />
        </span>
        RepoPulse
      </Link>

      <div className="grid gap-0.5">
        <NavLink
          href="/"
          active={onFeed && unfiltered && !filters.onlyUnread}
          icon={<ActivityIcon />}
          badge={<CountBadge count={totalUnread} accent />}
        >
          All Releases
        </NavLink>
        <NavLink href={feedHref({ onlyUnread: true })} active={onFeed && unfiltered && filters.onlyUnread} icon={<InboxIcon />}>
          Unread Only
        </NavLink>
        <NavLink
          href="/repositories"
          active={pathname.startsWith("/repositories")}
          icon={<BoxesIcon />}
          badge={<CountBadge count={repositoryCount} />}
        >
          Tracked Repositories
        </NavLink>
      </div>

      <div className="grid gap-1">
        <div className="flex items-center justify-between px-2">
          <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Categories / Tags</h2>
          {tags.length > 0 ? (
            <ManageTagsModal tags={tags}>
              <Button variant="ghost" size="icon-sm" className="size-6" aria-label="Manage tags">
                <Settings2Icon className="size-3.5" />
              </Button>
            </ManageTagsModal>
          ) : null}
        </div>

        <div className="grid gap-0.5">
          {tags.map((tag) => (
            <NavLink
              key={tag.id}
              href={feedHref({ tagSlug: tag.slug, onlyUnread: filters.onlyUnread })}
              active={onFeed && filters.tagSlug === tag.slug}
              icon={<TagDot color={tag.colorHex} className="mx-1 size-2.5" />}
              badge={<CountBadge count={tag.unreadCount} />}
            >
              {tag.name}
            </NavLink>
          ))}
        </div>

        <ManageTagsModal tags={tags}>
          <button
            type="button"
            className="flex h-8 items-center gap-2.5 rounded-md px-2 text-sm text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
          >
            <PlusIcon className="size-4" />
            New Tag
          </button>
        </ManageTagsModal>
      </div>
    </nav>
  );
}

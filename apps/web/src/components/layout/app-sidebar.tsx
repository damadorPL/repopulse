"use client";

import type { ReactNode } from "react";
import type { Route } from "next";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import {
  ActivityIcon,
  BellRingIcon,
  BoxesIcon,
  InboxIcon,
  PackageIcon,
  PlusIcon,
  Settings2Icon,
  ShieldIcon,
} from "lucide-react";
import { TagDot } from "@/components/feed/tag-pill";
import { AppVersionLink } from "@/components/layout/app-version-link";
import { useOptionalUnread } from "@/components/layout/unread-context";
import { ManageTagsModal } from "@/components/modals/manage-tags-modal";
import { Button } from "@/components/ui/button";
import { feedHref, parseFeedFilters } from "@/lib/feed-filters";
import { cn } from "@/lib/utils";
import type { DepsSidebarInfo } from "@/server/deps-status";
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
  href: Route;
  active: boolean;
  icon: ReactNode;
  children: ReactNode;
  badge?: ReactNode;
}) {
  return (
    <Link
      href={href}
      prefetch={false}
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
  isSuperAdmin = false,
  dependencies,
}: {
  tags: SidebarTag[];
  totalUnread: number;
  repositoryCount: number;
  /** Slice 08: hidden while the module is off; the badge counts projects with outdated dependencies. */
  dependencies?: DepsSidebarInfo;
  /** The super admin also sees the admin panel (instance settings: access, email, release history). */
  isSuperAdmin?: boolean;
}) {
  const unread = useOptionalUnread();
  const activeTags = unread?.tags ?? tags;
  const activeTotalUnread = unread?.totalUnread ?? totalUnread;
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const onFeed = pathname === "/";
  const filters = parseFeedFilters(searchParams);
  const unfiltered = !filters.tagSlug && !filters.repositoryId && !filters.searchQuery && !filters.semverType;

  return (
    <nav aria-label="Main" className="flex h-full flex-col gap-6 overflow-y-auto px-3 py-4">
      <Link href="/" prefetch={false} className="flex items-center gap-2 px-2 font-semibold tracking-tight">
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
          badge={<CountBadge count={activeTotalUnread} accent />}
        >
          All Releases
        </NavLink>
        <NavLink
          href={feedHref({ onlyUnread: true })}
          active={onFeed && unfiltered && filters.onlyUnread}
          icon={<InboxIcon />}
        >
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
        {dependencies?.enabled ? (
          <NavLink
            href="/dependencies"
            active={pathname === "/dependencies" || pathname.startsWith("/dependencies/")}
            icon={<PackageIcon />}
            badge={<CountBadge count={dependencies.outdatedProjects} />}
          >
            Dependencies
          </NavLink>
        ) : null}
      </div>

      <div className="grid gap-1">
        <div className="flex items-center justify-between px-2">
          <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Tags</h2>
          {activeTags.length > 0 ? (
            <ManageTagsModal tags={activeTags}>
              <Button variant="ghost" size="icon-sm" className="size-6" aria-label="Manage tags">
                <Settings2Icon className="size-3.5" />
              </Button>
            </ManageTagsModal>
          ) : null}
        </div>

        <div className="grid gap-0.5">
          {activeTags.map((tag) => (
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

        <ManageTagsModal tags={activeTags}>
          <button
            type="button"
            className="flex h-8 items-center gap-2.5 rounded-md px-2 text-sm text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
          >
            <PlusIcon className="size-4" />
            New Tag
          </button>
        </ManageTagsModal>
      </div>

      <div className="mt-auto grid gap-1">
        <h2 className="px-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Settings</h2>
        <NavLink
          href="/settings/notifications"
          active={pathname.startsWith("/settings/notifications")}
          icon={<BellRingIcon />}
        >
          Notifications
        </NavLink>
        {isSuperAdmin ? (
          <NavLink href="/admin" active={pathname === "/admin" || pathname.startsWith("/admin/")} icon={<ShieldIcon />}>
            Admin
          </NavLink>
        ) : null}
        <AppVersionLink className="mt-3 px-2 text-[11px]" title="RepoPulse version" />
      </div>
    </nav>
  );
}

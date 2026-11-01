"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { BellIcon, BellRingIcon, LogOutIcon, MailIcon, MenuIcon, PlusIcon, SearchIcon, UsersIcon, XIcon } from "lucide-react";
import { RepoAvatar } from "@/components/feed/repo-avatar";
import { AddRepoModal } from "@/components/modals/add-repo-modal";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverClose, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { feedHref, MAX_SEARCH_LENGTH, parseFeedFilters, PARAM } from "@/lib/feed-filters";
import { signOutAction } from "@/server/actions/auth";
import type { TagPill, UnreadByRepository } from "@/server/queries/feed";

const SEARCH_DEBOUNCE_MS = 300;

export function TopNavbar({
  user,
  tags,
  totalUnread,
  unreadByRepository,
  sidebar,
}: {
  user: { name: string | null; email: string; avatarUrl: string | null; isSuperAdmin: boolean };
  tags: TagPill[];
  totalUnread: number;
  unreadByRepository: UnreadByRepository[];
  /** Sidebar content, shown in a drawer below the `md` breakpoint. */
  sidebar: ReactNode;
}) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [menuOpen, setMenuOpen] = useState(false);

  // Close the mobile menu after navigating.
  const location = `${pathname}?${searchParams.toString()}`;
  useEffect(() => setMenuOpen(false), [location]);

  return (
    <header className="sticky top-0 z-40 flex h-14 items-center gap-2 border-b bg-background/85 px-4 backdrop-blur supports-[backdrop-filter]:bg-background/70 md:gap-3 md:px-6">
      <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
        <SheetTrigger asChild>
          <Button variant="ghost" size="icon-sm" className="md:hidden" aria-label="Open menu">
            <MenuIcon />
          </Button>
        </SheetTrigger>
        <SheetContent side="left" className="w-72 bg-sidebar p-0" aria-describedby={undefined}>
          <SheetTitle className="sr-only">Navigation</SheetTitle>
          {sidebar}
        </SheetContent>
      </Sheet>

      <SearchBox />

      <div className="ml-auto flex items-center gap-1.5 md:gap-2">
        <UnreadBell totalUnread={totalUnread} unreadByRepository={unreadByRepository} />

        <AddRepoModal tags={tags}>
          <Button size="sm">
            <PlusIcon />
            <span className="hidden sm:inline">Add Repo</span>
            <span className="sr-only sm:hidden">Add repository</span>
          </Button>
        </AddRepoModal>

        <Popover>
          <PopoverTrigger asChild>
            <button
              type="button"
              className="rounded-full outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
              aria-label="Account"
            >
              <RepoAvatar src={user.avatarUrl} name={user.name ?? user.email} className="size-8 rounded-full" />
            </button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-60 p-2">
            <div className="px-2 py-1.5">
              <p className="truncate text-sm font-medium">{user.name ?? "Signed in"}</p>
              <p className="truncate text-xs text-muted-foreground">{user.email}</p>
              {user.isSuperAdmin ? <p className="mt-1 text-[11px] font-medium text-muted-foreground">Super admin</p> : null}
            </div>
            <PopoverClose asChild>
              <Button asChild variant="ghost" size="sm" className="w-full justify-start">
                <Link href="/settings/notifications">
                  <BellRingIcon />
                  Notification settings
                </Link>
              </Button>
            </PopoverClose>
            {user.isSuperAdmin ? (
              <>
                <PopoverClose asChild>
                  <Button asChild variant="ghost" size="sm" className="w-full justify-start">
                    <Link href="/settings/access">
                      <UsersIcon />
                      Access &amp; invites
                    </Link>
                  </Button>
                </PopoverClose>
                <PopoverClose asChild>
                  <Button asChild variant="ghost" size="sm" className="w-full justify-start">
                    <Link href="/settings/email">
                      <MailIcon />
                      Email (SMTP)
                    </Link>
                  </Button>
                </PopoverClose>
              </>
            ) : null}
            <form action={signOutAction}>
              <Button type="submit" variant="ghost" size="sm" className="w-full justify-start">
                <LogOutIcon />
                Sign out
              </Button>
            </form>
          </PopoverContent>
        </Popover>
      </div>
    </header>
  );
}

/**
 * Feed search. On the feed it filters as you type (debounced `router.replace`, so typing
 * doesn't flood history); elsewhere Enter jumps to the feed with the query.
 */
function SearchBox() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const urlQuery = searchParams.get(PARAM.q) ?? "";
  const [value, setValue] = useState(urlQuery);
  const lastPushed = useRef(urlQuery);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const onFeed = pathname === "/";

  // Follow external URL changes (clearing the chip, back button) without clobbering typing.
  useEffect(() => {
    if (urlQuery !== lastPushed.current) {
      lastPushed.current = urlQuery;
      setValue(urlQuery);
    }
  }, [urlQuery]);

  useEffect(() => () => clearTimeout(timer.current), []);

  function navigate(query: string, mode: "push" | "replace") {
    const trimmed = query.trim();
    lastPushed.current = trimmed;
    const filters = onFeed ? parseFeedFilters(searchParams) : { onlyUnread: false, sort: "newest" as const };
    const href = feedHref({ ...filters, searchQuery: trimmed || undefined });
    if (mode === "push") router.push(href);
    else router.replace(href, { scroll: false });
  }

  function onChange(next: string) {
    setValue(next);
    clearTimeout(timer.current);
    if (onFeed) timer.current = setTimeout(() => navigate(next, "replace"), SEARCH_DEBOUNCE_MS);
  }

  return (
    <form
      role="search"
      className="relative w-full max-w-md"
      onSubmit={(event) => {
        event.preventDefault();
        clearTimeout(timer.current);
        navigate(value, onFeed ? "replace" : "push");
      }}
    >
      <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Search repos, tags, release notes…"
        aria-label="Search releases"
        maxLength={MAX_SEARCH_LENGTH}
        className="h-9 pl-8 pr-8 [&::-webkit-search-cancel-button]:hidden"
      />
      {value ? (
        <button
          type="button"
          onClick={() => {
            clearTimeout(timer.current);
            setValue("");
            if (onFeed) navigate("", "replace");
          }}
          className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground"
          aria-label="Clear search"
        >
          <XIcon className="size-3.5" />
        </button>
      ) : null}
    </form>
  );
}

function UnreadBell({ totalUnread, unreadByRepository }: { totalUnread: number; unreadByRepository: UnreadByRepository[] }) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon-sm" className="relative" aria-label={`${totalUnread} unread releases`}>
          <BellIcon />
          {totalUnread > 0 ? (
            <span
              data-testid="unread-counter"
              className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-unread px-1 text-[10px] font-semibold leading-none text-white tabular-nums"
            >
              {totalUnread > 99 ? "99+" : totalUnread}
            </span>
          ) : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-0">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <p className="text-sm font-medium">Unread releases</p>
          <span className="text-xs text-muted-foreground tabular-nums">{totalUnread}</span>
        </div>
        {unreadByRepository.length === 0 ? (
          <p className="px-4 py-6 text-center text-sm text-muted-foreground">You&apos;re all caught up.</p>
        ) : (
          <ul className="max-h-80 overflow-y-auto p-1">
            {unreadByRepository.map((repo) => (
              <li key={repo.repositoryId}>
                <Link
                  href={feedHref({ repositoryId: repo.repositoryId, onlyUnread: true })}
                  onClick={() => setOpen(false)}
                  className="flex items-center gap-3 rounded-md px-3 py-2 text-sm hover:bg-accent"
                >
                  <RepoAvatar src={repo.avatarUrl} name={repo.fullName} className="size-6" />
                  <span className="min-w-0 flex-1 truncate">{repo.fullName}</span>
                  <span className="rounded-full bg-unread/15 px-1.5 py-0.5 text-[11px] font-medium text-unread tabular-nums">
                    {repo.unreadCount}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
        {totalUnread > 0 ? (
          <div className="border-t p-1">
            <Link
              href={feedHref({ onlyUnread: true })}
              onClick={() => setOpen(false)}
              className="block rounded-md px-3 py-2 text-center text-sm font-medium hover:bg-accent"
            >
              View all unread
            </Link>
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

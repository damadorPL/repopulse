"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { LoaderCircleIcon, SearchIcon, XIcon } from "lucide-react";
import { TagDot } from "@/components/feed/tag-pill";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  hasActiveRepoListFilters,
  REPO_LIST_SORT_OPTIONS,
  REPO_LIST_STATUS_OPTIONS,
  repoListHref,
  type RepoListFilters,
  type RepoListSort,
  type RepoListStatus,
} from "@/lib/repo-list-filters";
import { cn } from "@/lib/utils";
import type { TagPill } from "@/server/queries/feed";

const ALL_TAGS = "__all__";
const SEARCH_DEBOUNCE_MS = 250;

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

/**
 * Search, sort and quick filters of `/repositories` (Slice 07). The state lives in the URL
 * (`lib/repo-list-filters.ts`); the server filters and sorts, this only rewrites the URL. Search
 * is debounced; `/` focuses it.
 */
export function RepoListToolbar({
  filters,
  tags,
  shown,
  total,
}: {
  filters: RepoListFilters;
  tags: TagPill[];
  shown: number;
  total: number;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [query, setQuery] = useState(filters.q ?? "");
  const inputRef = useRef<HTMLInputElement>(null);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const active = hasActiveRepoListFilters(filters);

  const navigate = useCallback((next: Partial<RepoListFilters>) => {
    // Flush the draft search when changing a filter, and cancel its old URL write
    // immediately, even if the new server-rendered filters have not arrived yet.
    clearTimeout(searchTimer.current);
    startTransition(() => router.replace(repoListHref({ ...filters, q: query, ...next }), { scroll: false }));
  }, [filters, query, router]);

  // Debounced search → URL. Skipped while the text already matches the URL (e.g. after "Clear filters").
  useEffect(() => {
    if (query.trim() === (filters.q ?? "")) return;
    const timer = setTimeout(() => navigate({ q: query }), SEARCH_DEBOUNCE_MS);
    searchTimer.current = timer;
    return () => clearTimeout(timer);
  }, [query, filters.q, navigate]);

  // Follow URL changes made elsewhere (back button, "Clear filters" link).
  const [lastUrlQuery, setLastUrlQuery] = useState(filters.q ?? "");
  if ((filters.q ?? "") !== lastUrlQuery) {
    setLastUrlQuery(filters.q ?? "");
    if (query.trim() !== (filters.q ?? "")) setQuery(filters.q ?? "");
  }

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey || isTypingTarget(event.target)) return;
      event.preventDefault();
      inputRef.current?.focus();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  function toggleStatus(status: RepoListStatus) {
    const statuses = filters.statuses.includes(status) ? filters.statuses.filter((s) => s !== status) : [...filters.statuses, status];
    navigate({ statuses });
  }

  return (
    <div className="space-y-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-48 flex-1">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input
            ref={inputRef}
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape" && query) {
                event.preventDefault();
                setQuery("");
              }
            }}
            placeholder="Search repositories, notes, tags or paths"
            aria-label="Search tracked repositories"
            maxLength={200}
            className="pr-14 pl-8 [&::-webkit-search-cancel-button]:hidden"
          />
          <div className="absolute top-1/2 right-2 flex -translate-y-1/2 items-center gap-1">
            {pending ? <LoaderCircleIcon className="size-3.5 animate-spin text-muted-foreground" aria-hidden /> : null}
            {query ? (
              <button
                type="button"
                onClick={() => {
                  setQuery("");
                  inputRef.current?.focus();
                }}
                className="rounded p-0.5 text-muted-foreground hover:text-foreground"
                aria-label="Clear search"
              >
                <XIcon className="size-3.5" />
              </button>
            ) : (
              <kbd className="hidden rounded border px-1.5 font-mono text-[10px] text-muted-foreground sm:inline" aria-hidden>
                /
              </kbd>
            )}
          </div>
        </div>

        <Select value={filters.sort} onValueChange={(value) => navigate({ sort: value as RepoListSort })}>
          <SelectTrigger className="w-44" aria-label="Sort repositories">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {REPO_LIST_SORT_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {tags.length > 0 ? (
          <Select
            value={filters.tagSlug ?? ALL_TAGS}
            onValueChange={(value) => navigate({ tagSlug: value === ALL_TAGS ? undefined : value })}
          >
            <SelectTrigger className="w-40" aria-label="Filter by tag">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_TAGS}>All tags</SelectItem>
              {tags.map((tag) => (
                <SelectItem key={tag.id} value={tag.slug}>
                  <TagDot color={tag.colorHex} />
                  {tag.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-1.5 text-xs">
        {REPO_LIST_STATUS_OPTIONS.map((option) => {
          const selected = filters.statuses.includes(option.value);
          return (
            <button
              key={option.value}
              type="button"
              aria-pressed={selected}
              onClick={() => toggleStatus(option.value)}
              className={cn(
                "rounded-full border px-2.5 py-1 transition-colors",
                selected ? "border-foreground/40 bg-secondary font-medium" : "text-muted-foreground hover:bg-accent",
              )}
            >
              {option.label}
            </button>
          );
        })}
        <span className="ml-auto flex items-center gap-3 text-muted-foreground">
          {active ? (
            <>
              <span aria-live="polite">
                {shown} of {total} repositor{total === 1 ? "y" : "ies"}
              </span>
              <Link href={repoListHref({ sort: filters.sort })} className="font-medium text-foreground hover:underline" scroll={false}>
                Clear filters
              </Link>
            </>
          ) : null}
        </span>
      </div>
    </div>
  );
}

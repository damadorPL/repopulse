"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { LoaderCircleIcon, SearchIcon, XIcon } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  DEPENDENCY_LIST_SORT_OPTIONS,
  dependencyListHref,
  type DependencyListFilters,
  type DependencyListSort,
} from "@/lib/dependency-list-filters";
import { createUrlSearchSyncState, reconcileUrlSearchQuery, recordUrlSearchPush } from "@/lib/url-search";

const SEARCH_DEBOUNCE_MS = 250;

/** Search + sort of `/dependencies`; the state lives in the URL, the server filters. */
export function DependencyListToolbar({ filters, shown, total }: { filters: DependencyListFilters; shown: number; total: number }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const urlQuery = filters.q ?? "";
  const [query, setQuery] = useState(urlQuery);
  const inputRef = useRef<HTMLInputElement>(null);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const syncState = useRef(createUrlSearchSyncState(urlQuery));

  const navigate = useCallback((next: Partial<DependencyListFilters>) => {
    clearTimeout(searchTimer.current);
    const nextQuery = next.q !== undefined ? next.q : query;
    recordUrlSearchPush(syncState.current, nextQuery);
    startTransition(() => router.replace(dependencyListHref({ ...filters, q: query, ...next }), { scroll: false }));
  }, [filters, query, router]);

  useEffect(() => {
    if (query.trim() === urlQuery) return;
    const timer = setTimeout(() => navigate({ q: query }), SEARCH_DEBOUNCE_MS);
    searchTimer.current = timer;
    return () => clearTimeout(timer);
  }, [query, urlQuery, navigate]);

  // Follow URL changes made elsewhere (back button, "Clear search") without clobbering typing.
  useEffect(() => {
    if (reconcileUrlSearchQuery(syncState.current, urlQuery)) {
      clearTimeout(searchTimer.current);
      setQuery(urlQuery);
    }
  }, [urlQuery]);

  return (
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
          placeholder="Search projects or package managers"
          aria-label="Search dependency projects"
          maxLength={200}
          className="pr-10 pl-8 [&::-webkit-search-cancel-button]:hidden"
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
          ) : null}
        </div>
      </div>
      <Select value={filters.sort} onValueChange={(value) => navigate({ sort: value as DependencyListSort })}>
        <SelectTrigger className="w-44" aria-label="Sort projects">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {DEPENDENCY_LIST_SORT_OPTIONS.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {filters.q ? (
        <span className="flex w-full items-center justify-end gap-3 text-xs text-muted-foreground">
          <span aria-live="polite">
            {shown} of {total} project{total === 1 ? "" : "s"}
          </span>
          <Link href={dependencyListHref({ sort: filters.sort })} className="font-medium text-foreground hover:underline" scroll={false}>
            Clear search
          </Link>
        </span>
      ) : null}
    </div>
  );
}

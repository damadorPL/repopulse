"use client";

import { LoaderCircleIcon, SearchIcon, XIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useTransition } from "react";

import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  DEPENDENCY_LIST_SORT_OPTIONS,
  dependencyListHref,
  type DependencyListFilters,
} from "@/lib/dependency-list-filters";
import { useUrlSearchSync } from "@/lib/use-url-search-sync";

const SEARCH_DEBOUNCE_MS = 250;

/** Search + sort of `/dependencies`; the state lives in the URL, the server filters. */
export function DependencyListToolbar({
  filters,
  shown,
  total,
}: {
  filters: DependencyListFilters;
  shown: number;
  total: number;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const urlQuery = filters.q ?? "";
  const { value: query, setValue: setQuery, recordPush, schedulePush, cancelPush } = useUrlSearchSync(urlQuery);
  const inputRef = useRef<HTMLInputElement>(null);

  function navigate(next: Partial<DependencyListFilters>) {
    cancelPush();
    const nextQuery = next.q ?? query;
    recordPush(nextQuery);
    startTransition(() => router.replace(dependencyListHref({ ...filters, q: query, ...next }), { scroll: false }));
  }

  function handleQueryChange(next: string) {
    setQuery(next);
    if (next.trim() === urlQuery) {
      cancelPush();
      return;
    }
    schedulePush(SEARCH_DEBOUNCE_MS, () => navigate({ q: next }));
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative min-w-48 flex-1">
        <SearchIcon
          className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
          aria-hidden
        />
        <Input
          ref={inputRef}
          type="search"
          value={query}
          onChange={(event) => handleQueryChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape" && query) {
              event.preventDefault();
              handleQueryChange("");
            }
          }}
          placeholder="Search projects or package managers"
          aria-label="Search dependency projects"
          maxLength={200}
          className="pr-10 pl-8 [&::-webkit-search-cancel-button]:hidden"
        />
        <div className="absolute top-1/2 right-2 flex -translate-y-1/2 items-center gap-1">
          {pending ? (
            <LoaderCircleIcon className="size-3.5 text-muted-foreground motion-safe:animate-spin" aria-hidden />
          ) : null}
          {query ? (
            <button
              type="button"
              onClick={() => {
                setQuery("");
                cancelPush();
                if (urlQuery !== "") navigate({ q: "" });
                inputRef.current?.focus();
              }}
              className="rounded-sm p-0.5 text-muted-foreground hover:text-foreground"
              aria-label="Clear search"
            >
              <XIcon className="size-3.5" />
            </button>
          ) : null}
        </div>
      </div>
      <Select
        value={filters.sort}
        onValueChange={(value) => {
          const match = DEPENDENCY_LIST_SORT_OPTIONS.find((opt) => opt.value === value);
          if (match) navigate({ sort: match.value });
        }}
      >
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
          <Link
            href={dependencyListHref({ sort: filters.sort })}
            className="font-medium text-foreground hover:underline"
            scroll={false}
          >
            Clear search
          </Link>
        </span>
      ) : null}
    </div>
  );
}

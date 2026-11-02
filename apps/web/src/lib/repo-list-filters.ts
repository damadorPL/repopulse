/**
 * Search, sort and quick filters of `/repositories` (Slice 07), kept in the URL
 * (`/repositories?q=next&sort=-added&tag=frontend&status=unread`) so views survive reloads and are
 * rendered on the server. The list is small (hundreds at most), so filters run in memory on the
 * `getTrackedRepositories` result. Shared by server and client code: no server-only imports.
 */

import { MAX_SEARCH_LENGTH } from "./feed-filters";

export const REPO_LIST_SORTS = ["name", "-name", "added", "-added", "updated", "synced", "unread", "stars"] as const;
export type RepoListSort = (typeof REPO_LIST_SORTS)[number];

export const REPO_LIST_SORT_OPTIONS: ReadonlyArray<{ value: RepoListSort; label: string }> = [
  { value: "name", label: "Name (A–Z)" },
  { value: "-name", label: "Name (Z–A)" },
  { value: "-added", label: "Recently added" },
  { value: "added", label: "Oldest added" },
  { value: "updated", label: "Latest update" },
  { value: "synced", label: "Last synced" },
  { value: "unread", label: "Most unread" },
  { value: "stars", label: "Most stars" },
];

export const REPO_LIST_STATUSES = ["unread", "error", "paths", "pinned"] as const;
export type RepoListStatus = (typeof REPO_LIST_STATUSES)[number];

export const REPO_LIST_STATUS_OPTIONS: ReadonlyArray<{ value: RepoListStatus; label: string }> = [
  { value: "pinned", label: "Pinned" },
  { value: "unread", label: "Unread" },
  { value: "paths", label: "Files / folders" },
  { value: "error", label: "Sync failed" },
];

export interface RepoListFilters {
  q?: string;
  sort: RepoListSort;
  tagSlug?: string;
  /** Every chosen status must hold (AND). */
  statuses: RepoListStatus[];
}

export const REPO_LIST_PARAM = { q: "q", sort: "sort", tag: "tag", status: "status" } as const;

export const DEFAULT_REPO_LIST_FILTERS: RepoListFilters = { sort: "name", statuses: [] };

type RawParams = URLSearchParams | Record<string, string | string[] | undefined>;

function read(params: RawParams, key: string): string | undefined {
  const value = params instanceof URLSearchParams ? params.get(key) : params[key];
  const first = Array.isArray(value) ? value[0] : value;
  const trimmed = first?.trim();
  return trimmed ? trimmed : undefined;
}

export function parseRepoListFilters(params: RawParams): RepoListFilters {
  const q = read(params, REPO_LIST_PARAM.q);
  const sort = read(params, REPO_LIST_PARAM.sort);
  const tag = read(params, REPO_LIST_PARAM.tag);
  const statuses = (read(params, REPO_LIST_PARAM.status) ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s): s is RepoListStatus => (REPO_LIST_STATUSES as readonly string[]).includes(s));
  return {
    q: q ? q.slice(0, MAX_SEARCH_LENGTH) : undefined,
    sort: REPO_LIST_SORTS.find((s) => s === sort) ?? "name",
    tagSlug: tag && /^[A-Za-z0-9_-]{1,64}$/.test(tag) ? tag : undefined,
    // Canonical order, no duplicates, so equal filters give equal URLs.
    statuses: REPO_LIST_STATUSES.filter((s) => statuses.includes(s)),
  };
}

/** Serializes filters to search params (defaults omitted to keep URLs short). */
export function repoListSearchParams(filters: Partial<RepoListFilters>): URLSearchParams {
  const params = new URLSearchParams();
  const q = filters.q?.trim();
  if (q) params.set(REPO_LIST_PARAM.q, q.slice(0, MAX_SEARCH_LENGTH));
  if (filters.sort && filters.sort !== "name") params.set(REPO_LIST_PARAM.sort, filters.sort);
  if (filters.tagSlug) params.set(REPO_LIST_PARAM.tag, filters.tagSlug);
  const statuses = REPO_LIST_STATUSES.filter((s) => filters.statuses?.includes(s));
  if (statuses.length > 0) params.set(REPO_LIST_PARAM.status, statuses.join(","));
  return params;
}

export function repoListHref(filters: Partial<RepoListFilters> = {}): string {
  const query = repoListSearchParams(filters).toString();
  return query ? `/repositories?${query}` : "/repositories";
}

/**
 * The settings page of a tracked repository. `from` carries the list's query string, so the page's
 * back link returns to the same search, sort and filters.
 */
export function repositorySettingsHref(fullName: string, from?: Partial<RepoListFilters>): string {
  const [owner = "", name = ""] = fullName.split("/");
  const path = `/repositories/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
  const query = from ? repoListSearchParams(from).toString() : "";
  return query ? `${path}?from=${encodeURIComponent(query)}` : path;
}

/** The list URL to return to from a settings page's `?from=` value (re-parsed, so it can only point at the list). */
export function repoListHrefFrom(from: string | string[] | undefined): string {
  const value = Array.isArray(from) ? from[0] : from;
  if (!value || value.length > 1000) return "/repositories";
  return repoListHref(parseRepoListFilters(new URLSearchParams(value)));
}

/** Anything narrowing the list (sorting alone does not). */
export function hasActiveRepoListFilters(filters: RepoListFilters): boolean {
  return Boolean(filters.q || filters.tagSlug || filters.statuses.length > 0);
}

/** The fields of a tracked repository the list filters read (structural, so lib stays free of server types). */
export interface RepoListRow {
  isPinned: boolean;
  trackPaths: boolean;
  watchedPaths: string[];
  subscribedAt: Date;
  latestActivityAt: Date | null;
  note: string | null;
  tags: Array<{ name: string; slug: string }>;
  repository: {
    id: string;
    fullName: string;
    description: string | null;
    starsCount: number;
    lastPolledAt: Date | null;
    pollStatus: string;
  };
}

/** Lower-cased text a search query is matched against. */
function haystack(row: RepoListRow): string {
  return [row.repository.fullName, row.repository.description ?? "", row.note ?? "", ...row.tags.map((t) => t.name), ...row.watchedPaths]
    .join("\n")
    .toLowerCase();
}

/** Newest first, `null` last. */
function byDateDesc(a: Date | null, b: Date | null): number {
  if (a === null || b === null) return a === b ? 0 : a === null ? 1 : -1;
  return b.getTime() - a.getTime();
}

function byName(a: RepoListRow, b: RepoListRow): number {
  return a.repository.fullName.localeCompare(b.repository.fullName, undefined, { sensitivity: "base" });
}

/**
 * Filters and sorts tracked repositories. Search matches, case-insensitively, the full name,
 * description, note, tag names and watched paths; every word must match. Pinned repositories come
 * first within any sort, and ties fall back to the full name.
 */
export function applyRepoListFilters<T extends RepoListRow>(
  rows: readonly T[],
  filters: RepoListFilters,
  unreadByRepo: ReadonlyMap<string, number>,
): T[] {
  const words = (filters.q ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const unread = (row: RepoListRow) => unreadByRepo.get(row.repository.id) ?? 0;

  const filtered = rows.filter((row) => {
    if (filters.tagSlug && !row.tags.some((t) => t.slug === filters.tagSlug)) return false;
    for (const status of filters.statuses) {
      if (status === "unread" && unread(row) === 0) return false;
      if (status === "error" && row.repository.pollStatus !== "ERROR") return false;
      if (status === "paths" && !row.trackPaths) return false;
      if (status === "pinned" && !row.isPinned) return false;
    }
    if (words.length > 0) {
      const text = haystack(row);
      if (!words.every((word) => text.includes(word))) return false;
    }
    return true;
  });

  const compare = (a: T, b: T): number => {
    switch (filters.sort) {
      case "name":
        return 0;
      case "-name":
        return -byName(a, b);
      case "added":
        return a.subscribedAt.getTime() - b.subscribedAt.getTime();
      case "-added":
        return b.subscribedAt.getTime() - a.subscribedAt.getTime();
      case "updated":
        return byDateDesc(a.latestActivityAt, b.latestActivityAt);
      case "synced":
        return byDateDesc(a.repository.lastPolledAt, b.repository.lastPolledAt);
      case "unread":
        return unread(b) - unread(a);
      case "stars":
        return b.repository.starsCount - a.repository.starsCount;
    }
  };

  return filtered.sort((a, b) => Number(b.isPinned) - Number(a.isPinned) || compare(a, b) || byName(a, b));
}

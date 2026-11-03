/**
 * Search and sort of `/dependencies` (Slice 08), kept in the URL like `lib/repo-list-filters.ts`
 * (`/dependencies?q=web&sort=outdated`), plus the client-side filters of a project's outdated table.
 * The lists are small (≤ 50 projects, ≤ 1000 rows), so filtering runs in memory. Browser-safe.
 */

import { MAX_SEARCH_LENGTH } from "./feed-filters";
import type {
  DependencyEcosystemValue,
  DependencyKindValue,
  DependencyUpdateStatusValue,
} from "./dependency-settings";

export const DEPENDENCY_LIST_SORTS = ["name", "outdated", "checked"] as const;
export type DependencyListSort = (typeof DEPENDENCY_LIST_SORTS)[number];

export const DEPENDENCY_LIST_SORT_OPTIONS: ReadonlyArray<{ value: DependencyListSort; label: string }> = [
  { value: "name", label: "Name (A–Z)" },
  { value: "outdated", label: "Most outdated" },
  { value: "checked", label: "Last checked" },
];

export interface DependencyListFilters {
  q?: string;
  sort: DependencyListSort;
}

export const DEPENDENCY_LIST_PARAM = { q: "q", sort: "sort" } as const;
export const DEPENDENCIES_PATH = "/dependencies";

type RawParams = URLSearchParams | Record<string, string | string[] | undefined>;

function read(params: RawParams, key: string): string | undefined {
  const value = params instanceof URLSearchParams ? params.get(key) : params[key];
  const first = Array.isArray(value) ? value[0] : value;
  const trimmed = first?.trim();
  return trimmed ? trimmed : undefined;
}

export function parseDependencyListFilters(params: RawParams): DependencyListFilters {
  const q = read(params, DEPENDENCY_LIST_PARAM.q);
  const sort = read(params, DEPENDENCY_LIST_PARAM.sort);
  return {
    q: q ? q.slice(0, MAX_SEARCH_LENGTH) : undefined,
    sort: DEPENDENCY_LIST_SORTS.find((s) => s === sort) ?? "name",
  };
}

export function dependencyListSearchParams(filters: Partial<DependencyListFilters>): URLSearchParams {
  const params = new URLSearchParams();
  const q = filters.q?.trim();
  if (q) params.set(DEPENDENCY_LIST_PARAM.q, q.slice(0, MAX_SEARCH_LENGTH));
  if (filters.sort && filters.sort !== "name") params.set(DEPENDENCY_LIST_PARAM.sort, filters.sort);
  return params;
}

export function dependencyListHref(filters: Partial<DependencyListFilters> = {}): string {
  const query = dependencyListSearchParams(filters).toString();
  return query ? `${DEPENDENCIES_PATH}?${query}` : DEPENDENCIES_PATH;
}

/** The page of a project; `from` carries the list's query string for the back link. */
export function dependencyProjectHref(fullName: string, from?: Partial<DependencyListFilters>): string {
  const [owner = "", name = ""] = fullName.split("/");
  const path = `${DEPENDENCIES_PATH}/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
  const query = from ? dependencyListSearchParams(from).toString() : "";
  return query ? `${path}?from=${encodeURIComponent(query)}` : path;
}

/** The list URL to return to from a project page's `?from=` value (re-parsed: it can only point at the list). */
export function dependencyListHrefFrom(from: string | string[] | undefined): string {
  const value = Array.isArray(from) ? from[0] : from;
  if (!value || value.length > 1000) return DEPENDENCIES_PATH;
  return dependencyListHref(parseDependencyListFilters(new URLSearchParams(value)));
}

/** The fields of a project row the list filters read (structural, so lib stays free of server types). */
export interface DependencyListRow {
  fullName: string;
  packageManagers: string[];
  outdated: { major: number; minor: number; patch: number; other: number };
  lastScannedAt: Date | null;
}

function outdatedTotal(row: DependencyListRow): number {
  return row.outdated.major + row.outdated.minor + row.outdated.patch + row.outdated.other;
}

function byName(a: DependencyListRow, b: DependencyListRow): number {
  return a.fullName.localeCompare(b.fullName, undefined, { sensitivity: "base" });
}

/**
 * Filters and sorts projects. Every search word must match the full name or a package manager.
 * `outdated`: most majors first, then the total; `checked`: most recently checked first (never last).
 */
export function applyDependencyListFilters<T extends DependencyListRow>(rows: readonly T[], filters: DependencyListFilters): T[] {
  const words = (filters.q ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const filtered = rows.filter((row) => {
    if (words.length === 0) return true;
    const text = [row.fullName, ...row.packageManagers].join("\n").toLowerCase();
    return words.every((word) => text.includes(word));
  });
  const compare = (a: T, b: T): number => {
    switch (filters.sort) {
      case "name":
        return 0;
      case "outdated":
        return b.outdated.major - a.outdated.major || outdatedTotal(b) - outdatedTotal(a);
      case "checked": {
        const x = a.lastScannedAt?.getTime() ?? null;
        const y = b.lastScannedAt?.getTime() ?? null;
        if (x === null || y === null) return x === y ? 0 : x === null ? 1 : -1;
        return y - x;
      }
    }
  };
  return filtered.sort((a, b) => compare(a, b) || byName(a, b));
}

// ---------------------------------------------------------------------------
// Outdated table filters (project page, client state)
// ---------------------------------------------------------------------------

export type UpdateLevelFilter = "MAJOR" | "MINOR" | "PATCH" | "OTHER";

export interface UpdateTableFilters {
  level?: UpdateLevelFilter;
  kind?: DependencyKindValue;
  ecosystem?: DependencyEcosystemValue;
  /** `undefined` = everything; "ACTIONABLE" (default view) = only `OUTDATED`. */
  status?: DependencyUpdateStatusValue;
  q?: string;
}

export interface UpdateTableRow {
  name: string;
  kind: DependencyKindValue;
  ecosystem: DependencyEcosystemValue;
  status: DependencyUpdateStatusValue;
  level: string | null;
}

function levelBucket(level: string | null): UpdateLevelFilter {
  return level === "MAJOR" || level === "MINOR" || level === "PATCH" ? level : "OTHER";
}

export function filterUpdateRows<T extends UpdateTableRow>(rows: readonly T[], filters: UpdateTableFilters): T[] {
  const q = filters.q?.trim().toLowerCase();
  return rows.filter(
    (row) =>
      (!filters.level || levelBucket(row.level) === filters.level) &&
      (!filters.kind || row.kind === filters.kind) &&
      (!filters.ecosystem || row.ecosystem === filters.ecosystem) &&
      (!filters.status || row.status === filters.status) &&
      (!q || row.name.toLowerCase().includes(q)),
  );
}

/**
 * Feed filter state lives in the URL (`/?tag=…&semver=major&unread=1&q=…`) so views are
 * shareable, survive reloads and are rendered on the server. Shared by server and client code,
 * so this module must stay free of server-only imports.
 */

/** Mirrors the Prisma `SemverType` enum (kept local so client bundles never import @repopulse/db). */
export const SEMVER_TYPES = ["MAJOR", "MINOR", "PATCH", "PRERELEASE", "OTHER"] as const;
export type SemverTypeValue = (typeof SEMVER_TYPES)[number];

export const FEED_SORTS = ["newest", "oldest"] as const;
export type FeedSort = (typeof FEED_SORTS)[number];

export const MAX_SEARCH_LENGTH = 200;
export const FEED_PAGE_SIZE = 25;

export interface FeedFilters {
  tagSlug?: string;
  repositoryId?: string;
  onlyUnread: boolean;
  semverType?: SemverTypeValue;
  searchQuery?: string;
  sort: FeedSort;
}

/** Search param names. `release` (open changelog) is not a filter but shares the URL. */
export const PARAM = {
  tag: "tag",
  repo: "repo",
  unread: "unread",
  semver: "semver",
  q: "q",
  sort: "sort",
  release: "release",
} as const;

type RawParams = URLSearchParams | Record<string, string | string[] | undefined>;

function read(params: RawParams, key: string): string | undefined {
  const value = params instanceof URLSearchParams ? params.get(key) : params[key];
  const first = Array.isArray(value) ? value[0] : value;
  const trimmed = first?.trim();
  return trimmed ? trimmed : undefined;
}

/** Ids/slugs are short url-safe tokens; anything else is ignored rather than queried. */
function token(value: string | undefined): string | undefined {
  return value && /^[A-Za-z0-9_-]{1,64}$/.test(value) ? value : undefined;
}

export function parseFeedFilters(params: RawParams): FeedFilters {
  const semver = read(params, PARAM.semver)?.toUpperCase();
  const sort = read(params, PARAM.sort);
  const q = read(params, PARAM.q);
  return {
    tagSlug: token(read(params, PARAM.tag)),
    repositoryId: token(read(params, PARAM.repo)),
    onlyUnread: read(params, PARAM.unread) === "1",
    semverType: SEMVER_TYPES.find((type) => type === semver),
    searchQuery: q ? q.slice(0, MAX_SEARCH_LENGTH) : undefined,
    sort: FEED_SORTS.find((s) => s === sort) ?? "newest",
  };
}

export function parseReleaseParam(params: RawParams): string | undefined {
  return token(read(params, PARAM.release));
}

/** Serializes filters to search params (defaults omitted to keep URLs short). */
export function feedSearchParams(filters: Partial<FeedFilters>, releaseId?: string | null): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.tagSlug) params.set(PARAM.tag, filters.tagSlug);
  if (filters.repositoryId) params.set(PARAM.repo, filters.repositoryId);
  if (filters.onlyUnread) params.set(PARAM.unread, "1");
  if (filters.semverType) params.set(PARAM.semver, filters.semverType.toLowerCase());
  if (filters.searchQuery) params.set(PARAM.q, filters.searchQuery);
  if (filters.sort && filters.sort !== "newest") params.set(PARAM.sort, filters.sort);
  if (releaseId) params.set(PARAM.release, releaseId);
  return params;
}

export function feedHref(filters: Partial<FeedFilters> = {}, releaseId?: string | null): string {
  const query = feedSearchParams(filters, releaseId).toString();
  return query ? `/?${query}` : "/";
}

/** Stable identity of a filter combination (ignores the open release). */
export function feedFiltersKey(filters: FeedFilters): string {
  return feedSearchParams(filters).toString();
}

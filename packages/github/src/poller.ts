import type { Octokit } from "@octokit/rest";

import { createOctokit, getRateLimitInfo, isGitHubHttpError, type ResponseHeaders } from "./client.js";
import { classifySemver, type SemverType } from "./parser.js";

/**
 * The release fields we consume. Structural on purpose: `octokit.request()` and
 * `octokit.rest.*` can resolve different `@octokit/openapi-types` versions whose
 * nominally-identical release types are not mutually assignable.
 */
export interface GitHubRelease {
  id: number;
  tag_name: string;
  name: string | null;
  body?: string | null;
  html_url: string;
  prerelease: boolean;
  draft: boolean;
  created_at: string;
  published_at: string | null;
}

/**
 * Both the initial fetch and the poller request the same page size so the URL is
 * identical and the stored ETag stays valid for the first conditional poll
 * (GitHub ETags are per-URL, so `per_page=10` vs `per_page=20` would never 304).
 */
const RELEASES_PAGE_SIZE = 20;
/** Number of releases ingested when a repository is first added. */
export const INITIAL_RELEASES_LIMIT = 10;
/** Page size of the history backfill (GitHub's maximum). */
const BACKFILL_PAGE_SIZE = 100;

/** Matches the `Release` Prisma model (minus `id`, `repositoryId`, `discoveredAt`). */
export interface MappedRelease {
  githubReleaseId: bigint;
  tagName: string;
  title: string;
  bodyMarkdown: string;
  htmlUrl: string;
  isPrerelease: boolean;
  isDraft: boolean;
  semverType: SemverType;
  publishedAt: Date;
}

/** Matches the GitHub-sourced columns of the `Repository` Prisma model. */
export interface FetchedRepository {
  githubRepoId: number;
  owner: string;
  name: string;
  fullName: string;
  description: string | null;
  avatarUrl: string | null;
  htmlUrl: string;
  starsCount: number;
}

export interface ValidateAndFetchRepoResult {
  repository: FetchedRepository;
  releases: MappedRelease[];
  /** Exact `ETag` header of the releases list, ready to send back as `If-None-Match`. */
  etag: string | null;
  rateLimitRemaining: number | null;
}

export type PollRepoReleasesResult =
  | { status: "NOT_MODIFIED"; etag: string | null; releases: []; rateLimitRemaining: number | null }
  | { status: "UPDATED"; etag: string | null; releases: MappedRelease[]; rateLimitRemaining: number | null };

export interface FetchReleasesPageResult {
  /** Published releases on this page, newest first (drafts removed). */
  releases: MappedRelease[];
  /** From the `Link` header (`rel="next"`), not the page length: drafts can shorten a full page. */
  hasNextPage: boolean;
  rateLimitRemaining: number | null;
  rateLimitResetAt: Date | null;
}

export class GitHubRepositoryNotFoundError extends Error {
  readonly fullName: string;

  constructor(owner: string, name: string) {
    super(`GitHub repository "${owner}/${name}" was not found or is not accessible.`);
    this.name = "GitHubRepositoryNotFoundError";
    this.fullName = `${owner}/${name}`;
  }
}

export class GitHubRateLimitError extends Error {
  readonly resetAt: Date | null;

  constructor(resetAt: Date | null) {
    super(
      resetAt
        ? `GitHub API rate limit exceeded. Try again after ${resetAt.toISOString()}.`
        : "GitHub API rate limit exceeded.",
    );
    this.name = "GitHubRateLimitError";
    this.resetAt = resetAt;
  }
}

/** Maps a GitHub release payload to the `Release` model shape. */
export function mapRelease(release: GitHubRelease): MappedRelease {
  const trimmedName = release.name?.trim();
  return {
    githubReleaseId: BigInt(release.id),
    tagName: release.tag_name,
    title: trimmedName !== undefined && trimmedName.length > 0 ? trimmedName : release.tag_name,
    bodyMarkdown: release.body ?? "",
    htmlUrl: release.html_url,
    isPrerelease: release.prerelease,
    isDraft: release.draft,
    semverType: classifySemver(release.tag_name, release.prerelease),
    publishedAt: new Date(release.published_at ?? release.created_at),
  };
}

/**
 * Repositories (and their releases) are shared by every subscriber, but drafts are only
 * visible to tokens with push access — so drafts are never ingested.
 */
function mapPublishedReleases(releases: GitHubRelease[]): MappedRelease[] {
  return releases.filter((r) => !r.draft).map(mapRelease);
}

/** Whether an RFC 8288 `Link` header contains a `rel="next"` link. */
export function hasNextLink(link: ResponseHeaders[string]): boolean {
  const value = Array.isArray(link) ? link.join(",") : link;
  if (typeof value !== "string") return false;
  return value.split(",").some((part) => {
    // `rel` may hold several space-separated relation types: rel="next last".
    const rel = /;\s*rel\s*=\s*"?([^";]*)"?/i.exec(part)?.[1];
    return rel?.toLowerCase().split(/\s+/).includes("next") ?? false;
  });
}

function etagOf(headers: ResponseHeaders): string | null {
  const etag = headers.etag;
  return typeof etag === "string" && etag.length > 0 ? etag : null;
}

function headerString(headers: ResponseHeaders | undefined, name: string): string | null {
  const raw = headers?.[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined || value === null) return null;
  const trimmed = String(value).trim();
  return trimmed === "" ? null : trimmed;
}

/** Parses an HTTP `Retry-After` header (numeric delay-seconds or HTTP-date) into a `Date`. */
export function parseRetryAfter(headers: ResponseHeaders | undefined): Date | null {
  const raw = headerString(headers, "retry-after") ?? headerString(headers, "Retry-After");
  if (raw === null) return null;
  if (/^\d+(?:\.\d+)?$/.test(raw)) {
    const seconds = Number(raw);
    return Number.isFinite(seconds) && seconds >= 0 ? new Date(Date.now() + seconds * 1000) : null;
  }
  const timestamp = Date.parse(raw);
  return Number.isFinite(timestamp) ? new Date(timestamp) : null;
}

/**
 * The rate-limit error for a primary (`x-ratelimit-remaining: 0`, 429) or secondary (`retry-after`)
 * GitHub rate limit, or `null` for any other error.
 */
export function toRateLimitError(error: unknown): GitHubRateLimitError | null {
  if (!isGitHubHttpError(error) || (error.status !== 403 && error.status !== 429)) return null;
  const headers = error.response?.headers;
  const rateLimit = getRateLimitInfo(headers);
  const retryAfter = parseRetryAfter(headers);
  if (rateLimit.remaining === 0) return new GitHubRateLimitError(rateLimit.resetAt ?? retryAfter);
  if (retryAfter) return new GitHubRateLimitError(retryAfter);
  return error.status === 429 ? new GitHubRateLimitError(rateLimit.resetAt) : null;
}

/** Converts Octokit HTTP errors into typed domain errors; re-throws everything else. */
export function rethrowGitHubError(error: unknown, owner: string, name: string): never {
  const rateLimited = toRateLimitError(error);
  if (rateLimited) throw rateLimited;
  if (isGitHubHttpError(error) && error.status === 404) {
    throw new GitHubRepositoryNotFoundError(owner, name);
  }
  throw error;
}

/**
 * Validates that `owner/name` exists and returns its metadata plus the latest
 * {@link INITIAL_RELEASES_LIMIT} published releases and the releases-list ETag.
 */
export async function validateAndFetchRepo(
  owner: string,
  name: string,
  accessToken?: string | null,
  options: { octokit?: Octokit } = {},
): Promise<ValidateAndFetchRepoResult> {
  const octokit = options.octokit ?? createOctokit({ accessToken });

  try {
    const [repoResponse, releasesResponse] = await Promise.all([
      octokit.rest.repos.get({ owner, repo: name }),
      octokit.rest.repos.listReleases({ owner, repo: name, per_page: RELEASES_PAGE_SIZE }),
    ]);
    const repo = repoResponse.data;

    return {
      repository: {
        githubRepoId: repo.id,
        owner: repo.owner.login,
        name: repo.name,
        fullName: repo.full_name,
        description: repo.description,
        avatarUrl: repo.owner.avatar_url || null,
        htmlUrl: repo.html_url,
        starsCount: repo.stargazers_count,
      },
      releases: mapPublishedReleases(releasesResponse.data).slice(0, INITIAL_RELEASES_LIMIT),
      etag: etagOf(releasesResponse.headers),
      rateLimitRemaining: getRateLimitInfo(releasesResponse.headers).remaining,
    };
  } catch (error) {
    rethrowGitHubError(error, owner, name);
  }
}

/**
 * Conditionally fetches the latest releases. Sends `If-None-Match: lastEtag`; a `304`
 * costs no rate-limit quota and yields `NOT_MODIFIED` with the previous ETag.
 */
export async function pollRepoReleases(params: {
  owner: string;
  name: string;
  lastEtag?: string | null;
  accessToken?: string | null;
  octokit?: Octokit;
  /** Aborts the HTTP request (worker shutdown, job timeout). */
  signal?: AbortSignal;
}): Promise<PollRepoReleasesResult> {
  const { owner, name, lastEtag } = params;
  const octokit = params.octokit ?? createOctokit({ accessToken: params.accessToken });

  try {
    const response = await octokit.request("GET /repos/{owner}/{repo}/releases", {
      owner,
      repo: name,
      per_page: RELEASES_PAGE_SIZE,
      headers: lastEtag ? { "If-None-Match": lastEtag } : {},
      ...(params.signal ? { request: { signal: params.signal } } : {}),
    });
    return {
      status: "UPDATED",
      etag: etagOf(response.headers),
      releases: mapPublishedReleases(response.data),
      rateLimitRemaining: getRateLimitInfo(response.headers).remaining,
    };
  } catch (error) {
    if (isGitHubHttpError(error) && error.status === 304) {
      return {
        status: "NOT_MODIFIED",
        etag: lastEtag ?? null,
        releases: [],
        rateLimitRemaining: getRateLimitInfo(error.response?.headers).remaining,
      };
    }
    rethrowGitHubError(error, owner, name);
  }
}

/**
 * Fetches one page of a repository's releases for the history backfill. Never conditional: ETags
 * are per URL, and the stored `lastEtag` belongs to the poll URL (`per_page=20`) only.
 */
export async function fetchReleasesPage(params: {
  owner: string;
  name: string;
  /** 1-based GitHub page number. */
  page: number;
  perPage?: number;
  accessToken?: string | null;
  octokit?: Octokit;
  signal?: AbortSignal;
}): Promise<FetchReleasesPageResult> {
  const { owner, name, page, perPage = BACKFILL_PAGE_SIZE } = params;
  const octokit = params.octokit ?? createOctokit({ accessToken: params.accessToken });

  try {
    const response = await octokit.request("GET /repos/{owner}/{repo}/releases", {
      owner,
      repo: name,
      page,
      per_page: perPage,
      ...(params.signal ? { request: { signal: params.signal } } : {}),
    });
    const rateLimit = getRateLimitInfo(response.headers);
    return {
      releases: mapPublishedReleases(response.data),
      hasNextPage: hasNextLink(response.headers.link),
      rateLimitRemaining: rateLimit.remaining,
      rateLimitResetAt: rateLimit.resetAt,
    };
  } catch (error) {
    rethrowGitHubError(error, owner, name);
  }
}

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
export const RELEASES_PAGE_SIZE = 20;
/** Number of releases ingested when a repository is first added. */
export const INITIAL_RELEASES_LIMIT = 10;

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
  return {
    githubReleaseId: BigInt(release.id),
    tagName: release.tag_name,
    title: release.name?.trim() || release.tag_name,
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

function etagOf(headers: ResponseHeaders): string | null {
  const etag = headers.etag;
  return typeof etag === "string" && etag.length > 0 ? etag : null;
}

/** Converts Octokit HTTP errors into typed domain errors; re-throws everything else. */
function rethrowGitHubError(error: unknown, owner: string, name: string): never {
  if (isGitHubHttpError(error)) {
    const rateLimit = getRateLimitInfo(error.response?.headers);
    if (error.status === 429 || (error.status === 403 && rateLimit.remaining === 0)) {
      throw new GitHubRateLimitError(rateLimit.resetAt);
    }
    if (error.status === 404) {
      throw new GitHubRepositoryNotFoundError(owner, name);
    }
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
}): Promise<PollRepoReleasesResult> {
  const { owner, name, lastEtag } = params;
  const octokit = params.octokit ?? createOctokit({ accessToken: params.accessToken });

  try {
    const response = await octokit.request("GET /repos/{owner}/{repo}/releases", {
      owner,
      repo: name,
      per_page: RELEASES_PAGE_SIZE,
      headers: lastEtag ? { "If-None-Match": lastEtag } : {},
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

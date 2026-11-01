import type { Octokit } from "@octokit/rest";
import { createOctokit, getRateLimitInfo, isGitHubHttpError, type ResponseHeaders } from "./client.js";
import { classifySemver, type SemverType } from "./parser.js";
import { GitHubRateLimitError, GitHubRepositoryNotFoundError } from "./poller.js";

/** Tags read per poll (the tag counterpart of `RELEASES_PAGE_SIZE`). */
export const TAGS_PAGE_SIZE = 20;
/** Commit lines shown in a tag changelog before "…and N more". */
export const TAG_CHANGELOG_MAX_COMMITS = 50;
const COMPARE_PAGE_SIZE = 100;
const SUBJECT_MAX_LENGTH = 200;

export interface GitTag {
  name: string;
  /** Tagged commit. */
  sha: string;
  commitUrl: string;
  commitMessage: string;
  commitDate: Date;
  /** Annotated tags only. */
  message: string | null;
  taggerDate: Date | null;
}

export interface CompareCommit {
  sha: string;
  subject: string;
  htmlUrl: string;
  authorLogin: string | null;
}

export interface CompareResult {
  base: string;
  htmlUrl: string;
  totalCommits: number;
  /** Newest first, at most one page (100). */
  commits: CompareCommit[];
}

/** A tag in the `Release` row shape (`source = TAG`). */
export interface MappedTag {
  source: "TAG";
  githubReleaseId: null;
  tagSha: string;
  tagName: string;
  title: string;
  bodyMarkdown: string;
  htmlUrl: string;
  isPrerelease: boolean;
  isDraft: false;
  semverType: SemverType;
  publishedAt: Date;
}

// ---------------------------------------------------------------------------
// GraphQL: newest tags
// ---------------------------------------------------------------------------

const RECENT_TAGS_QUERY = /* GraphQL */ `
  query RecentTags($owner: String!, $name: String!, $first: Int!) {
    repository(owner: $owner, name: $name) {
      refs(refPrefix: "refs/tags/", first: $first, orderBy: { field: TAG_COMMIT_DATE, direction: DESC }) {
        nodes {
          name
          target {
            __typename
            ... on Commit { oid url message committedDate }
            ... on Tag {
              message
              tagger { date }
              target { __typename ... on Commit { oid url message committedDate } }
            }
          }
        }
      }
    }
  }
`;

interface GraphqlCommit {
  __typename: "Commit";
  oid: string;
  url: string;
  message: string;
  committedDate: string;
}

interface GraphqlTagNode {
  name: string;
  target:
    | GraphqlCommit
    | { __typename: "Tag"; message: string | null; tagger: { date: string | null } | null; target: GraphqlCommit | { __typename: string } }
    | { __typename: string };
}

interface RecentTagsResponse {
  repository: { refs: { nodes: GraphqlTagNode[] } | null } | null;
}

function isCommit(target: { __typename: string }): target is GraphqlCommit {
  return target.__typename === "Commit";
}

/** Tags pointing at a commit (directly or through an annotated tag). Tags of trees/blobs are skipped. */
export function mapGraphqlTag(node: GraphqlTagNode): GitTag | null {
  const { target } = node;
  if (isCommit(target)) {
    return {
      name: node.name,
      sha: target.oid,
      commitUrl: target.url,
      commitMessage: target.message,
      commitDate: new Date(target.committedDate),
      message: null,
      taggerDate: null,
    };
  }
  if (target.__typename === "Tag" && "target" in target && isCommit(target.target)) {
    const commit = target.target;
    const message = target.message?.trim() || null;
    return {
      name: node.name,
      sha: commit.oid,
      commitUrl: commit.url,
      commitMessage: commit.message,
      commitDate: new Date(commit.committedDate),
      message,
      taggerDate: target.tagger?.date ? new Date(target.tagger.date) : null,
    };
  }
  return null;
}

interface GraphqlErrorLike {
  name: string;
  errors?: Array<{ type?: string }>;
  headers?: ResponseHeaders;
}

function isGraphqlResponseError(error: unknown): error is GraphqlErrorLike {
  return typeof error === "object" && error !== null && (error as { name?: unknown }).name === "GraphqlResponseError";
}

/** Converts GraphQL and HTTP errors into the same typed errors as the REST helpers. */
function rethrowTagError(error: unknown, owner: string, name: string): never {
  if (isGraphqlResponseError(error)) {
    const types = (error.errors ?? []).map((e) => e.type);
    if (types.includes("RATE_LIMITED")) throw new GitHubRateLimitError(getRateLimitInfo(error.headers).resetAt);
    if (types.includes("NOT_FOUND")) throw new GitHubRepositoryNotFoundError(owner, name);
  }
  if (isGitHubHttpError(error)) {
    const rateLimit = getRateLimitInfo(error.response?.headers);
    if (error.status === 429 || (error.status === 403 && rateLimit.remaining === 0)) {
      throw new GitHubRateLimitError(rateLimit.resetAt);
    }
    if (error.status === 404) throw new GitHubRepositoryNotFoundError(owner, name);
  }
  throw error;
}

/**
 * The newest tags by commit date, newest first. GraphQL, because the REST tags endpoint returns
 * no dates and no defined order. GraphQL requires a token.
 */
export async function fetchRecentTags(params: {
  owner: string;
  name: string;
  first?: number;
  accessToken: string;
  octokit?: Octokit;
  signal?: AbortSignal;
}): Promise<GitTag[]> {
  const { owner, name, first = TAGS_PAGE_SIZE } = params;
  const octokit = params.octokit ?? createOctokit({ accessToken: params.accessToken });
  try {
    const data = await octokit.graphql<RecentTagsResponse>(RECENT_TAGS_QUERY, {
      owner,
      name,
      first,
      ...(params.signal ? { request: { signal: params.signal } } : {}),
    });
    if (!data.repository) throw new GitHubRepositoryNotFoundError(owner, name);
    return (data.repository.refs?.nodes ?? []).map(mapGraphqlTag).filter((tag): tag is GitTag => tag !== null);
  } catch (error) {
    if (error instanceof GitHubRepositoryNotFoundError) throw error;
    rethrowTagError(error, owner, name);
  }
}

// ---------------------------------------------------------------------------
// REST: commits between two tags
// ---------------------------------------------------------------------------

/** First line of a commit or tag message, trimmed and capped at 200 characters. */
export function subjectOf(message: string): string {
  const subject = message.split(/\r?\n/, 1)[0]?.trim() ?? "";
  return subject.length > SUBJECT_MAX_LENGTH ? `${subject.slice(0, SUBJECT_MAX_LENGTH - 1)}…` : subject;
}

interface CompareResponseData {
  html_url: string;
  total_commits: number;
  commits: Array<{ sha: string; html_url: string; commit: { message: string }; author: { login: string } | null }>;
}

/** Commits in `base...head` (`GET /repos/{owner}/{repo}/compare/{basehead}`). */
export async function compareCommits(params: {
  owner: string;
  name: string;
  base: string;
  head: string;
  accessToken?: string | null;
  octokit?: Octokit;
  signal?: AbortSignal;
}): Promise<CompareResult> {
  const { owner, name, base, head } = params;
  const octokit = params.octokit ?? createOctokit({ accessToken: params.accessToken });
  try {
    const response = await octokit.request("GET /repos/{owner}/{repo}/compare/{basehead}", {
      owner,
      repo: name,
      basehead: `${base}...${head}`,
      per_page: COMPARE_PAGE_SIZE,
      ...(params.signal ? { request: { signal: params.signal } } : {}),
    });
    const data = response.data as unknown as CompareResponseData;
    return {
      base,
      htmlUrl: data.html_url,
      totalCommits: data.total_commits,
      // GitHub lists them oldest first; changelogs read newest first.
      commits: [...data.commits].reverse().map((c) => ({
        sha: c.sha,
        subject: subjectOf(c.commit.message),
        htmlUrl: c.html_url,
        authorLogin: c.author?.login ?? null,
      })),
    };
  } catch (error) {
    rethrowTagError(error, owner, name);
  }
}

// ---------------------------------------------------------------------------
// Pure mapping
// ---------------------------------------------------------------------------

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function commitLine(commit: { sha: string; subject: string; htmlUrl: string; authorLogin?: string | null }): string {
  const author = commit.authorLogin ? ` — @${commit.authorLogin}` : "";
  return `- [\`${commit.sha.slice(0, 7)}\`](${commit.htmlUrl}) ${commit.subject || "(no message)"}${author}`;
}

/**
 * Markdown changelog of a tag: its annotation, the commits since the previous tag (newest first,
 * capped at {@link TAG_CHANGELOG_MAX_COMMITS}) and the comparison link. Without a previous tag
 * (or when the comparison failed), the tagged commit instead.
 */
export function buildTagChangelog(tag: GitTag, compare: CompareResult | null): string {
  const parts: string[] = [];
  if (tag.message) parts.push(tag.message);

  if (compare) {
    const shown = compare.commits.slice(0, TAG_CHANGELOG_MAX_COMMITS);
    const lines = shown.map(commitLine);
    const hidden = compare.totalCommits - shown.length;
    if (hidden > 0) lines.push(`- …and ${plural(hidden, "more commit")}`);
    parts.push(
      `### Commits since \`${compare.base}\``,
      lines.length > 0 ? lines.join("\n") : "_No commits between these tags._",
      `[Compare \`${compare.base}...${tag.name}\` on GitHub](${compare.htmlUrl}) · ${plural(compare.totalCommits, "commit")}`,
    );
  } else {
    parts.push("### Tagged commit", commitLine({ sha: tag.sha, subject: subjectOf(tag.commitMessage), htmlUrl: tag.commitUrl }));
  }
  return parts.join("\n\n");
}

/** Maps a tag to the `Release` row shape. */
export function mapTag(tag: GitTag, repoHtmlUrl: string, bodyMarkdown: string): MappedTag {
  const semverType = classifySemver(tag.name, false);
  return {
    source: "TAG",
    githubReleaseId: null,
    tagSha: tag.sha,
    tagName: tag.name,
    title: (tag.message ? subjectOf(tag.message) : "") || tag.name,
    bodyMarkdown,
    htmlUrl: `${repoHtmlUrl.replace(/\/+$/, "")}/releases/tag/${encodeURIComponent(tag.name)}`,
    isPrerelease: semverType === "PRERELEASE",
    isDraft: false,
    semverType,
    publishedAt: tag.taggerDate ?? tag.commitDate,
  };
}

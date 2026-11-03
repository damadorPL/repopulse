import type { Octokit } from "@octokit/rest";
import { createOctokit, isGitHubHttpError } from "./client.js";
import { toRateLimitError } from "./git-write.js";
import { GitHubRepositoryNotFoundError } from "./poller.js";
import { REPO_TREE_MAX_ENTRIES } from "./tree.js";

/**
 * Default-branch snapshot with blob SHAs (Slice 08, dependency scans): repository metadata, the head commit and
 * the recursive Git tree. Unlike {@link fetchRepoTree} (paths only, for the path picker) every entry keeps its
 * object SHA and size, so callers can skip unchanged blobs and read the rest with `readBlobs`.
 */

export interface GitTreeEntry {
  path: string;
  type: "blob" | "tree" | "commit";
  /** Object id (blob / tree SHA, or the submodule commit). */
  sha: string;
  /** Blob size in bytes; `null` for trees and submodules. */
  size: number | null;
}

export interface GitTreeRepository {
  id: number;
  owner: string;
  name: string;
  fullName: string;
  defaultBranch: string;
  isPrivate: boolean;
  htmlUrl: string;
}

export interface GitTreeSnapshot {
  repository: GitTreeRepository;
  /** Head commit of the default branch; `null` for an empty repository. */
  commitSha: string | null;
  /** Sorted by path, capped at `maxEntries` (shallowest kept first). */
  entries: GitTreeEntry[];
  /** GitHub truncated the tree, or it exceeded the cap. */
  truncated: boolean;
}

interface RawTreeData {
  tree?: Array<{ path?: string; type?: string; sha?: string | null; size?: number | null }>;
  truncated?: boolean;
}

/** Keeps blob / tree / commit entries with a path and SHA, capped like `mapRepoTree` (shallowest, folders first). */
export function mapGitTreeEntries(
  data: RawTreeData,
  maxEntries: number = REPO_TREE_MAX_ENTRIES,
): { entries: GitTreeEntry[]; truncated: boolean } {
  const all: GitTreeEntry[] = [];
  for (const entry of data.tree ?? []) {
    if (!entry.path || !entry.sha) continue;
    if (entry.type !== "blob" && entry.type !== "tree" && entry.type !== "commit") continue;
    all.push({
      path: entry.path,
      type: entry.type,
      sha: entry.sha,
      size: entry.type === "blob" && typeof entry.size === "number" ? entry.size : null,
    });
  }
  const depth = (path: string) => path.split("/").length;
  const kept =
    all.length > maxEntries
      ? [...all]
          .sort(
            (a, b) =>
              depth(a.path) - depth(b.path) ||
              Number(b.type === "tree") - Number(a.type === "tree") ||
              (a.path < b.path ? -1 : 1),
          )
          .slice(0, maxEntries)
      : all;
  return {
    entries: [...kept].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    truncated: data.truncated === true || all.length > maxEntries,
  };
}

function rethrow(error: unknown, label: { owner: string; name: string }): never {
  const rateLimited = toRateLimitError(error);
  if (rateLimited) throw rateLimited;
  if (isGitHubHttpError(error) && error.status === 404) throw new GitHubRepositoryNotFoundError(label.owner, label.name);
  throw error;
}

interface RepoData {
  id: number;
  name: string;
  full_name: string;
  default_branch: string;
  private: boolean;
  html_url: string;
  owner: { login: string };
}

/**
 * Repository metadata (`GET /repositories/{id}` when `repositoryId` is given, which follows renames, else
 * `GET /repos/{owner}/{repo}`), the default-branch head (`GET git/ref/heads/{branch}`) and its recursive tree
 * (`GET git/trees/{commit}?recursive=1`). Three requests. A missing repository throws
 * `GitHubRepositoryNotFoundError`, rate limits `GitHubRateLimitError`; an empty repository yields no entries.
 */
export async function fetchGitTree(params: {
  owner: string;
  name: string;
  repositoryId?: number;
  accessToken?: string | null;
  octokit?: Octokit;
  signal?: AbortSignal;
  maxEntries?: number;
}): Promise<GitTreeSnapshot> {
  const label = { owner: params.owner, name: params.name };
  const octokit = params.octokit ?? createOctokit({ accessToken: params.accessToken });
  const request = params.signal ? { request: { signal: params.signal } } : {};

  let repository: GitTreeRepository;
  try {
    const response =
      params.repositoryId !== undefined
        ? await octokit.request("GET /repositories/{repository_id}", { repository_id: params.repositoryId, ...request })
        : await octokit.request("GET /repos/{owner}/{repo}", { owner: params.owner, repo: params.name, ...request });
    const data = response.data as unknown as RepoData;
    repository = {
      id: data.id,
      owner: data.owner.login,
      name: data.name,
      fullName: data.full_name,
      defaultBranch: data.default_branch,
      isPrivate: data.private === true,
      htmlUrl: data.html_url,
    };
  } catch (error) {
    rethrow(error, label);
  }

  const { owner, name: repo, defaultBranch } = repository;
  let commitSha: string | null = null;
  try {
    const response = await octokit.request("GET /repos/{owner}/{repo}/git/ref/{ref}", {
      owner,
      repo,
      ref: `heads/${defaultBranch}`,
      ...request,
    });
    const data = response.data as { ref?: string; object?: { sha?: string } };
    commitSha = data.ref === undefined || data.ref === `refs/heads/${defaultBranch}` ? (data.object?.sha ?? null) : null;
  } catch (error) {
    // 409 "Git Repository is empty", 404 for a default branch without commits.
    if (!(isGitHubHttpError(error) && (error.status === 409 || error.status === 404))) rethrow(error, label);
  }
  if (commitSha === null) return { repository, commitSha: null, entries: [], truncated: false };

  try {
    const response = await octokit.request("GET /repos/{owner}/{repo}/git/trees/{tree_sha}", {
      owner,
      repo,
      tree_sha: commitSha,
      recursive: "1",
      ...request,
    });
    return { repository, commitSha, ...mapGitTreeEntries(response.data as RawTreeData, params.maxEntries) };
  } catch (error) {
    if (isGitHubHttpError(error) && error.status === 409) return { repository, commitSha, entries: [], truncated: false };
    rethrow(error, label);
  }
}

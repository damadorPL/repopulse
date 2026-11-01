import type { Octokit } from "@octokit/rest";
import { createOctokit, isGitHubHttpError } from "./client.js";
import { rethrowGitHubError } from "./poller.js";

/**
 * Most entries returned by {@link fetchRepoTree} (about 600 KB of paths). Shallower entries are kept
 * first, so top-level files such as `CHANGELOG.md` survive in large monorepos; deep entries beyond
 * the cap are dropped (they can still be typed).
 */
export const REPO_TREE_MAX_ENTRIES = 10_000;

/** The files and folders on a repository's default branch, for the "Files / folders" path picker. */
export interface RepoTree {
  defaultBranch: string;
  /** Folder paths, sorted. */
  dirs: string[];
  /** File paths (including symlinks and submodules), sorted. */
  files: string[];
  /** Not every entry is listed: GitHub truncated the tree, or it exceeded {@link REPO_TREE_MAX_ENTRIES}. */
  truncated: boolean;
}

interface GitTreeData {
  tree?: Array<{ path?: string; type?: string }>;
  truncated?: boolean;
}

/**
 * Splits a recursive Git tree into sorted folders and files, capped at `maxEntries`: shallowest
 * first, folders before files at the same depth.
 */
export function mapRepoTree(
  defaultBranch: string,
  data: GitTreeData,
  maxEntries: number = REPO_TREE_MAX_ENTRIES,
): RepoTree {
  const entries: Array<{ path: string; dir: boolean; depth: number }> = [];
  for (const entry of data.tree ?? []) {
    if (!entry.path) continue;
    // "blob" (files, symlinks) and "commit" (submodules: a commit changes the gitlink path) are files.
    if (entry.type !== "tree" && entry.type !== "blob" && entry.type !== "commit") continue;
    entries.push({ path: entry.path, dir: entry.type === "tree", depth: entry.path.split("/").length });
  }
  const kept =
    entries.length > maxEntries
      ? entries
          .sort((a, b) => a.depth - b.depth || Number(b.dir) - Number(a.dir) || (a.path < b.path ? -1 : 1))
          .slice(0, maxEntries)
      : entries;
  return {
    defaultBranch,
    dirs: kept.filter((entry) => entry.dir).map((entry) => entry.path).sort(),
    files: kept.filter((entry) => !entry.dir).map((entry) => entry.path).sort(),
    truncated: data.truncated === true || entries.length > maxEntries,
  };
}

/**
 * Lists every file and folder on the default branch: `GET /repos/{owner}/{repo}` for the branch,
 * then `GET /repos/{owner}/{repo}/git/trees/{branch}?recursive=1` (GitHub truncates very large trees
 * at 100,000 entries / 7 MB). An empty repository yields an empty tree. Two requests.
 */
export async function fetchRepoTree(params: {
  owner: string;
  name: string;
  accessToken?: string | null;
  octokit?: Octokit;
  signal?: AbortSignal;
}): Promise<RepoTree> {
  const { owner, name } = params;
  const octokit = params.octokit ?? createOctokit({ accessToken: params.accessToken });
  const request = params.signal ? { request: { signal: params.signal } } : {};

  let defaultBranch: string;
  try {
    const repo = await octokit.request("GET /repos/{owner}/{repo}", { owner, repo: name, ...request });
    defaultBranch = repo.data.default_branch;
  } catch (error) {
    rethrowGitHubError(error, owner, name);
  }

  try {
    const response = await octokit.request("GET /repos/{owner}/{repo}/git/trees/{tree_sha}", {
      owner,
      repo: name,
      tree_sha: defaultBranch,
      recursive: "1",
      ...request,
    });
    return mapRepoTree(defaultBranch, response.data as GitTreeData);
  } catch (error) {
    // The repository exists (checked above): 409 "Git Repository is empty", or 404 for a default
    // branch that has no commits yet.
    if (isGitHubHttpError(error) && (error.status === 409 || error.status === 404)) {
      return { defaultBranch, dirs: [], files: [], truncated: false };
    }
    rethrowGitHubError(error, owner, name);
  }
}

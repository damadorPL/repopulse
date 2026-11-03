import {
  closePullRequest,
  commitFiles,
  createAppOctokit,
  createInstallationToken,
  createOctokit,
  fetchGitTree,
  getCollaboratorPermission,
  getPullRequestState,
  getRepoInstallation,
  getUserLoginById,
  inspectBranch,
  readBlobs,
  treeHasContent,
  upsertPullRequest,
} from "@repopulse/github";

/**
 * The `@repopulse/github` calls the deps-worker makes, as one injectable object: processors take `github` in their
 * `deps`, so tests swap in an in-memory repository instead of faking HTTP.
 */
export const defaultGitHubApi = {
  createOctokit,
  createAppOctokit,
  getRepoInstallation,
  createInstallationToken,
  getCollaboratorPermission,
  getUserLoginById,
  fetchGitTree,
  readBlobs,
  getPullRequestState,
  inspectBranch,
  treeHasContent,
  commitFiles,
  upsertPullRequest,
  closePullRequest,
};

export type GitHubApi = typeof defaultGitHubApi;
export type Octokit = ReturnType<GitHubApi["createOctokit"]>;

# `@repopulse/github` (`packages/github`)

> **Summary:** Octokit wrapper (with `@octokit/plugin-retry`), repository-input parser, SemVer classifier, ETag release poller, release paging, GraphQL tag reader, REST commit compare and path-commit reader, recursive Git tree reader, watched-path matching, GitHub App manifest/auth/webhook helpers, and Git Data API PR writes.
>
> **Related Docs:** [../guides/auth-and-access.md](../guides/auth-and-access.md) · [../apps/worker.md](../apps/worker.md) · [../apps/deps-worker.md](../apps/deps-worker.md)

## Rules

- **MUST NOT** import `node:*` modules from the browser-safe subpath `@repopulse/github/watched-paths` (`paths.ts` helpers used by `apps/web` client components).
- **MUST NOT** leak App private keys, JWTs, or installation tokens in errors (`GitHubAppAuthError`, `GitHubAppInstallationError`, `rethrowAppError` preserves network/timeout failures separately from invalid credentials).
- **MUST** scope installation tokens to the single target repository and minimum permissions (`contents: read` + `pull_requests: read` for scans; `contents: write` + `pull_requests: write` for updates; `metadata: read` for web checks).
- **MUST** verify webhook signatures in constant time (`verifyWebhookSignature`).
- **MUST** use `.js` extensions on relative ESM imports and run `pnpm --filter "./packages/*" build` after edits.

## Public Exports (`packages/github/src/index.ts`)

| Export / Group | What |
| --- | --- |
| `parseRepoInput(input)` → `{ owner, name }`, `InvalidRepositoryInputError`, `classifySemver(tag)` | Accepts `owner/repo`, `github.com/owner/repo(.git)`, full URLs (deep links too), `git@github.com:owner/repo.git`. Classifies tags into `MAJOR` / `MINOR` / `PATCH` / `PRERELEASE` / `OTHER` |
| `createOctokit({ token })`, `GITHUB_USER_AGENT`, `getRateLimitInfo(headers)`, `isGitHubHttpError` | Octokit factory with retry plugin, user-agent header, and header/rate-limit inspection |
| `validateAndFetchRepo({ owner, name, token })` | Fetches repo metadata, latest `INITIAL_RELEASES_LIMIT` (10) published releases, and releases `ETag` |
| `pollRepoReleases({ …, etag, signal })` | Conditional GET of `RELEASES_PAGE_SIZE` (20): `NOT_MODIFIED` or `UPDATED` with releases, new `ETag`, and remaining quota |
| `fetchReleasesPage({ page })`, `hasNextLink`, `BACKFILL_PAGE_SIZE` (100), `mapRelease` | Unconditional release paging for history backfill; drafts excluded upstream |
| `GitHubRepositoryNotFoundError` (404), `GitHubRateLimitError` (`resetAt`; 403 quota 0, secondary `retry-after`, or 429) | Typed errors mapped by `toActionError` and worker rate-limit handlers |
| `fetchRecentTags` (GraphQL, token required), `compareCommits`, `buildTagChangelog`, `mapTag`, `mapGraphqlTag`, `TAGS_PAGE_SIZE` (20), `TAG_CHANGELOG_MAX_COMMITS` (50) | Tag tracking (`TAGS_AND_COMMITS`) |
| `fetchCommitsForPath` (REST, `PATH_COMMITS_PAGE_SIZE` 10, `etag`/`since`, 409 empty repo = `[]`), `fetchCommitDetail`, `buildCommitChangelog`, `mapPathCommit`, `COMMIT_CHANGELOG_MAX_FILES` (50) | "Files / folders" commit tracking |
| `fetchRepoTree`, `mapRepoTree`, `REPO_TREE_MAX_ENTRIES` (10,000, shallowest first, `truncated` flag) | Default-branch recursive Git tree for the web path picker |
| `@repopulse/github/watched-paths`: `normalizeWatchedPath`, `parseWatchedPaths`, `commitMatchesPath`, `commitMatchesAnyPath`, `MAX_WATCHED_PATHS` (10), `MAX_WATCHED_PATH_LENGTH` (240) | Pure browser-safe watched-path normalization and matching |
| `fetchGitTree({ owner, name, repositoryId?, knownCommitSha?, octokit })`, `mapGitTreeEntries` | Dependency scan tree fetch (by `repositoryId` so renames are followed; skips unchanged `knownCommitSha`) |
| `createAppOctokit` (LRU-cached), `clearAppOctokitCache`, `getAuthenticatedApp`, `convertAppManifest`, `buildAppManifest`, `appManifestFormUrl`, `defaultAppName`, `getRepoInstallation`, `createInstallationToken`, `getCollaboratorPermission`, `permissionAtLeast`, `getUserLoginById`, `installUrl`, `isValidGitHubLogin`, `GitHubAppAuthError`, `GitHubAppInstallationError` | GitHub App authentication, manifest exchange, installation lookup, and collaborator permission checks (`app.ts`) |
| `getAppWebhookConfig`, `updateAppWebhookConfig`, `verifyWebhookSignature`, `signWebhookPayload` | GitHub App webhook configuration and HMAC-SHA256 verification (`app-hook.ts`) |
| `readBlobs` (batched GraphQL), `commitFiles` (blobs → tree → commit without author → create/force-update ref; 409/422 → `RefUpdateConflictError`), `inspectBranch`, `branchIsBotOwned`, `getBranchHead`, `treeHasContent`, `treeMatchesFiles`, `gitBlobSha`, `upsertPullRequest`, `closePullRequest`, `getPullRequestState`, `toRateLimitError`, `rethrowRateLimit`, `GIT_WRITE_CONCURRENCY` (4) | Dependency update PR creation and branch management via Git Data API (`git-write.ts`) |

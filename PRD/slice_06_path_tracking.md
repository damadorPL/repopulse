# Agent Implementation Slice 06: File & Subdirectory Change Tracking ("Files / folders")

## 1. Objective & Scope
Many repositories never publish GitHub Releases or Git tags, or are monorepos / plugin collections where a user only cares about changes to specific files (e.g. `CHANGELOG.md`, `schema.prisma`) or subdirectories (e.g. `packages/cli`, `plugins/foo`). This slice extends `TrackMode` with a third mode that tracks commits touching user-specified repo-relative file or directory paths:

* `RELEASES` (default, unchanged): only GitHub Releases.
* `TAGS_AND_COMMITS` ("Releases + tags", Slice 04c): GitHub Releases plus Git tags without a Release.
* `PATHS` ("Files / folders"): commits on the default branch that modify any of the subscription's watched file or directory paths. Each matching commit becomes one feed entry (`tagName` = 7-char short SHA, `title` = commit subject) whose changelog includes the full commit message, author, commit link, and the list of changed files with `+/-` line counts.

* **Prerequisites:** Slices 01–04, 04b, 04c, and 05.
* **Out of Scope:**
  * Deep historical pagination of path commits beyond the newest page (`PATH_COMMITS_PAGE_SIZE = 10` per watched path per poll).
  * Rendering full unified diffs / patches in the changelog body (only file paths, statuses, and `+additions / -deletions` counts are stored).
  * Tracking non-default branches.
  * Force-push / rebase history rewriting cleanup (once a commit SHA is stored, it is kept).

### Design constraints
* **Shared `Repository`/`Release` rows, per-user path scoping.** Multiple users may subscribe to the same repository in different modes or watch different paths on the same repository:
  * A `RELEASES` or `TAGS_AND_COMMITS` subscriber never sees `source = COMMIT` rows.
  * A `PATHS` subscriber sees only `source = COMMIT` rows that match their own `watchedPaths` (tracked via `UserReleaseState`: `isRead = false` for unread fresh commits, `isRead = true` for read or older seeded commits).
* **Deduplicated GitHub polling.** Across all `PATHS` subscribers of a repository, watched paths are deduplicated before querying `GET /repos/{owner}/{repo}/commits?path=<path>`. If a single commit touches multiple watched paths, its commit detail (`GET /repos/{owner}/{repo}/commits/<sha>`) is fetched once and stored as a single `Release` row (`source = COMMIT`).
* **Best-effort path step.** Like the tag step in Slice 04c, path polling runs after the release step and is best-effort: an error or rate limit is logged and skipped so it never fails release polling or pauses the `repo-poll` queue.

---

## 2. Target Files to Create / Modify
```text
packages/db/prisma/schema.prisma                        + TrackMode.PATHS, ReleaseSource.COMMIT,
                                                          Repository.lastPathsPolledAt, Repository.polledPaths,
                                                          Release.changedPaths, UserSubscription.watchedPaths
packages/db/prisma/migrations/<ts>_path_tracking/       migration.sql
packages/github/src/paths.ts (+ paths.test.ts)          normalizeWatchedPath(), parseWatchedPaths(), commitMatchesPath(),
                                                          fetchCommitsForPath(), fetchCommitDetail(),
                                                          buildCommitChangelog(), mapPathCommit()
packages/github/src/index.ts                            export path tracking API and constants
apps/worker/src/processors/repo-paths.ts (+ .test.ts)   pollRepoPaths(), tracksPaths(), per-subscriber path matching & fan-out
apps/worker/src/processors/repo-poll.processor.ts       run pollRepoPaths when any subscriber uses TrackMode.PATHS
apps/web/src/lib/watched-paths.ts (+ .test.ts)          client/server shared path parsing, validation & formatting helpers
apps/web/src/server/queries/feed.ts                     visibleReleasesWhere honors COMMIT + userStates;
                                                          TrackedRepository.watchedPaths; latestRelease for PATHS mode
apps/web/src/server/actions/repositories.ts             addRepositoryAction + updateTrackModeAction accept watchedPaths,
                                                          seed matching stored commits, queue poll when new paths are added
apps/web/src/components/modals/add-repo-modal.tsx       3-mode selector + watched paths input when "Files / folders" is chosen
apps/web/src/components/repositories/track-mode-toggle.tsx  mode switcher + watched paths popover/editor on repository cards
apps/web/src/components/feed/source-badge.tsx           + CommitSourceBadge ("Commit" badge)
apps/web/src/components/feed/release-card.tsx           render CommitSourceBadge when source === "COMMIT"
apps/web/src/components/reader/changelog-drawer.tsx     render CommitSourceBadge when source === "COMMIT"
```

---

## 3. Step-by-Step Agent Instructions

### Step 3.1: Schema (`packages/db`)
1. Extend enums:
   * `enum TrackMode { RELEASES TAGS_AND_COMMITS PATHS }`
   * `enum ReleaseSource { RELEASE TAG COMMIT }`
2. Add fields:
   * `Repository.lastPathsPolledAt DateTime?`: `null` until path commits have been polled at least once.
   * `Repository.polledPaths String[] @default([])`: normalized repo-relative paths that have already had their initial poll on this repository (used to distinguish a newly added watched path from an already-polled path).
   * `Release.changedPaths String[] @default([])`: repo-relative file paths modified by a `COMMIT` row (plus the matched watched path prefixes as fallback when commit file details are unavailable or truncated).
   * `UserSubscription.watchedPaths String[] @default([])`: normalized repo-relative file or directory paths watched when `trackMode = PATHS`.
3. Create migration `packages/db/prisma/migrations/<timestamp>_path_tracking/migration.sql`.

### Step 3.2: `@repopulse/github` path commits API (`packages/github/src/paths.ts`)
1. **Path normalization & matching (`normalizeWatchedPath`, `parseWatchedPaths`, `commitMatchesPath`, `commitMatchesAnyPath`):**
   * `normalizeWatchedPath(raw)`: trims whitespace, strips leading `/` or `./` and trailing `/`, collapses repeated `/`. Returns `null` if empty, `.` or `..`, contains a `..` segment, contains `\`, `?`, `#`, or control characters, or exceeds `MAX_WATCHED_PATH_LENGTH` (240).
   * `parseWatchedPaths(input: string | readonly string[])`: splits strings on newlines or commas, normalizes each entry, deduplicates while preserving order. Enforces `MAX_WATCHED_PATHS = 10`.
   * `commitMatchesPath(changedPath, watchedPath)`: returns `true` when `changedPath === watchedPath` or `changedPath.startsWith(`${watchedPath}/`)`.
2. **Fetching commits for a path (`fetchCommitsForPath`):**
   * Calls `GET /repos/{owner}/{repo}/commits` with `{ path, per_page: first }` (`PATH_COMMITS_PAGE_SIZE = 10`).
   * Returns `PathCommitSummary[]`: `{ sha, htmlUrl, message, committedDate, authorName, authorLogin }`, newest first.
   * Maps `404` → `GitHubRepositoryNotFoundError` and `403` (quota 0) / `429` → `GitHubRateLimitError`.
3. **Fetching commit file details (`fetchCommitDetail`):**
   * Calls `GET /repos/{owner}/{repo}/commits/{ref}` for a specific commit SHA.
   * Returns `CommitDetail`: `{ sha, stats: { additions, deletions, total }, files: Array<{ filename, status, additions, deletions, previousFilename? }> }`.
4. **Building the changelog (`buildCommitChangelog`):**
   * Pure function returning Markdown:
     * Optional multi-line commit body (everything after the first subject line of `commit.message`).
     * Author line (e.g. `Committed by **@login**` or author name).
     * `### Changed files` section: up to `COMMIT_CHANGELOG_MAX_FILES = 50` bullets formatted as `` - `path/to/file.ts` (+12 / -3) `` (with `(added)`, `(removed)`, `(renamed from \`old\`)` status notes when applicable), followed by `- …and N more files` if truncated.
     * Footer link: `[View commit \`<sha7>\` on GitHub](<htmlUrl>) · N files changed (+A / -D)`.
     * If `detail` is `null` (detail request failed), falls back to listing the matched watched path(s) and the commit link.
5. **Mapping to `Release` (`mapPathCommit`):**
   * `source = "COMMIT"`, `githubReleaseId = null`, `tagSha = commit.sha`, `tagName = commit.sha.slice(0, 7)`.
   * `title = subjectOf(commit.message) || tagName`.
   * `htmlUrl = commit.htmlUrl`, `isPrerelease = false`, `isDraft = false`, `semverType = "OTHER"`, `publishedAt = commit.committedDate`.
   * `changedPaths`: unique list of `detail.files.map(f => f.filename)` merged with the matched watched paths.

### Step 3.3: Worker path step (`apps/worker/src/processors/repo-paths.ts` & `repo-poll.processor.ts`)
1. In `processRepoPoll`, query whether the repository has any `PATHS` subscriber with non-empty `watchedPaths`.
2. Run `pollRepoPaths` after the release and tag steps:
   1. Load all `PATHS` subscribers and collect the union of their normalized `watchedPaths`.
   2. Partition the union into `previouslyPolled` (in `repository.polledPaths`) and `newlyAdded` (not yet in `repository.polledPaths`).
   3. For each distinct watched path, call `fetchCommitsForPath({ owner, name, path })` using `tokenCandidates` fallback (moving on to the next token on `401`). Record which watched path(s) returned each commit SHA.
   4. Check which commit `tagName`s (`sha.slice(0, 7)`) or `tagSha`s are already stored in `Release` (`source = "COMMIT"`) for this repository:
      * For **unknown commits**, call `fetchCommitDetail` (best effort: warn and fall back to `null` on failure) and build `MappedPathCommit` rows. Insert with `createManyAndReturn({ skipDuplicates: true })`.
      * For **already-stored commits** that were returned by a `newlyAdded` path, merge the newly matched path into `changedPaths` if needed.
   5. **Per-subscriber state & fan-out planning:**
      * For each `PATHS` subscriber, filter the poll's commits to those whose `changedPaths` match at least one of the subscriber's `watchedPaths`.
      * If a subscriber's matching commits come from an **already-polled path** (`previouslyPolled`), commits published after the newest stored `COMMIT` row before this poll are **fresh**: they go through `planFanOut` (creating `isRead: false` states, SSE `NEW_RELEASE` deliveries, and `notification-dispatch` jobs, capped at `INITIAL_RELEASES_LIMIT = 10`).
      * If a subscriber's matching commits come only from a **newly-added path** (initial import for that path), mark up to `INITIAL_RELEASES_LIMIT` (10) newest matching commits as unread (`isRead: false`), mark any older matching commits in the batch as read (`isRead: true`), and emit SSE `NEW_RELEASE` / `SYNC_COMPLETED` so the browser updates live, **without** enqueuing external `notification-dispatch` jobs for pre-existing commit history.
   6. Update `Repository.lastPathsPolledAt = now()` and `Repository.polledPaths` (union of existing `polledPaths` and the polled paths).
3. Merge the path step's `FanOutPlan` into the poll's combined `FanOutPlan` via `mergeFanOutPlans`.
4. Like `pollRepoTags`, `pollRepoPaths` is **best effort**: any error is logged and skipped so release polling is unaffected.

### Step 3.4: Visibility & Feed Queries (`apps/web/src/server/queries/feed.ts`)
1. Update `visibleReleasesWhere(userId, subscriptionFilter)`:
   * A release row is visible when the user subscribes to its repository (matching `subscriptionFilter`), pre-release rules hold, and one of:
     * `source = "RELEASE"` and the user's subscription has `trackMode in ["RELEASES", "TAGS_AND_COMMITS"]`
     * `source = "TAG"` and the user's subscription has `trackMode = "TAGS_AND_COMMITS"`
     * `source = "COMMIT"` and the user's subscription has `trackMode = "PATHS"` **and** `userStates: { some: { userId } }`
2. Update `getTrackedRepositories(userId)`:
   * Include `watchedPaths: string[]` on `TrackedRepository`.
   * When picking `latestRelease` for a `PATHS` subscription, pick the newest `COMMIT` row that has a `userStates` row for `userId`.

### Step 3.5: Server Actions (`apps/web/src/server/actions/repositories.ts`)
1. Validate `trackMode` with `z.enum(["RELEASES", "TAGS_AND_COMMITS", "PATHS"])` and `watchedPaths` (required and non-empty when `trackMode === "PATHS"`, normalized via `parseWatchedPaths`).
2. In `addRepositoryAction`:
   * Store `trackMode` and `watchedPaths` on `UserSubscription`.
   * When `trackMode === "PATHS"`:
     * If the repository already has stored `COMMIT` rows matching `watchedPaths`, seed `UserReleaseState` rows (`isRead: false` for the newest 10, `isRead: true` for older matching ones).
     * If any of `watchedPaths` is not yet in `repository.polledPaths` (or `lastPathsPolledAt === null`), queue a priority `repo-poll` job (`queueTagImport` / `queueRepoImport`).
3. In `updateTrackModeAction`:
   * Accept `{ subscriptionId, trackMode, watchedPaths?: string[] }`.
   * When switching to `PATHS` or updating `watchedPaths`:
     * Validate that at least one valid path is provided.
     * Prune `UserReleaseState` rows for `source = "COMMIT"` on that repository whose `changedPaths` no longer match the user's new `watchedPaths`.
     * Seed `UserReleaseState` rows for any already-stored `COMMIT` rows on that repository that match the new `watchedPaths`.
     * If any path in `watchedPaths` is not in `repository.polledPaths`, queue a priority `repo-poll` job and return `importing: true`.

### Step 3.6: UI (`apps/web/src/components/...`)
1. **`AddRepoModal` (`add-repo-modal.tsx`):**
   * Replace the single "Also track Git tags" checkbox with a 3-option "Tracking mode" selector:
     * **Releases only** (`RELEASES`)
     * **Releases + tags** (`TAGS_AND_COMMITS`)
     * **Files / folders** (`PATHS`)
   * When **Files / folders** is selected, display a paths input (`CHANGELOG.md, packages/cli`) with helper text explaining that repo-relative file or folder paths are supported, and hide the "Include pre-releases" checkbox (commits have no pre-release flag).
2. **`TrackModeToggle` (`track-mode-toggle.tsx`):**
   * Allow switching between `Releases`, `Releases + tags`, and `Files / folders` on a repository card, and editing the watched paths in a popover when `Files / folders` is selected.
3. **`CommitSourceBadge` (`source-badge.tsx`, `release-card.tsx`, `changelog-drawer.tsx`):**
   * Add a `Commit` badge (`GitCommitHorizontalIcon`) rendered whenever `item.source === "COMMIT"`.

---

## 4. Verification & Acceptance Criteria
- [ ] Adding a repository in "Files / folders" mode with one or more file/subdirectory paths (e.g. `README.md`, `packages/db`) validates the paths, stores the subscription, and queues an immediate background import poll.
- [ ] Within a poll, recent commits touching the watched paths appear in the feed with `tagName` = 7-char SHA, `title` = commit subject, a `Commit` badge, and a changelog listing the commit message, author, commit link, and changed files with `+/-` line counts.
- [ ] Two users watching different paths on the same repository each see only commits touching their own watched paths; `RELEASES` and `TAGS_AND_COMMITS` subscribers of the same repository never see `COMMIT` entries.
- [ ] Initial import of a watched path marks up to 10 newest commits unread without firing external webhook/email notification rules; subsequent polls fan out genuinely new commits to unread state, SSE, and notification rules.
- [ ] Editing watched paths on `/repositories` updates visible commit entries immediately and queues a poll if any newly added path has not been polled yet.
- [ ] A GitHub error or rate limit during the path step is logged and skipped without failing release polling or pausing the `repo-poll` queue.
- [ ] `pnpm --filter "./packages/*" build && pnpm typecheck && pnpm lint && pnpm test && pnpm --filter @repopulse/web build` passes with unit tests covering path normalization/matching, GitHub API helpers, changelog formatting, `pollRepoPaths`, and visibility queries.

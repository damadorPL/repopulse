# Slice 06 — Implementation Summary

**Spec:** [`slice_06_path_tracking.md`](./slice_06_path_tracking.md)
**Status:** Implemented. Package builds, typecheck, lint, all unit tests (github 98, notifications 74, worker 79, web 87,
queue 20, db 12) and the web production build pass. The migration was generated with `prisma migrate diff` against the
previous schema but **not applied to a database** (Docker was not running). Not yet checked end to end against real
GitHub (see §5).
**Date:** 2026-11-01

---

## 1. Files

```text
packages/db/prisma/
├── schema.prisma                                 TrackMode.PATHS, ReleaseSource.COMMIT, Repository.lastPathsPolledAt / polledPaths,
│                                                   Release.changedPaths, UserSubscription.watchedPaths
└── migrations/20261101180000_path_tracking/      NEW

packages/github/
├── package.json                                  + "./watched-paths" subpath export (browser-safe)
└── src/
    ├── watched-paths.ts                          NEW normalizeWatchedPath, parseWatchedPaths, commitMatchesPath, commitMatchesAnyPath
    ├── paths.ts (+ paths.test.ts)                NEW fetchCommitsForPath, fetchCommitDetail, buildCommitChangelog, mapPathCommit
    ├── poller.ts / tags.ts                       rethrowGitHubError and subjectOf exported for reuse
    └── index.ts                                  exports

packages/notifications/src/                       source "COMMIT": "Commit" kind label, "new commit" titles, "View commit on GitHub"

apps/worker/src/processors/
├── repo-paths.ts (+ repo-paths.test.ts)          NEW pollRepoPaths, planPathFanOut, tracksPaths
├── repo-tags.ts                                  loadSubscribers + watchedPaths, tracksReleases; tag lookup ignores COMMIT rows
└── repo-poll.processor.ts                        path step after the tag step; release step skips PATHS subscribers;
                                                    tag freshness ignores COMMIT rows; clears polledPaths when nobody watches paths

apps/web/src/
├── lib/watched-paths.ts (+ test)                 NEW validateWatchedPaths, formatWatchedPaths, summarizeWatchedPaths
├── lib/track-modes.ts                            NEW TRACK_MODE_OPTIONS (client-safe TrackMode union)
├── server/commit-states.ts (+ test)              NEW planCommitStates / syncCommitStates (prune + seed), needsPathImport
├── server/repo-poll-queue.ts                     queueTagImport → queueRepoImport (tags and paths)
├── server/queries/feed.ts                        visibleReleasesWhere per source; TrackedRepository.watchedPaths; latest commit for PATHS
├── server/actions/repositories.ts                addRepositoryAction / updateTrackModeAction: PATHS + watchedPaths
├── components/feed/source-badge.tsx              + CommitSourceBadge
├── components/feed/release-card.tsx, reader/changelog-drawer.tsx   Commit badge (instead of the semver badge), "Committed"
├── components/modals/add-repo-modal.tsx          3-way "Tracking mode" selector + paths input
├── components/repositories/track-mode-toggle.tsx mode Select + watched paths popover
└── app/(dashboard)/repositories/page.tsx         passes watchedPaths; hides release history / pre-release info in PATHS mode
```

## 2. How it works

- **Storage.** One `Release` row per commit (`source = COMMIT`, `tagName` = short SHA, `tagSha` = full SHA), shared by
  everyone watching paths of the repository. `changedPaths` holds the changed files (renames: both names) plus the
  watched paths the commit was found through, so it still matches them when the file list failed or was truncated.
- **Visibility.** Commit rows are visible only in `PATHS` mode **and** only with a `UserReleaseState` row for the user.
  The state row is what records "this commit matched my paths". GitHub Releases are no longer visible in `PATHS` mode,
  and the release fan-out skips `PATHS` subscribers.
- **Polling.** Watched paths of all `PATHS` subscribers are deduplicated. For each: newest 10 commits (REST, works
  anonymously), then one detail request per unknown commit. Per subscriber, only commits returned by one of the
  subscriber's own paths count:
  - **New** (unread, SSE, notification rules, 10 per user): inserted by this poll and returned by a path that was
    already polled before.
  - **Imported** (newest 10 unread, the rest read, SSE, no notification rules): returned by a path not in
    `polledPaths` yet. Commits the user already has a state for (seeded on add) are left alone.
- **Changing paths.** `syncCommitStates` (add and mode/path changes) drops states of commits that no longer match and
  seeds stored matching commits (newest 10 unread). A path not yet in `polledPaths` queues a priority poll
  (`importing: true`, "Importing commits…" toast).

## 3. Deviations from the spec

| Spec | Implemented | Why |
| --- | --- | --- |
| Fresh = published after the newest stored `COMMIT` row | Fresh = inserted by this poll and returned by an already polled path, no date check | A polled path's newest 10 commits are all stored, so an unknown one is new on the branch. A merged branch (merge commit, not squash) brings commits with older dates. The date rule would have filed them silently as read. |
| `polledPaths` = union of existing and polled paths | `polledPaths` = the paths polled now. It is cleared when no subscriber watches paths any more | A path nobody watched for a while and then watched again is a quiet import, not up to 10 notifications for old commits. |
| Subscriber matching via `changedPaths` | Polls: "returned by one of the subscriber's own paths". Actions: `changedPaths` match | GitHub already filtered by that path, which is exact. Another user's path can return a commit that was never in this user's newest 10. |
| "emit SSE NEW_RELEASE / SYNC_COMPLETED" for imports | `NEW_RELEASE` only | The browser batches these into one toast plus a refresh. A `SYNC_COMPLETED` would show a second toast. |
| — | Watched paths are kept when switching to another mode | Switching back restores them without retyping. Only `PATHS` mode uses them. |
| — | A commit whose short SHA is already taken by another stored commit is skipped | `(repositoryId, source, tagName)` is unique. Such a commit can never be inserted, so its detail request is not repeated every poll. |
| — | Tag freshness and tag lookup ignore `COMMIT` rows | Frequent commit rows would push new tags into read history. |
| — | Notification formatters handle `COMMIT` | They would otherwise say "v… released" for a commit. |

## 4. Known limitations

- Cost: one request per distinct watched path per poll, even when nothing changed (no ETag on this endpoint), plus
  one per new commit. Up to 10 paths per subscriber.
- The live toast says "New release" for commits: the `NEW_RELEASE` event carries no source.
- History rewrites (force-push) bring the rewritten commits in as new. Stored commits are never removed.
- `syncCommitStates` matches all stored commit rows of the repository in memory. That's fine at self-hosted scale. A
  SQL `unnest` + `LIKE` query is the upgrade path.
- The notification processor does not re-check that the subscription is still in `PATHS` mode when it sends a
  queued commit notification.
- Commit file lists come from the first detail page only (GitHub returns up to 300 files). The rest are reported as
  "…and more files".

## 5. Not verified yet

- Applying `20261101180000_path_tracking` to a real database. Run `pnpm db:migrate:deploy`, then the `migrate diff`
  check from `docs/data-model.md`.
- The acceptance criteria end to end against real GitHub: adding a "Files / folders" repository, two users watching
  different paths, the quiet initial import, then a new commit triggering a notification rule.
- The card popover flow in a browser (choosing "Files / folders" without saved paths opens the editor). Only the
  production build ran.

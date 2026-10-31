# Agent Implementation Slice 04b: Release History Backfill

## 1. Objective & Scope
Today a tracked repository only holds its **newest ~20 releases**. Adding a repo ingests the newest 10, and the first poll backfills releases 11–20.
Nothing ever pages back through older history. This slice adds a **background, rate-limit-aware backfill** of older releases.

The backfill runs on the Slice 04 BullMQ worker. Older releases become browsable in the feed (cursor "Load more") and in the changelog reader,
**without** flooding anyone's unread counter.

* **Prerequisites:** Slices 01–04 completed. This slice needs the BullMQ worker, the `repo-poll` queue, Redis pub/sub and the SSE listener.
* **Out of Scope:**
  * Tags-and-commits tracking (`TrackMode.TAGS_AND_COMMITS`).
  * Re-syncing edited bodies of releases that are already stored.
  * Notifications for historical releases. A backfill must never notify.

### Why it is a separate job
Very active repositories have thousands of releases (`vercel/next.js` publishes canaries daily). Paging through all of them during "Add repository"
would block the request and could use dozens of API calls from the user's 5,000 req/h quota. Instead, the add stays fast (newest 10) and the history
arrives a few seconds later in the background.

---

## 2. Target Files to Create / Modify
```text
repopulse/
├── packages/
│   ├── db/prisma/
│   │   ├── schema.prisma                         # + BackfillStatus enum, Repository backfill fields
│   │   └── migrations/<ts>_release_backfill/     # new migration
│   └── github/src/
│       ├── poller.ts                             # + fetchReleasesPage()
│       └── poller.test.ts                        # + paging / rate-limit tests
├── apps/
│   ├── worker/src/
│   │   ├── queues/index.ts                       # + releaseBackfillQueue ("release-backfill")
│   │   └── processors/
│   │       └── release-backfill.processor.ts     # pages older releases, inserts as already-read history
│   └── web/src/
│       ├── server/actions/
│       │   ├── repositories.ts                   # enqueue backfill after addRepositoryAction
│       │   └── backfill.ts                       # requestDeepBackfillAction ("Load older releases")
│       └── app/(dashboard)/repositories/page.tsx # history status + "Load older releases" button
```

---

## 3. Step-by-Step Agent Instructions

### Step 3.1: Schema
1. Add the enum `BackfillStatus { NONE QUEUED RUNNING DONE PARTIAL ERROR }`.
2. Add these fields to `Repository`:
   * `backfillStatus BackfillStatus @default(NONE)`
   * `backfillNextPage Int?`: the next GitHub page (100 per page) to fetch, so a job can resume after a rate-limit pause or a worker restart.
   * `backfillTarget Int @default(100)`: how many releases the repository should hold in total.
   * `backfilledAt DateTime?`
3. Existing rows default to `NONE`. The scheduler (Step 3.4) picks them up gradually.

### Step 3.2: `fetchReleasesPage()` in `@repopulse/github`
1. Signature: `fetchReleasesPage({ owner, name, page, perPage = 100, accessToken, octokit? })`.
2. It returns `{ releases: MappedRelease[], hasNextPage: boolean, rateLimitRemaining, rateLimitResetAt }`.
3. **Drafts are filtered out**, as everywhere else.
4. Detect `hasNextPage` from the `Link` header (`rel="next"`), not from page length.
5. Map errors the same way as `pollRepoReleases`: `404` → `GitHubRepositoryNotFoundError`, `403`/`429` with quota 0 → `GitHubRateLimitError`.
6. Do **not** send `If-None-Match`. ETags are per URL, and the stored `lastEtag` belongs to the poll URL (`per_page=20`) only.

### Step 3.3: `release-backfill` queue & processor
1. Queue `release-backfill`:
   * `concurrency: 2`, low priority, exponential backoff.
   * `jobId: \`backfill:\${repositoryId}\`` so the same repository never has two concurrent backfills.
2. Processor flow for one `repositoryId`:
   1. Set `backfillStatus = RUNNING`. Pick an access token from any subscriber, as the poll processor does.
   2. Loop from `backfillNextPage ?? 1`:
      * Call `fetchReleasesPage()`.
      * Insert rows with `release.createMany({ skipDuplicates: true })`. The unique key `(repositoryId, githubReleaseId)` makes re-runs idempotent.
      * **Do not create `UserReleaseState` rows.** By the Slice 03 definition, a release without a state row counts as **read**, so history never
        appears unread and never notifies.
      * Persist `backfillNextPage` after every page so a restart resumes.
   3. Stop when any of these holds:
      * The repository holds `backfillTarget` non-draft releases.
      * `hasNextPage` is false. Set `DONE`.
      * The oldest release on the page is older than `RELEASE_BACKFILL_MAX_AGE_DAYS`. Set `DONE`.
      * A hard cap of `RELEASE_BACKFILL_HARD_CAP` releases is reached. Set `PARTIAL`.
   4. Check rate limits:
      * Before each page: if `rateLimitRemaining < RELEASE_BACKFILL_MIN_QUOTA` (default 500), re-enqueue the job delayed until `rateLimitResetAt` and exit.
        The backfill must never starve the regular polling.
      * On `GitHubRateLimitError`: same, delay until the reset time.
      * On `404`: set `backfillStatus = ERROR`. The poll processor handles repository removal.
   5. When finished, set `backfilledAt = now()`. Publish `{ type: 'HISTORY_BACKFILLED', repositoryId, added }` to `user:{userId}:events` for every
      subscriber. The Slice 04 SSE listener refreshes on it **without** showing a "new release" toast.
3. Register the worker in `apps/worker/src/index.ts` and include it in the graceful `SIGTERM` shutdown.

### Step 3.4: Triggers
1. **On add:** after `addRepositoryAction` commits, enqueue a backfill if `backfillStatus` is `NONE` or `ERROR`. When a second user adds the same repo, the
   status is already `DONE` and nothing is enqueued, because history is shared.
2. **Scheduler sweep:** the Slice 04 `repo-scheduler` also enqueues up to N repositories per tick with `backfillStatus = NONE`. This covers repos that
   existed before this slice.
3. **"Load older releases" (`requestDeepBackfillAction({ repositoryId })`):**
   * Only subscribers of the repository can call it.
   * It raises `backfillTarget` by +200, up to `RELEASE_BACKFILL_HARD_CAP`, sets `QUEUED` and enqueues.
   * It has the same 5-minute cooldown pattern as `triggerManualRepoSyncAction`: an atomic `updateMany` claim.

### Step 3.5: Coordinate with the poll processor (important)
The Slice 04 poll processor must treat as **new**, meaning unread and notified, **only releases newer than the newest release already stored**. It must not
use "any `githubReleaseId` not in the DB". The Slice 03 `triggerManualRepoSyncAction` already uses the "newer than the newest stored" rule.
Otherwise a poll that runs before the backfill finishes would mark historical releases 11–20 as unread and fire notifications for them.

### Step 3.6: UI (`/repositories`)
1. Show the history status on each repository card:
   * "History: 100 releases since Mar 2025" when `DONE`.
   * "Importing history…" when `QUEUED` or `RUNNING`.
   * "Partial history: 1000 newest releases" when `PARTIAL`.
   * "History import failed" when `ERROR`, with a retry option.
2. Add a "Load older releases" button that calls `requestDeepBackfillAction` and shows a toast with the cooldown or "Importing…" state.
3. No feed changes are needed. Backfilled releases appear through the existing keyset "Load more", sorted by `publishedAt`, and show as read.

### Step 3.7: Configuration (`.env.example`, `docker-compose.coolify.yml` worker env)
| Variable | Default | Meaning |
| --- | --- | --- |
| `RELEASE_BACKFILL_DEFAULT_TARGET` | `100` | Releases kept per repository after the automatic backfill |
| `RELEASE_BACKFILL_MAX_AGE_DAYS` | `365` | Stop the automatic backfill at releases older than this (`0` = no limit) |
| `RELEASE_BACKFILL_HARD_CAP` | `1000` | Maximum releases per repository, even when requested via "Load older releases" |
| `RELEASE_BACKFILL_MIN_QUOTA` | `500` | Pause the backfill when the GitHub quota falls below this |

---

## 4. Verification & Acceptance Criteria
- [ ] Adding a repository with more than 100 releases returns as fast as before (only the newest 10 are fetched synchronously). Within a few seconds,
      `/repositories` shows "History: 100 releases", and the feed's "Load more" reaches releases older than the first 20.
- [ ] The unread counter does **not** change because of a backfill, and no notification jobs are enqueued for backfilled releases.
- [ ] Running the backfill twice, or killing the worker mid-backfill and restarting it, produces no duplicate `Release` rows and resumes from
      `backfillNextPage`.
- [ ] With an artificially low quota (`RELEASE_BACKFILL_MIN_QUOTA` above the remaining quota), the job reschedules itself until the rate-limit reset
      instead of failing. Regular polling keeps working meanwhile.
- [ ] A poll that runs while the backfill is in progress marks only genuinely newer releases as unread (Step 3.5).
- [ ] "Load older releases" raises the target, enforces the cooldown and stops at `RELEASE_BACKFILL_HARD_CAP` with status `PARTIAL`.
- [ ] Unit tests cover `fetchReleasesPage`: `Link`-header paging, draft filtering, `404`/rate-limit mapping, and processor stop conditions.

# Slice 04b — Implementation Summary

**Spec:** [`slice_04b_release_history_backfill.md`](./slice_04b_release_history_backfill.md)
**Status:** Implemented. Typecheck, unit tests (182 across packages) and all builds pass. Not yet checked end to end against a live
Postgres/Redis and real GitHub (see §5).
**Date:** 2026-10-31

---

## 1. Files

```text
packages/db/prisma/
├── schema.prisma                                 + enum BackfillStatus, Repository backfill fields, @@index([backfillStatus])
└── migrations/20261031120000_release_backfill/   NEW (identical to `prisma migrate diff` output)

packages/github/src/
├── poller.ts                                     + fetchReleasesPage(), hasNextLink(), BACKFILL_PAGE_SIZE (100)
└── poller.test.ts                                + Link paging, drafts, no If-None-Match, 404 / 403 / 429 mapping

packages/queue/src/
├── backfill.ts                                   NEW readBackfillConfig() (RELEASE_BACKFILL_*), DEEP_BACKFILL_STEP, cooldown
├── names.ts                                      + release-backfill queue/job names, ReleaseBackfillJobData, jobId, priorities, options
├── events.ts                                     + HISTORY_BACKFILLED event
└── events.test.ts                                + jobId, event round trip, config parsing

apps/worker/src/
├── index.ts                                      + release-backfill worker (concurrency 2), validated config, part of SIGTERM drain
├── queues/index.ts                               + releaseBackfillQueue, closed on shutdown
└── processors/
    ├── release-backfill.processor.ts             NEW page loop, rate-limit pause, status bookkeeping, HISTORY_BACKFILLED
    ├── backfill-plan.ts                          NEW pure page planner (stop conditions, target, age cutoff)
    ├── github-tokens.ts                          NEW tokenCandidates(), moved out of repo-poll.processor.ts and shared
    ├── scheduler.processor.ts                    + backfill sweep (10 per tick)
    ├── backfill-plan.test.ts                     NEW
    ├── release-backfill.processor.test.ts        NEW
    └── scheduler.processor.test.ts               NEW

apps/web/src/
├── server/backfill-queue.ts                      NEW enqueueReleaseBackfill() (not a "use server" module)
├── server/realtime.ts                            + getReleaseBackfillQueue()
├── server/actions/backfill.ts                    NEW requestDeepBackfillAction
├── server/actions/repositories.ts                addRepositoryAction queues the backfill after commit
├── server/queries/feed.ts                        getTrackedRepositories: + history { status, hasMore, target, oldestAt }
├── components/repositories/history-status.tsx    NEW status line + "Load older releases" / "Retry"
├── components/realtime/sse-listener.tsx          HISTORY_BACKFILLED → router.refresh(), no toast
└── app/(dashboard)/repositories/page.tsx         renders <HistoryStatus />

docker-compose.coolify.yml, scripts/setup-env.mjs, scripts/sync-env.mjs   RELEASE_BACKFILL_* settings
```

## 2. How a backfill runs

1. **Trigger.** There are three:
   - `addRepositoryAction` queues a job after the transaction commits, when the status is `NONE` or `ERROR`. This is best effort: if
     Redis is down, the row stays `NONE` and the sweep picks it up.
   - The `repo-scheduler` tick also sweeps up to 10 subscribed repositories in `NONE`, `QUEUED` or `RUNNING`, `NONE` first.
     Re-adding a `QUEUED` or `RUNNING` one does nothing while its job exists, and recovers it if Redis lost the job.
   - "Load older releases" queues one through `requestDeepBackfillAction`.
2. **First run.** The repository's first backfill sets `backfillTarget = RELEASE_BACKFILL_DEFAULT_TARGET`. Later runs keep the stored
   target.
3. **Per page.** The processor works on `backfillNextPage ?? 1`. For each page it:
   - re-reads the target, which "Load older releases" may have raised while the job runs
   - fetches the page with a subscriber token, falling back past a token GitHub rejects with 401
   - plans the page with `planBackfillPage()`
   - inserts the planned rows with `createMany({ skipDuplicates: true })`
   - saves the next page number
4. **Stop conditions.** These are pure functions in `backfill-plan.ts`:
   - Last page fully read: `DONE`, and `backfillNextPage = null` (history complete).
   - Target reached: `DONE`, or `PARTIAL` when the target is the hard cap.
   - A release older than `RELEASE_BACKFILL_MAX_AGE_DAYS`: `DONE`. This applies to the automatic backfill only, meaning while
     `backfillTarget <= default`.

   When the target or the age limit cuts a page short, `backfillNextPage` stays on that page. A later, larger request then picks up
   the rest of it.
5. **Rate limits.** The job pauses itself in two cases:
   - after a page, when `x-ratelimit-remaining < RELEASE_BACKFILL_MIN_QUOTA`
   - on a `GitHubRateLimitError`

   It sets the status to `QUEUED`, calls `job.moveToDelayed(reset + 1 s)` and throws `DelayedError`. That keeps the same jobId and
   uses no attempt. It never calls `queue.rateLimit()`, so repo-poll is never paused by a backfill.
6. **Errors.**
   - 404: `ERROR`. Removing the repository stays repo-poll's job.
   - Any other error is rethrown for BullMQ's exponential backoff. The status is `QUEUED` between attempts and `ERROR` after the last.
7. **Finish.** Sets `backfilledAt` and publishes `HISTORY_BACKFILLED { added }` to every subscriber. The browser refreshes without a
   toast.

## 3. Unread / notification safety

- **No state rows.** Backfilled releases never get `UserReleaseState` rows, so they read as read. No `planFanOut` call and no
  notification job.
- **Step 3.5 already held before this slice.** repo-poll's `selectFreshReleases()` only counts releases newer than the newest stored
  one as new.
- **Converse guard, added here.** The backfill skips every release newer than the newest stored one. Without it, a release published
  between "Add" and the backfill would be stored as read and never notify, and the next poll would no longer see it as new.
- **No stored releases.** When nothing is stored yet, the backfill finishes `DONE` without calling GitHub. GitHub had no releases at
  add time, and anything published since is new and arrives through repo-poll.

## 4. Deviations from the spec

| Spec | Implemented | Why |
| --- | --- | --- |
| jobId `backfill:${repositoryId}` | `backfill-${repositoryId}` | BullMQ rejects `:` in custom job ids. `poll-` and `notify-` follow the same rule. |
| Cooldown "same pattern as `triggerManualRepoSyncAction`: an atomic `updateMany` claim" | New `Repository.backfillRequestedAt` column, claimed by one `updateMany` | The sync action reads `lastPolledAt` and then checks it, so it has no claim to copy. The claim also matches the status and target that were read, so two concurrent clicks cannot both add +200. A failed enqueue gives the claim back. |
| "Before each page" quota check | Checked from the headers of the previous page | The remaining quota is only known from a response. The first page costs one request. |
| — | `RELEASE_BACKFILL_HARD_CAP` also in the **web** service env | `requestDeepBackfillAction` and the UI clamp to it. |
| "History import failed, with a retry option" | `requestDeepBackfillAction` on `NONE`/`ERROR` re-queues **without** raising the target | One action, one cooldown. |
| — | The sweep also re-queues `QUEUED`/`RUNNING` rows | Recovers jobs lost on a Redis flush. It does nothing while the job exists. |

## 5. Not verified yet

- **End-to-end acceptance criteria** (§4 of the spec) against the dev Postgres/Redis and real GitHub: adding a repository with more than
  100 releases, killing the worker mid-backfill, and a low `RELEASE_BACKFILL_MIN_QUOTA`. Run `pnpm db:migrate:deploy` first.
- **`.env.example` was not edited directly.** Run `pnpm env:sync` to add the four commented `RELEASE_BACKFILL_*` lines (tested on a sample file).

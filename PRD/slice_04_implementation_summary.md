# Slice 04 — Implementation Summary

**Spec:** [`slice_04_bullmq_worker_etag_polling_live_sse.md`](./slice_04_bullmq_worker_etag_polling_live_sse.md)
**Status:** Implemented. Typecheck, 145 unit tests and all builds pass. The three acceptance criteria were checked end to end against
the dev Postgres/Redis, real GitHub, headless Chrome and the Linux worker image (see §5).
**Date:** 2026-10-31

---

## 1. Files

```text
packages/queue/                          NEW @repopulse/queue (ESM), shared by worker and web
└── src/
    ├── names.ts                         queue/job names, job payload types, jobId helpers, priorities, default job options
    ├── events.ts                        RealtimeEvent contract, user:{id}:events channel, parse/serialize (browser-safe,
    │                                    exported as @repopulse/queue/events)
    ├── redis.ts                         createRedisConnection (maxRetriesPerRequest: null), publishUserEvent
    └── events.test.ts

apps/worker/src/
├── index.ts                             health server, Redis, queues, 3 BullMQ workers, cron registration, SIGTERM/SIGINT drain
├── redis.ts                             shared worker connection
├── logger.ts                            [scope]-prefixed logging
├── queues/index.ts                      schedulerQueue, repoPollQueue, notificationQueue, registerSchedule
└── processors/
    ├── scheduler.processor.ts           due-repository query + addBulk with jobId poll-{repoId}
    ├── repo-poll.processor.ts           token selection, conditional poll, store + fan-out transaction, events, errors
    ├── notification.processor.ts        Slice 05 hand-off stub (validates the rule, logs)
    ├── fan-out.ts                       pure rules: fresh releases, per-subscriber plan, rule matching, rate-limit delay
    ├── fan-out.test.ts
    └── repo-poll.processor.test.ts

apps/web/src/
├── server/realtime.ts                   repo-poll producer, Pub/Sub publish, per-stream subscriber (Redis, fail-fast)
├── server/actions/sync.ts               triggerManualRepoSyncAction → priority job (replaces the Slice 03 inline poll)
├── app/api/events/stream/route.ts       SSE endpoint
├── components/realtime/sse-listener.tsx EventSource → toasts + router.refresh()
├── components/repositories/sync-repo-button.tsx   "Syncing…" toast, resolved by SSE
└── app/(dashboard)/layout.tsx           mounts <SseListener />

packages/github/src/poller.ts            pollRepoReleases accepts an AbortSignal
```

## 2. Dependencies

| Package | Version | Where |
| --- | --- | --- |
| `bullmq` | 6.3.16 | queue, worker, web |
| `ioredis` | 6.0.0 | queue, worker, web |
| `vitest` | 5.0.5 | worker (dev) |

These were the newest stable releases at least two weeks old. `pnpm-workspace.yaml` sets `allowBuilds.msgpackr-extract: false`: BullMQ's optional
native msgpack add-on is not built, and its pure-JS fallback is used. pnpm 12 otherwise fails the install on the unapproved build script.
`next.config.ts` lists `bullmq` and `ioredis` in `serverExternalPackages`, because BullMQ lazily `require()`s optional backends (`pg`,
`@valkey/valkey-glide`) that the bundler can't resolve.

## 3. Design notes

### Queues
| Queue | Worker options | Jobs |
| --- | --- | --- |
| `repo-scheduler` | concurrency 1 | `upsertJobScheduler("repo-scheduler-cron", { pattern: POLL_INTERVAL_CRON })` plus one scan at startup |
| `repo-poll` | concurrency 5 (`REPO_POLL_CONCURRENCY`), limiter 10 jobs/s | `{ repositoryId, trigger, requestedByUserId? }`, 3 attempts, exponential backoff from 30 s |
| `notification-dispatch` | concurrency 10 (`NOTIFICATION_CONCURRENCY`) | `{ ruleId, releaseId, userId }` (the Slice 05 shape), 5 attempts |

### Deviations from the spec text
- **jobId `poll-{id}`, not `poll:{id}`.** BullMQ 6 rejects custom ids containing `:` unless they split into exactly three parts. The deduplication
  works the same way.
- **Finished poll jobs are removed** (`removeOnComplete/removeOnFail: true`). A retained job keeps its jobId taken, and BullMQ would silently ignore every later poll of
  that repository.
- **Priorities:** BullMQ runs jobs *without* a priority before prioritized ones, so scheduled polls carry `priority: 10`. That lets a manual
  `priority: 1` sync overtake them.
- **The `repo-poll` worker has a `limiter`.** `queue.rateLimit(ms)` only pauses a queue whose worker has a limiter (BullMQ's Lua checks `limiter.max`).
  The limiter also caps outbound GitHub calls at 10/s. A probe against real Redis confirmed that the job replays after the delay without consuming an attempt.
- **The scheduler also picks up stale and error states:** `POLLING` rows untouched for 15 minutes (left behind by a crashed worker) are polled again, and `ERROR`
  repositories are retried every 6 hours instead of every 30 minutes.

### Poll processor
1. Load the repository. Skip it if it was deleted or has no subscribers left. Set `POLLING`.
2. Choose tokens: up to 3 decryptable subscriber tokens, most recently signed-in user first. For a manual sync the requester's token goes first. A `401` moves on to the next token; anonymous access is the last resort.
3. Call `pollRepoReleases` with `If-None-Match`, a 30 s timeout and BullMQ's job cancellation signal.
4. On `304`: set `lastPolledAt`, `IDLE` and `errorCount = 0`.
5. On `200`, in one transaction:
   - Find the `githubReleaseId`s already stored and insert the missing ones (`skipDuplicates`).
   - **Fan out only releases published after the newest stored one**, the same rule as Slice 03. Subscribers who exclude pre-releases skip them, and each subscriber gets at most 10 new rows.
   - Create the unread `UserReleaseState` rows and update `lastEtag`, `lastPolledAt`, `IDLE` and `errorCount`.
6. After the commit:
   - Publish `NEW_RELEASE` per user and release.
   - Enqueue `notification-dispatch` jobs for matching rules: the subscription must carry the rule's tag (or the rule has none), and `onlyMajorReleases` requires `MAJOR`. `IN_APP` rules are skipped because the unread state plus SSE is the in-app delivery.
   - Publish `SYNC_COMPLETED` to the requester.
   - Publish and enqueue failures are logged, not rethrown: a retry would find nothing new and could not rebuild the plan.
7. Errors:
   - **Rate limit (403 with quota 0, or 429):** set `IDLE`, call `repoPollQueue.rateLimit(reset − now + 1 s)` (clamped to 5 s–1 h), then throw `Worker.RateLimitError()`.
   - **404:** increment `errorCount` and flag `ERROR` at 5. The job completes, because the counter spans scheduler ticks.
   - **Anything else:** rethrow so BullMQ retries. Only the final attempt counts towards `errorCount`.
   - Every failed attempt sets `lastPolledAt`, so neither the scheduler nor "Sync now" hammers a failing repository.

### Manual sync
`triggerManualRepoSyncAction` returns `COOLDOWN` when `lastPolledAt` is less than 5 minutes old. Otherwise it returns `QUEUED`; the Slice 03 `NOT_MODIFIED/UPDATED` results now
arrive over SSE.
- **Already queued:** if a scheduled job for the repository is waiting, the action takes it over (`updateData` + `changePriority(1)`). Without this, BullMQ would drop the add silently.
- **Redis down:** web Redis calls fail fast (`maxRetriesPerRequest: 1`, 5 s timeout) and the action returns a new `UNAVAILABLE` error code.

### SSE
`GET /api/events/stream`:
- Responds `401` without a session and `503` without `REDIS_URL`.
- Opens one ioredis subscriber per stream (subscriber-mode connections can't be shared).
- Sends a `retry: 5000` hint and `: ping` comments every 25 s.
- Relays only events that pass `parseRealtimeEvent`.
- Unsubscribes and quits on `request.signal` abort or stream cancel.

`SseListener` (mounted in the dashboard layout):
- Groups `NEW_RELEASE` events that arrive within 500 ms into one toast (with an "Open" action for a single release), then calls `router.refresh()`.
- Turns the button's "Syncing…" toast (keyed `sync-{repositoryId}`) into the success, warning or error result.
- Refreshes once after a reconnect, since events sent while disconnected are lost.

### Shutdown
On SIGTERM/SIGINT:
1. `worker.close()` on all three workers, which waits for active jobs.
2. Close the queues, the health server, `redis.quit()` and `prisma.$disconnect()`.
3. `exit(0)`.

A 25 s guard sits below compose's `stop_grace_period: 30s`.

## 4. Verification

| Check | Result |
| --- | --- |
| `pnpm turbo run typecheck test build` | ✅ 16/16 tasks. Tests: queue 15, github 43 (+1 signal), worker 21, db 8, web 58 |
| Worker unit tests | Fresh-release rule, pre-release filter, per-subscriber cap, rule matching, rate-limit delay, due-repo query. Processor: 304, token order and 401 fallback, rate limit, 404 → ERROR at 5, retry counting, requester events |
| BullMQ 6 manual rate-limit probe (real Redis) | ✅ Job replayed after 2 s with `attemptsMade` still 0 |
| `next build` + standalone trace | ✅ `/api/events/stream` is dynamic; bullmq, ioredis, msgpackr and cron-parser are traced |
| `docker build` worker image | ✅ Runs on Linux against the dev services |

## 5. Acceptance criteria

The fixture was a `slice04-fixture` user subscribed to the real `sindresorhus/ky`. Its newest stored release was deleted and its ETag cleared to simulate a new release. Fixture data was removed afterwards.

- [x] **200 then 304:** the worker logs showed
  `sindresorhus/ky: HTTP 200 OK, 20 releases received, 11 stored, 1 new, fanned out to 1 user(s)` and then
  `sindresorhus/ky: HTTP 304 Not Modified`. The first poll also stored 10 older releases; only the one newer release became unread.
- [x] **Live update via SSE** (headless Chrome, 15/15 checks, no console errors):
  - A scheduler-style job created an unread `UserReleaseState` (`v2.2.0`).
  - The open feed tab showed the "New release: sindresorhus/ky v2.2.0" toast. The new card appeared marked unread, and the counter went from 0 to 1, without a reload (a `window` marker survived).
  - "Sync now" on `/repositories` produced "1 new release in sindresorhus/ky" and refreshed the latest tag live.
  - A second click showed the cooldown notice.
- [x] **SIGTERM:** `docker kill --signal SIGTERM` hit the worker container while a poll was in flight. The poll completed (HTTP 200, stored, fanned out), then the log shows
  "3 BullMQ workers drained and closed" → health server → redis → database → "graceful shutdown complete". Exit code **0**, and the repository was left `IDLE`.

## 6. Notes for later slices

- **Slice 04b:** add `release-backfill` to `queues/index.ts` and to the `workers` array in `index.ts`, which the shutdown drains automatically. Backfilled
  releases must not go through `planFanOut`.
- **Slice 05:** replace the body of `processors/notification.processor.ts`. Jobs are already deduplicated per (rule, release) by jobId, and completed ones are kept for 7 days.
- **Token selection:** a private repository that one subscriber's token can no longer see returns 404, not 401, so the next token is not tried.
- **Rate limits:** GitHub limits are per token, but `rateLimit()` pauses the whole `repo-poll` queue. That is fine at self-hosted scale; per-token buckets are the upgrade path.
- **Env settings:** `REPO_POLL_CONCURRENCY` (default 5) and `NOTIFICATION_CONCURRENCY` (default 10) are optional.
  - `pnpm env:sync` (`scripts/sync-env.mjs`) adds them to an existing `.env.example` and `.env`; it is idempotent and keeps line endings.
  - `pnpm env:setup` includes them in new `.env` files.
  - `docker-compose.coolify.yml` passes them to the worker.
  - Later slices that add settings should extend the `ADDITIONS` list in `scripts/sync-env.mjs`.

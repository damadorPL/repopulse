# Worker (`apps/worker`)

> **Summary:** one Node process running four BullMQ workers plus a health server on `:3001`. Entry point `apps/worker/src/index.ts`; processors in `src/processors/`; queue construction in `src/queues/index.ts`. Names, payloads, deduplication helpers, and job options are shared with `apps/web` through `@repopulse/queue`. The Dependencies module has its own process, `apps/deps-worker` ([deps-worker.md](./deps-worker.md)). The two workers share PostgreSQL and Redis but never import each other.
>
> **Related Docs:** [../CONTRACTS.md](../CONTRACTS.md#bullmq-queues--job-contracts) · [../packages/queue.md](../packages/queue.md) · [../packages/notifications.md](../packages/notifications.md)

## Queues & Rules

Queue definitions (`QUEUE_NAMES`: `repo-scheduler`, `repo-poll`, `release-backfill`, `notification-dispatch`), payloads, concurrency, and job options live in [../CONTRACTS.md](../CONTRACTS.md#core-queues-queue_names-consumed-by-appsworker).

- **MUST** enqueue jobs with `enqueueDeduplicated` / `deduplicatedJobOptions` or the `*JobId` helpers (`repoPollJobId`, `releaseBackfillJobId`, `notificationJobId`).
- **MUST NOT** put `:` in a jobId or deduplication id (BullMQ rejects it; use `-`).
- `repo-poll` and `release-backfill` **MUST** use `deduplication: { keepLastIfActive: true }` with bounded `removeOnComplete` / `removeOnFail` so overlapping triggers do not stack and completed jobs never block future runs.
- BullMQ runs jobs *without* a priority before prioritized ones, so every prioritized producer sets an explicit priority.
- Permanent failures throw `UnrecoverableError` (no retries). Transient ones rethrow (retried with backoff).

## Processors

### `scheduler.processor.ts` → `processSchedulerTick`

- Due repository (`dueRepositoriesWhere`): has subscribers, not polled within `REPOLL_AFTER_MS` (25 min), and not `POLLING` (unless stale after 15 min). `ERROR` repositories are retried only every 6 h.
- Enqueues in batches of 500, then hands up to `BACKFILL_SWEEP_BATCH` (10) repositories that still need history to `release-backfill` (`backfillSweepWhere`: `NONE` first, plus `QUEUED`/`RUNNING` whose job may have been lost).
- `registerSchedule` upserts the cron (`POLL_INTERVAL_CRON`) by a fixed id (`SCHEDULER_ID`) and runs one scan at startup.

### `repo-poll.processor.ts` → `processRepoPoll`

1. Load the repository and its subscriber count. Skip with `REPOSITORY_GONE` / `NO_SUBSCRIBERS`.
2. `tokenCandidates()` (`github-tokens.ts`): up to 3 decryptable subscriber tokens (the requester first for manual syncs), then anonymous. Moves to the next only on 401.
3. `pollRepoReleases({ etag })`: `NOT_MODIFIED` or `UPDATED`.
4. Release step (one transaction): insert unknown releases, promote tag rows that now have a Release, `selectFreshReleases` → `planFanOut` (unread states, SSE deliveries, notification jobs; pre-releases only with `includePrereleases`; at most `INITIAL_RELEASES_LIMIT` = 10 newest per subscriber per poll, applied after filtering; notification jobs only when `mayNotify` allows: not snoozed (`snoozedUntil`) and at or above the subscription's `notificationLevel`, checked before rules), bookkeeping (`lastEtag`, `lastPolledAt`, `pollStatus`, `errorCount`).
5. Tag step (`repo-tags.ts` → `pollRepoTags`): only when a subscriber is `TAGS_AND_COMMITS`. GraphQL newest 20 tags → store tags with no row (changelog = "commits since the previous tag" via compare API) → fan out fresh tags to tag-mode subscribers only. **Best effort**: any failure is logged and skipped; it never fails the poll or pauses the queue. Tag freshness compares against the newest `RELEASE`/`TAG` row only (commit rows are ignored).
6. Path step (`repo-paths.ts` → `pollRepoPaths`): only when a subscriber has `trackPaths` and watched paths (regardless of `trackMode`). Union of all subscribers' watched paths (deduplicated) → `fetchCommitsForPath` (REST, newest `PATH_COMMITS_PAGE_SIZE` = 10 per path; anonymous works) → `fetchCommitDetail` once per unknown commit (failure = stored without files; rate limit skips step) → insert `COMMIT` rows → `planPathFanOut` per subscriber, using only commits returned by the subscriber's own paths:
   - **fresh** = inserted by this poll *and* returned by a path already in `polledPaths`: `planFanOut` (unread, SSE, notification rules, 10 per user). No date comparison: a polled path's newest commits are all stored, so an unknown one is new on the branch.
   - **imported** = returned by a newly watched path: newest 10 unread, the rest read, SSE, **no** notification jobs. Commits the user already has a state for are left alone.
   Then `polledPaths` = the paths polled now and `lastPathsPolledAt`. **Best effort** like the tag step. When no subscriber watches paths any more, the poll clears `polledPaths`, so watching a path again is a quiet import. The release step skips paths-only subscribers (`trackMode = NONE`, `tracksReleases`).
7. After commit: publish SSE events (best effort), add notification jobs, and for manual syncs send `SYNC_COMPLETED`.

- Errors:
  - `GitHubRateLimitError` → `repoPollQueue.rateLimit(rateLimitDelayMs(resetAt))` (reset + 1 s, clamped to 5 s–1 h) and `throw Worker.RateLimitError()`. No attempt is consumed.
  - `GitHubRepositoryNotFoundError` → `errorCount++`, `ERROR` after `MAX_ERROR_COUNT` (5); returns `NOT_FOUND` without retrying.
  - Anything else (network, 5xx, timeouts) is rethrown so BullMQ retries it. Only the last attempt counts toward `errorCount`.
- `loadSubscribers` (`repo-tags.ts`, shared by release, tag, and path steps) selects `notificationLevel`, `snoozedUntil`, and each rule's `events`. `ruleMatches` only queues rules whose `events` contain `RELEASES`.
- Pure decision logic lives in `fan-out.ts` (`selectFreshReleases`, `ruleMatches`, `passesNotificationLevel`, `isSnoozed`, `mayNotify`, `planFanOut`, `mergeFanOutPlans`, `rateLimitDelayMs`). Test it there.

### `release-backfill.processor.ts` → `processReleaseBackfill`

- Pages `fetchReleasesPage` (100 per page) from `backfillNextPage` and persists the next page after each one, so it resumes after a restart or pause.
- Stores history **without** `UserReleaseState` (= read, no notifications) and skips releases newer than the newest stored one (those belong to `repo-poll`).
- Stops at `effectiveTarget(backfillTarget, hardCap)`, at the end of history, or at `maxAgeCutoff` (automatic runs only). Final status is `DONE`, or `PARTIAL` when the hard cap stopped it.
- When quota drops below `RELEASE_BACKFILL_MIN_QUOTA`, or on a rate limit, moves itself to delayed until reset (`job.moveToDelayed`), so polling never starves.
- Publishes `HISTORY_BACKFILLED` to every subscriber. Pure logic is in `backfill-plan.ts`.

### `notification.processor.ts` → `processNotification`

- Re-checks the rule against current state: `RULE_GONE`, `RULE_DISABLED`, `EVENT_DISABLED` (`RELEASES` removed from `events`), `RELEASE_GONE`, `NOT_MAJOR`, `UNSUPPORTED_CHANNEL`, `UNSUBSCRIBED`, `TAG_REMOVED`, `SNOOZED`, `NOTIFICATION_LEVEL` → `SKIPPED`.
- Email rules: `toSmtpConfig(await loadSmtpSettings(prisma))` on **every job** (Admin changes apply without restart). Unreadable password becomes a permanent failure.
- `dispatchNotification(input, { smtp, signal })`. `NotificationDeliveryError.permanent` → `UnrecoverableError`.

## Lifecycle

- Startup: health server (`:3001`) → `prisma.$connect()` (failure reported by `/health`, not a crash) → require `REDIS_URL` → `readBackfillConfig()` (fails fast on bad values) → workers → schedule. Each backfill job merges admin overrides (`applyBackfillOverrides(env, await loadBackfillOverrides(prisma))`, env-only if read fails).
- `SIGTERM`/`SIGINT`: `worker.cancelAllJobs("shutdown")` aborts active fetches, `worker.close()` drains active jobs, then `closeSmtpTransports()`, queues, health server, Redis, and Prisma close, exiting 0. Force-exit timeout is 25 s (below Compose `stop_grace_period: 30s`).
- `GET /health` → `200 { status: "ok", checks: { database, redis }, timestamp }` or `503`. Never leaks error details.
- Logging: `createLogger(scope)` from `@repopulse/queue` (Pino JSON in production, `pino-pretty` in non-prod TTY).

## Testing

Processors take a `deps` object (`prisma`, `redis`, queues, injectable `dispatch`), so tests pass fakes (`fakePrisma({...}) as never`). See `notification.processor.test.ts` and `repo-poll.processor.test.ts`. The worker resolves `@repopulse/*` from `dist/`: rebuild `packages/*` after editing them.

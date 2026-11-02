# Worker (`apps/worker`)

> **Summary:** one Node process running four BullMQ workers plus a health server on `:3001`. Entry point
> `apps/worker/src/index.ts`; processors in `src/processors/`; queue construction in `src/queues/index.ts`. Names,
> payloads and job options are shared with the web app through `@repopulse/queue`.

## Queues

| Queue (`QUEUE_NAMES`) | Job name | Payload | jobId | Concurrency | Options |
| --- | --- | --- | --- | --- | --- |
| `repo-scheduler` | `scan-due-repositories` | `{}` | repeatable scheduler `repo-scheduler-cron` | 1 | removeOnComplete |
| `repo-poll` | `poll-repository` | `{ repositoryId, trigger: "schedule" \| "manual", requestedByUserId? }` | `poll-{repositoryId}` | `REPO_POLL_CONCURRENCY` (5), limiter 10/s | 3 attempts, exp. 30 s; priority manual 1 / scheduled 10 |
| `release-backfill` | `backfill-releases` | `{ repositoryId, trigger: "add" \| "sweep" \| "deep" \| "retry" }` | `backfill-{repositoryId}` | 2 | 3 attempts, exp. 60 s; priority requested 1 / automatic 10 |
| `notification-dispatch` | `dispatch-notification` | `{ ruleId, releaseId, userId }` | `notify-{ruleId}-{releaseId}` | `NOTIFICATION_CONCURRENCY` (10) | 3 attempts, exp. 5 s; kept 7 days for dedup |

Rules:
- **MUST** add jobs with the jobId helpers (`repoPollJobId`, `releaseBackfillJobId`, `notificationJobId`). An add with
  an existing id is ignored, which is the deduplication.
- **MUST NOT** put `:` in a jobId (BullMQ rejects it).
- Poll and backfill jobs **must** use `removeOnComplete/removeOnFail: true`, or the retained job blocks the next one.
- BullMQ runs jobs *without* a priority before prioritized ones, so every producer sets an explicit priority.
- Permanent failures throw `UnrecoverableError` (no retries). Transient ones rethrow (retried with backoff).

## Processors

### `scheduler.processor.ts` → `processSchedulerTick`
- Due repository (`dueRepositoriesWhere`): has subscribers, not polled within `REPOLL_AFTER_MS` (25 min), and not
  `POLLING` (unless stale after 15 min). `ERROR` repositories are retried only every 6 h.
- Enqueues in batches of 500, then hands up to `BACKFILL_SWEEP_BATCH` (10) repositories that still need history to
  `release-backfill` (`backfillSweepWhere`: `NONE` first, plus `QUEUED`/`RUNNING` whose job may have been lost).
- `registerSchedule` upserts the cron (`POLL_INTERVAL_CRON`) by a fixed id and runs one scan at startup.

### `repo-poll.processor.ts` → `processRepoPoll`
1. Load the repository and its subscriber count. Skip with `REPOSITORY_GONE` / `NO_SUBSCRIBERS`.
2. `tokenCandidates()` (`github-tokens.ts`): up to 3 decryptable subscriber tokens (the requester first for manual
   syncs), then anonymous. Moves to the next only on 401.
3. `pollRepoReleases({ etag })`: `NOT_MODIFIED` or `UPDATED`.
4. Release step (one transaction): insert unknown releases, promote tag rows that now have a Release,
   `selectFreshReleases` → `planFanOut` (unread states, SSE deliveries, notification jobs; pre-releases only with
   `includePrereleases`; at most `INITIAL_RELEASES_LIMIT` = 10 newest per subscriber per poll, applied after filtering;
   notification jobs only when `mayNotify` allows: not snoozed (`snoozedUntil`) and at or above the subscription's
   `notificationLevel`, checked before the rules), bookkeeping (`lastEtag`, `lastPolledAt`, `pollStatus`, `errorCount`).
5. Tag step (`repo-tags.ts` → `pollRepoTags`): only when a subscriber is `TAGS_AND_COMMITS`. GraphQL newest 20 tags →
   store tags with no row (changelog = "commits since the previous tag" via the compare API) → fan out fresh tags to
   tag-mode subscribers only. **Best effort**: any failure is logged and skipped. It never fails the poll or pauses the
   queue. Tag freshness compares against the newest `RELEASE`/`TAG` row only (commit rows are ignored).
6. Path step (`repo-paths.ts` → `pollRepoPaths`): only when a subscriber has `trackPaths` and watched paths (whatever its `trackMode`). Union of all
   subscribers' watched paths (deduplicated) → `fetchCommitsForPath` (REST, newest `PATH_COMMITS_PAGE_SIZE` = 10 per
   path; anonymous works) → `fetchCommitDetail` once per unknown commit (failure = stored without files; a rate limit
   skips the step) → insert `COMMIT` rows → `planPathFanOut` per subscriber, using only commits returned by the
   subscriber's own paths:
   - **fresh** = inserted by this poll *and* returned by a path already in `polledPaths`: `planFanOut` (unread, SSE,
     notification rules, 10 per user). No date comparison: a polled path's newest commits are all stored, so an
     unknown one is new on the branch (merged branches keep older commit dates).
   - **imported** = returned by a newly watched path: newest 10 unread, the rest read, SSE but **no** notification
     jobs. Commits the user already has a state for are left alone.
   Then `polledPaths` = the paths polled now and `lastPathsPolledAt`. **Best effort** like the tag step. When no
   subscriber watches paths any more, the poll clears `polledPaths`, so watching a path again is a quiet import.
   The release step skips paths-only subscribers (`trackMode = NONE`, `tracksReleases`).
7. After commit: publish SSE events (best effort), add notification jobs, and for manual syncs send `SYNC_COMPLETED`.
- Errors:
  - `GitHubRateLimitError` → `repoPollQueue.rateLimit(rateLimitDelayMs(resetAt))` (reset + 1 s, clamped to 5 s–1 h)
    and `throw Worker.RateLimitError()`. No attempt is consumed.
  - `GitHubRepositoryNotFoundError` → `errorCount++`, `ERROR` after `MAX_ERROR_COUNT` (5); returns `NOT_FOUND`
    without retrying.
  - Anything else (network, 5xx, timeouts) is rethrown, so BullMQ retries it. Only the last attempt counts towards
    `errorCount`.
- `loadSubscribers` (`repo-tags.ts`, shared by the release, tag and path steps) selects `notificationLevel` and
  `snoozedUntil` with each subscription, so all three steps honor them.
- The pure decision logic lives in `fan-out.ts` (`selectFreshReleases`, `ruleMatches`, `passesNotificationLevel`,
  `isSnoozed`, `mayNotify`, `planFanOut`,
  `mergeFanOutPlans`, `rateLimitDelayMs`). Test it there.

### `release-backfill.processor.ts` → `processReleaseBackfill`
- Pages `fetchReleasesPage` (100 per page) from `backfillNextPage` and persists the next page after each one, so it
  resumes after a restart or a pause.
- Stores history **without** `UserReleaseState` (= read, no notifications) and skips releases newer than the newest
  stored one (they belong to repo-poll).
- Stops at `effectiveTarget(backfillTarget, hardCap)`, at the end of the history, or at `maxAgeCutoff` (automatic runs
  only). The final status is `DONE`, or `PARTIAL` when the hard cap stopped it.
- When the quota drops below `RELEASE_BACKFILL_MIN_QUOTA`, or on a rate limit, it moves itself to delayed until the
  reset (`job.moveToDelayed`), so polling never starves.
- Publishes `HISTORY_BACKFILLED` to every subscriber. Pure logic is in `backfill-plan.ts`.

### `notification.processor.ts` → `processNotification`
- Re-checks the rule against the current state: `RULE_GONE`, `RULE_DISABLED`, `RELEASE_GONE`, `NOT_MAJOR`,
  `UNSUPPORTED_CHANNEL`, `UNSUBSCRIBED`, `TAG_REMOVED`, `SNOOZED`, `NOTIFICATION_LEVEL` (the subscription was snoozed
  or its level lowered after the fan-out) → `SKIPPED`.
- Email rules: `toSmtpConfig(await loadSmtpSettings(prisma))` on **every job** (UI changes apply without a restart). An
  unreadable password becomes a permanent failure.
- `dispatchNotification(input, { smtp, signal })`. `NotificationDeliveryError.permanent` → `UnrecoverableError`.

## Lifecycle

- Startup: health server → `prisma.$connect()` (a failure is reported by `/health`, not a crash) → requires
  `REDIS_URL` → `readBackfillConfig()` (fails fast on bad values) → workers → schedule. Each backfill job then merges
  the admin overrides (`applyBackfillOverrides(env, await loadBackfillOverrides(prisma))`, env only if that read fails),
  so Admin → Release history changes apply without a restart.
- `SIGTERM`/`SIGINT`: `worker.close()` drains active jobs, then queues, health server, Redis and Prisma close, exit 0.
  The force-exit timeout is 25 s, below compose's `stop_grace_period: 30s`.
- `GET /health` → 200 `{ status: "ok", checks: { database, redis } }` or 503. It never leaks error details.
- Logging: `createLogger(scope)` from `src/logger.ts` gives `[scope] message` lines.

## Testing

Processors take a `deps` object (`prisma`, `redis`, queues, injectable `dispatch`), so tests pass fakes:
`fakePrisma({...}) as never`. See `notification.processor.test.ts` and `repo-poll.processor.test.ts`. The worker
resolves `@repopulse/*` from `dist/`: rebuild packages after changing them.

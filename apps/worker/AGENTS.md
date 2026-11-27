# AGENTS.md — `@repopulse/worker` (`apps/worker`)

Guidance for coding agents working in the BullMQ release polling, history backfill, and notification delivery worker (`apps/worker`, health port `3001`).

> **References:** [`docs/apps/worker.md`](../../docs/apps/worker.md) · [`docs/CONTRACTS.md`](../../docs/CONTRACTS.md) · [`docs/packages/queue.md`](../../docs/packages/queue.md) · [`docs/packages/notifications.md`](../../docs/packages/notifications.md)

## 1. Non-Negotiable Invariants

- **Queue Deduplication & Priorities:** Enqueue jobs with `enqueueDeduplicated` / `deduplicatedJobOptions` or `*JobId()` helpers (`keepLastIfActive: true`, bounded `removeOnComplete`/`removeOnFail`). Never put `:` in jobIds. Always set explicit priorities on prioritized queues.
- **Errors & Rate Limits:** Throw `UnrecoverableError` for permanent failures; rethrow transient errors for backoff retries. On `GitHubRateLimitError`, call `queue.rateLimit(ms)` and throw `Worker.RateLimitError()`; in backfill, move jobs with `job.moveToDelayed`.
- **Notifications & Read State:** Check `mayNotify` (`snoozedUntil`, `notificationLevel`) and `ruleMatches` (`events` includes `RELEASES`) before queueing notifications, and re-verify state in `processNotification`. History backfill must create zero `UserReleaseState` rows.
- **Boundaries & ESM:** Never import `apps/deps-worker`. Use `.js` extensions on relative imports (`src/`), inject dependencies into processors for unit tests, and rebuild `packages/*` before testing.

## 2. Commands

```sh
pnpm --filter @repopulse/worker build
pnpm --filter @repopulse/worker typecheck
pnpm --filter @repopulse/worker lint
pnpm --filter @repopulse/worker test
```

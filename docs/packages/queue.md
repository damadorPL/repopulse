# `@repopulse/queue` (`packages/queue`)

> **Summary:** shared BullMQ queue factories, job names, payload types, deduplication and priority helpers, backfill configuration merging, ioredis factory, browser-safe SSE event contract (`@repopulse/queue/events`), shared HTTP health server, and structured Pino logger. Consumed by `apps/web`, `apps/worker`, `apps/deps-worker`, and `apps/deps-sandbox` (logger only).
>
> **Related Docs:** [../CONTRACTS.md](../CONTRACTS.md) · [../apps/worker.md](../apps/worker.md) · [../apps/deps-worker.md](../apps/deps-worker.md)

## Rules

- **MUST NOT** import `node:*`, `ioredis`, or `bullmq` from the browser-safe subpath `@repopulse/queue/events` (`events.ts`).
- **MUST NOT** put `:` in BullMQ jobIds or deduplication ids (use `-`).
- **MUST** update `RealtimeEvent`, `parseRealtimeEvent`, `packages/queue/src/events.test.ts`, worker publishers, and `apps/web/src/components/realtime/sse-listener.tsx` together whenever adding or changing an SSE event.
- **MUST** use `.js` extensions on relative ESM imports and run `pnpm --filter "./packages/*" build` after edits.

## Public Exports (`packages/queue/src/index.ts`)

| Export / Subpath | What |
| --- | --- |
| `@repopulse/queue/events` (`events.ts`) | Browser-safe `RealtimeEvent`, `RealtimeEventType`, `SyncFailureReason`, `userEventsChannel`, `serializeRealtimeEvent`, `parseRealtimeEvent` |
| Core queues (`names.ts`) | `QUEUE_NAMES`, `JOB_NAMES`, `SCHEDULER_ID`, `DEFAULT_POLL_INTERVAL_CRON`, `RepoPollJobData` / `ReleaseBackfillJobData` / `NotificationJobData` / `SchedulerJobData`, `*_JOB_OPTIONS`, `*_PRIORITY`, `repoPollJobId`, `releaseBackfillJobId`, `notificationJobId`, `create{Scheduler,RepoPoll,Notification,ReleaseBackfill}Queue` |
| Dependencies queues (`deps.ts`) | `DEPS_QUEUE_NAMES`, `DEPS_JOB_NAMES`, `DEPS_SCHEDULER_ID`, `DEFAULT_DEPS_SCAN_CRON`, `Deps{Scan,Update,Notify,Scheduler}JobData`, `DepsScanTrigger`, `DEPS_*_JOB_OPTIONS`, `DEPS_*_PRIORITY`, `deps{Scan,Update,Notify}JobId`, `createDeps{Scheduler,Scan,Update,Notify}Queue` |
| Queue & worker helpers (`queues.ts`, `rate-limit.ts`) | `createQueue` (attaches `"error"` listener), `deduplicatedJobOptions` (`keepLastIfActive: true`), `enqueueDeduplicated`, `attachWorkerListeners` (`failed`, `stalled`, `lockRenewalFailed`, `error`), `rateLimitDelayMs` |
| Backfill config (`backfill.ts`) | `BACKFILL_DEFAULTS`, `BACKFILL_LIMITS`, `DEEP_BACKFILL_STEP` (200), `DEEP_BACKFILL_COOLDOWN_MS` (5 min), `readBackfillConfig(env)`, `applyBackfillOverrides(base, overrides)` |
| Redis (`redis.ts`) | `createRedisConnection(opts)` (`maxRetriesPerRequest: null` worker default; `apps/web` overrides to `1`), `publishUserEvent(redis, userId, event)`, `Redis` |
| Health server (`health.ts`) | `startHealthServer`, `getHealthReport`, `checkDatabase`, `checkRedis`, `pingRedis`, `resolveHealthPort` (shared by `worker` on `:3001` and `deps-worker` on `:3002`) |
| Structured logging (`logger.ts`) | `createLogger(service, options)` (Pino JSON in production, `pino-pretty` in non-production TTY), `errorMessage`, `ServiceLogger` |

# Agent Implementation Slice 04: BullMQ Background Worker, Conditional ETag Polling & Live SSE Updates

## 1. Objective & Scope
Implement the persistent background worker (`apps/worker`) powered by **BullMQ** and **Redis**. It schedules periodic repository checks, deduplicates polling across all subscribed users, respects GitHub rate limits and `ETag` headers, fans out newly discovered releases into `UserReleaseState`, and pushes real-time updates to `apps/web` over Redis Pub/Sub + Server-Sent Events (SSE).

* **Prerequisites:** Slices 01, 02, and 03 completed.
* **Out of Scope:** External email/webhook formatting (stubbed via queue handoff for Slice 05).

---

## 2. Target Files to Create / Modify
```text
repopulse/
├── apps/
│   ├── worker/
│   │   └── src/
│   │       ├── index.ts                     # Entrypoint, BullMQ initialization & SIGTERM shutdown
│   │       ├── redis.ts                     # ioredis connection factory (maxRetriesPerRequest: null)
│   │       ├── queues/
│   │       │   └── index.ts                 # repoPollQueue, schedulerQueue, notificationQueue
│   │       └── processors/
│   │           ├── scheduler.processor.ts   # Finds due repositories & enqueues poll jobs
│   │           └── repo-poll.processor.ts   # Calls @repopulse/github, stores releases, publishes Redis event
│   └── web/
│       └── src/
│           ├── server/actions/
│           │   └── sync.ts                  # triggerManualRepoSyncAction (5-min cooldown)
│           ├── app/api/events/stream/
│           │   └── route.ts                 # SSE endpoint subscribing to Redis user:{userId}:events
│           └── components/realtime/
│               └── sse-listener.tsx         # Client hook listening to SSE & refreshing UI/toasts
```

---

## 3. Step-by-Step Agent Instructions

### Step 3.1: Redis & BullMQ Queue Setup (`apps/worker/src/queues/index.ts`)
1. Configure `ioredis` connection using `process.env.REDIS_URL` with `maxRetriesPerRequest: null` (required by BullMQ).
2. Create three BullMQ queues:
   * `repo-scheduler`: Repeatable cron job running on `process.env.POLL_INTERVAL_CRON || '*/30 * * * *'`.
   * `repo-poll`: Processes individual repository checks (`concurrency: 5`, exponential backoff on failure).
   * `notification-dispatch`: Processes outbound user notifications (`concurrency: 10`).

### Step 3.2: Deduplicated Scheduler Processor (`scheduler.processor.ts`)
1. Query `Repository` records where:
   * At least one `UserSubscription` exists (`subscriptions: { some: {} }`), AND
   * `pollStatus !== 'POLLING'`, AND
   * `lastPolledAt` is `null` or older than 25 minutes.
2. Enqueue a job in `repo-poll` for each due repository with `jobId: \`poll:\${repo.id}\`` (prevents duplicate concurrent jobs for the same repo).

### Step 3.3: Repository Poll Processor & Fan-Out (`repo-poll.processor.ts`)
1. For a given `repositoryId`:
   * Mark `Repository.pollStatus = 'POLLING'`.
   * Fetch one active subscriber's `githubAccessTokenEncrypted` and decrypt it via `decryptToken()` so the request uses an authenticated 5,000 req/hr quota.
   * Call `pollRepoReleases({ owner, name, lastEtag, accessToken })` from `@repopulse/github`.
2. **If `status === 'NOT_MODIFIED'` (HTTP 304)**:
   * Update `Repository` with `lastPolledAt = new Date()`, `pollStatus = 'IDLE'`, `errorCount = 0` and return immediately.
3. **If `status === 'UPDATED'` (HTTP 200)**:
   * Query existing `githubReleaseId`s for this `repositoryId`.
   * Filter the returned releases to find genuinely **new** releases not yet in PostgreSQL.
   * Inside `prisma.$transaction`:
     * Insert new `Release` rows.
     * Query all `UserSubscription` rows for `repositoryId` (including their `tags` and `user.notificationRules`).
     * For each subscriber (skipping pre-releases if `subscription.includePrereleases === false`), create an unread `UserReleaseState` (`isRead: false`).
     * Update `Repository` (`lastEtag`, `lastPolledAt = new Date()`, `pollStatus = 'IDLE'`, `errorCount = 0`).
   * For each affected `userId`:
     * Publish JSON payload `{ type: 'NEW_RELEASE', repositoryName: repo.fullName, tagName: release.tagName, releaseId: release.id }` to Redis Pub/Sub channel `user:${userId}:events`.
     * Enqueue a job in `notification-dispatch` queue for each matching `NotificationRule`.
4. **Error & Rate-Limit Handling**:
   * If GitHub returns `404 Not Found`, increment `errorCount`. If `errorCount >= 5`, set `pollStatus = 'ERROR'`.
   * If GitHub returns `403`/`429` rate-limit exceeded, read `X-RateLimit-Reset` and call `repoPollQueue.rateLimit(delayMs)`.

### Step 3.4: Graceful Coolify `SIGTERM` Shutdown (`apps/worker/src/index.ts`)
1. Register `process.on('SIGTERM', gracefulShutdown)` and `process.on('SIGINT', gracefulShutdown)`.
2. In `gracefulShutdown()`:
   * Log shutdown start.
   * Call `await Promise.all([schedulerWorker.close(), repoPollWorker.close(), notificationWorker.close()])`.
   * Close HTTP health server, `redis.quit()`, and `prisma.$disconnect()`.
   * Exit with `process.exit(0)`.

### Step 3.5: Manual Sync Action & Real-Time SSE Endpoint (`apps/web`)
1. **`triggerManualRepoSyncAction(repositoryId)`**:
   * Check if `repo.lastPolledAt` is within the last 5 minutes; if so, return a cooldown notice.
   * Otherwise enqueue a priority job (`priority: 1`) into `repo-poll` queue from `apps/web` and publish `{ type: 'SYNC_STARTED', repositoryId }`.
2. **`apps/web/src/app/api/events/stream/route.ts`**:
   * Authenticate user session.
   * Create a dedicated `ioredis` subscriber connection for `user:${user.id}:events`.
   * Return a `ReadableStream` with headers `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`.
   * Clean up the Redis subscription on `request.signal.addEventListener('abort', ...)`.
3. **`sse-listener.tsx`**:
   * Connect to `/api/events/stream` using `EventSource`. On `NEW_RELEASE` or `SYNC_COMPLETED`, show a toast notification and call `router.refresh()` to update the panel live.

---

## 4. Verification & Acceptance Criteria
- [ ] Polling a repository twice in a row results in HTTP `200` on the first run and HTTP `304 Not Modified` on the second run (verified in worker logs).
- [ ] Inserting a simulated new release via the worker creates an unread `UserReleaseState` and immediately updates the open browser tab via SSE without refreshing the page manually.
- [ ] Sending `kill -SIGTERM <worker_pid>` cleanly drains active BullMQ workers and exits with code `0`.
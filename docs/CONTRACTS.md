# Cross-Component Contracts

> **Summary:** shared wire, queue, SSE, HTTP, webhook, and Redis contracts across `apps/web`, `apps/worker`, `apps/deps-worker`, `apps/deps-sandbox`, and `packages/*`.
>
> **Related Docs:** [ARCHITECTURE.md](./ARCHITECTURE.md) · [CODING_STANDARDS.md](./CODING_STANDARDS.md) · [packages/queue.md](./packages/queue.md)

## Server Action Contract

Defined in `apps/web/src/server/action-result.ts`. Server Actions never throw raw errors to the browser; they return a serializable `ActionResult<T>`:

```ts
type ActionErrorCode =
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "INVALID_INPUT"
  | "NOT_FOUND"
  | "CONFLICT"
  | "RATE_LIMITED"
  | "UNAVAILABLE"
  | "DELIVERY_FAILED"
  | "INTERNAL";

type ActionResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: ActionErrorCode; message: string } };
```

- `toActionError(error, action)` maps `UnauthorizedError` → `UNAUTHORIZED`, `ForbiddenError` → `FORBIDDEN`, `InvalidRepositoryInputError` → `INVALID_INPUT`, `GitHubRepositoryNotFoundError` → `NOT_FOUND`, `GitHubRateLimitError` → `RATE_LIMITED`, and logs + redacts unexpected errors as `INTERNAL`.
- Actions hitting Redis wrap operations in `withRedisTimeout()` and map `RealtimeUnavailableError` → `UNAVAILABLE`.
- Zod schemas live in server-only `src/lib/*-schema.ts` modules (never imported by client components) and are validated via `safeParse` → `invalidInput(parsed.error)`.

## Realtime SSE Contract

Defined in `@repopulse/queue/events` (`packages/queue/src/events.ts`, browser-safe):

- **Redis Pub/Sub channel:** `userEventsChannel(userId)` → `user:{userId}:events`.
- **Stream endpoint:** `GET /api/events/stream` (`401` unauthenticated, `503` when `REDIS_URL` is unset). Multiplexed over one shared ref-counted Redis subscriber per `web` process (`apps/web/src/server/realtime.ts`).
- **Framing:** initial `retry: 5000\n: connected\n\n`, `: ping\n\n` heartbeat every 25 s, and `data: <JSON RealtimeEvent>\n\n` frames parsed with `parseRealtimeEvent`.

| Event `type` | Payload fields | Producer |
| --- | --- | --- |
| `NEW_RELEASE` | `repositoryId`, `repositoryName`, `tagName`, `releaseId` | `worker` (`repo-poll`) |
| `SYNC_STARTED` | `repositoryId`, `repositoryName` | `web` (`triggerManualRepoSyncAction`) |
| `SYNC_COMPLETED` | `repositoryId`, `repositoryName`, `result: "NOT_MODIFIED" \| "UPDATED"`, `newReleases` | `worker` (`repo-poll`, manual only) |
| `SYNC_FAILED` | `repositoryId`, `repositoryName`, `reason: "NOT_FOUND" \| "RATE_LIMITED" \| "ERROR"`, `message` | `worker` (`repo-poll`, manual only) |
| `HISTORY_BACKFILLED` | `repositoryId`, `repositoryName`, `added` | `worker` (`release-backfill`) |
| `DEPS_SCAN_COMPLETED` | `projectId`, `fullName`, `outdated`, `majors` | `deps-worker` (`deps-scan`) |
| `DEPS_SCAN_FAILED` | `projectId`, `fullName`, `message` (user-safe) | `deps-worker` (`deps-scan`, manual only) |
| `DEPS_PULL_REQUEST_UPDATED` | `projectId`, `fullName`, `groupKey`, `state: "OPEN" \| "MERGED" \| "CLOSED" \| "EDITED" \| "FAILED"`, `number`, `htmlUrl`, `message?` | `deps-worker` (`deps-scan` / `deps-update`) |

Changing `RealtimeEvent`: update the union and `parseRealtimeEvent` in `packages/queue/src/events.ts`, `packages/queue/src/events.test.ts`, worker publishers, and `apps/web/src/components/realtime/sse-listener.tsx`.

## BullMQ Queues & Job Contracts

Defined in `@repopulse/queue` (`packages/queue/src/{names,deps,queues}.ts`).

- **MUST** use `deduplicatedJobOptions` / `enqueueDeduplicated` (`deduplication: { id, keepLastIfActive: true }`) or the `*JobId()` helpers so overlapping triggers cannot stack jobs.
- **MUST NOT** put `:` in any jobId or deduplication id (BullMQ rejects it; use `-`).
- **MUST** set explicit priorities on every prioritized queue (BullMQ runs unprioritized jobs ahead of prioritized ones).
- Permanent failures throw `UnrecoverableError` (no retry); transient errors rethrow; rate limits call `queue.rateLimit(ms)` + `throw Worker.RateLimitError()`, or `job.moveToDelayed()` + `DelayedError`.

### Core Queues (`QUEUE_NAMES`, consumed by `apps/worker`)

| Queue | Job name | Payload | Dedup / jobId | Concurrency | Options |
| --- | --- | --- | --- | --- | --- |
| `repo-scheduler` | `scan-due-repositories` | `{}` | repeatable `repo-scheduler-cron` | 1 | `removeOnComplete: true`, `removeOnFail: { count: 50 }` |
| `repo-poll` | `poll-repository` | `{ repositoryId, trigger: "schedule" \| "manual", requestedByUserId? }` | `poll-{repositoryId}` (`keepLastIfActive: true`) | `REPO_POLL_CONCURRENCY` (5), limiter 10/s | 3 attempts, exp. 30 s; priority manual `1` / scheduled `10`; `removeOnComplete: { count: 200 }`, `removeOnFail: { age: 7d, count: 200 }`, `keepLogs: 50` |
| `release-backfill` | `backfill-releases` | `{ repositoryId, trigger: "add" \| "sweep" \| "deep" \| "retry" }` | `backfill-{repositoryId}` (`keepLastIfActive: true`) | 2 | 3 attempts, exp. 60 s; priority requested `1` / automatic `10`; `removeOnComplete: { count: 200 }`, `removeOnFail: { age: 7d, count: 200 }`, `keepLogs: 50` |
| `notification-dispatch` | `dispatch-notification` | `{ ruleId, releaseId, userId }` | `notify-{ruleId}-{releaseId}` | `NOTIFICATION_CONCURRENCY` (10) | 3 attempts, exp. 5 s; retained 7 d (`count: 5000`) for dedup |

### Dependencies Queues (`DEPS_QUEUE_NAMES`, consumed by `apps/deps-worker`)

| Queue | Job name | Payload | Dedup / jobId | Concurrency | Options |
| --- | --- | --- | --- | --- | --- |
| `deps-scheduler` | `scan-due-dependency-projects` | `{}` | repeatable `deps-scheduler-cron` (`DEPS_SCAN_CRON`, default `17 * * * *`) | 1 | `removeOnComplete: true`, `removeOnFail: { count: 50 }` |
| `deps-scan` | `scan-dependency-project` | `{ projectId, trigger: "add" \| "schedule" \| "manual" \| "webhook", requestedByUserId? }` | `deps-scan-{projectId}` (`keepLastIfActive: true`) | `DEPS_SCAN_CONCURRENCY` (3), limiter 10/s | 3 attempts, exp. 60 s; priority manual/add `1`, schedule/webhook `10`; `lockDuration: 120s`; `keepLogs: 50` |
| `deps-update` | `update-dependency-group` | `{ projectId, groupKey, trigger: "manual" \| "auto" }` (`groupKey` `[a-z0-9-]` only) | `deps-update-{projectId}-{groupKey}` (`keepLastIfActive: true`) | `DEPS_UPDATE_CONCURRENCY` (1), limiter 5/s | 2 attempts, exp. 120 s; priority manual `1` / auto `10`; `lockDuration: 120s`; `keepLogs: 50` |
| `deps-notify` | `dispatch-dependency-notification` | `{ ruleId, projectId, kind: "digest", scanId, updateIds }` or `{ …, kind: "pull_request", prId, event, dedupKey }` | `deps-notify-{ruleId}-{scanId \| prId-dedupKey}` | 5 | 3 attempts, exp. 5 s; retained 7 d (`count: 5000`) for dedup |

Producers for `DEPS_QUEUE_NAMES`: `apps/web` (add project, "Check now", re-checks, "Create PR"), `POST /api/github-app/webhook` (`trigger: "webhook"`), and `apps/deps-worker` (scheduler, auto PRs, outbox notification dispatcher).

## Sandbox HTTP Contract

Defined in `@repopulse/deps/sandbox-contract` (`packages/deps/src/sandbox-contract.ts`, Zod schemas validated by both `deps-worker` and `deps-sandbox`):

- **`GET /health`** (no auth) → `200` `{ status: "ok", tools: { npm, pnpm, bun, uv, poetry } }`.
- **`POST /v1/lock`**:
  - Header: `Authorization: Bearer <DEPS_SANDBOX_TOKEN>` (constant-time SHA-256 check).
  - Body (≤ 30 MiB): `{ packageManager: "NPM" | "PNPM" | "BUN" | "UV" | "POETRY", workdir, files: { path, contentBase64 }[] (≤ 2,000), upgrade: { name, version }[], lockfileOnly, expectLockfile }`.
  - Response (always matches `lockResponseSchema`): `{ ok: true, lockfile }` or `{ ok: false, code, stderrTail }`.
  - Protocol HTTP statuses: `400 BAD_REQUEST`, `401 UNAUTHORIZED`, `413 TOO_LARGE`, `503 BUSY` (single active job at a time; includes `Retry-After: 10`), `500 INTERNAL`.
  - Job outcome HTTP status `200`: `ok: true`, or `ok: false` with `UNSUPPORTED_REGISTRY`, `UNSUPPORTED_TOOL_VERSION`, `TIMEOUT`, `COMMAND_FAILED`, `LOCKFILE_MISSING`, or oversized lockfile.

## GitHub App Webhook Contract

Endpoint: `POST /api/github-app/webhook` (`apps/web/src/app/api/github-app/webhook/route.ts`). Public route authenticated solely by `X-Hub-Signature-256` (HMAC-SHA256, constant time). Performs **no database writes**; only enqueues `deps-scan` (`trigger: "webhook"`).

Check order:
`413` (body > 5 MiB) → `404` (no GitHub App configured) → `503` (missing or unreadable webhook secret) → `401` (invalid `X-Hub-Signature-256`) → `204` (module disabled or event other than `push` / `pull_request`) → `400` (invalid JSON) → `202 { queued }`.

- `push` to a branch matching a project's stored `defaultBranch`: queues every project (any user) whose dependency files changed (any manifest/lockfile name or explicit `manifestPaths`), or all matching-branch projects if the commit file list is missing, empty, or truncated at GitHub's 2,048 cap.
- `pull_request` `closed` on a `repopulse/deps/*` head branch: queues the PR owner's project.

## Custom Notification Webhook Payloads

Delivered via `postWebhook` (`packages/notifications`) with `X-RepoPulse-Event` set to the event name, two-layer SSRF validation, 10 s timeout, no redirects, and `agent: false`:

| `X-RepoPulse-Event` | JSON shape | Trigger |
| --- | --- | --- |
| `release.published` | `{ event: "release.published", test, repository, release, links }` | `dispatchNotification()` |
| `dependencies.outdated` | `{ event: "dependencies.outdated", test, repository, updates, totalUpdates, pullRequest: null, links }` | `dispatchDependencyNotification()` (`kind: "digest"`) |
| `dependencies.pull_request` | `{ event: "dependencies.pull_request", test, repository, updates, totalUpdates, pullRequest: { event, number, url, title }, links }` | `dispatchDependencyNotification()` (`kind: "pull_request"`) |

## Redis Key Schema

| Key | Written by | TTL / Lifecycle |
| --- | --- | --- |
| `user:{userId}:events` | `worker`, `deps-worker`, `web` (Pub/Sub) | Transient Pub/Sub channel |
| `deps:worker:heartbeat` | `deps-worker` every 30 s (`{ at, sandbox: health \| null }`) | 90 s |
| `deps:reg:<npm\|npm-time\|pypi\|pypi-meta>:<name>` | `deps-worker` (registry body + `ETag`) | 7 days (fresh 1 h, then conditional `If-None-Match`) |
| `deps:blob:<sha>`, `deps:lockread:<key>` | `deps-worker` (blob text & parsed lockfile reads; may hold private manifests) | 7 days |

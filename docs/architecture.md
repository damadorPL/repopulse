# Architecture

> **Summary:** two Node processes (`web` = Next.js, `worker` = BullMQ) share PostgreSQL (state) and Redis (queues
> plus Pub/Sub). The web app reads and writes state and enqueues jobs. The worker talks to GitHub, stores releases,
> fans them out and delivers notifications. Live updates go worker → Redis Pub/Sub → web SSE → browser. The optional
> Dependencies module adds three services of its own (`deps-worker`, `deps-sandbox`, `deps-egress`) on the same
> PostgreSQL and Redis ([dependencies.md](./dependencies.md)).

## Workspaces

| Path | Package | Role | Runtime |
| --- | --- | --- | --- |
| `apps/web` | `@repopulse/web` | Next.js 16 App Router UI, Server Actions, Auth.js v5, SSE endpoint, `GET /api/health` | Node, port 3000 |
| `apps/worker` | `@repopulse/worker` | BullMQ workers (scheduler, repo-poll, release-backfill, notification-dispatch), `GET :3001/health` | Node, port 3001 |
| `apps/deps-worker` | `@repopulse/deps-worker` | Dependencies module: BullMQ workers (deps-scheduler, deps-scan, deps-update, deps-notify), Redis heartbeat, `GET :3002/health` | Node, port 3002 |
| `apps/deps-sandbox` | `@repopulse/deps-sandbox` | Runs package managers to regenerate lockfiles (`POST /v1/lock`, `GET /health`); no secrets, internal network only | Node + npm / pnpm / Bun / uv / Poetry, port 3003 |
| `packages/db` | `@repopulse/db` | Prisma 7 schema and migrations, singleton client (`@prisma/adapter-pg`), AES-256-GCM crypto, SMTP settings loader | library (CJS dist) |
| `packages/github` | `@repopulse/github` | Octokit wrapper, repo-input parser, SemVer classifier, ETag polling, release paging, GraphQL tags, commit compare; GitHub App, Git Data API writes, webhook signatures | library (ESM) |
| `packages/queue` | `@repopulse/queue` | Queue and job names, payload types, job options, jobId helpers, Redis factory, `RealtimeEvent` contract | library (ESM) |
| `packages/notifications` | `@repopulse/notifications` | Channel formatters, `dispatchNotification()`, `dispatchDependencyNotification()`, SSRF guard, SMTP transport | library (ESM) |
| `packages/deps` | `@repopulse/deps` | Dependencies module logic: manifest detection and parsing, lockfile readers, npm / PEP 440 versions, registry clients, planning, manifest rewrites, PR text, sandbox contract | library (ESM) |
| `packages/tsconfig` | `@repopulse/tsconfig` | Shared `base.json` and `nextjs.json` | config |

Dependency direction: `apps/*` → `packages/*`. Packages never import apps. `notifications` and `deps` do **not**
depend on `db`: their input types are structural, so the apps pass Prisma rows straight in. `deps-worker` and
`worker` never import each other.

Stack: Node ≥ 24 (images use Node 26), pnpm 12, Turborepo 2, TypeScript 7, Next.js 16.4, React 19.3, Prisma 7.10,
BullMQ 6, ioredis 6, Tailwind CSS 4 with shadcn/ui on `radix-ui`, zod 4, Vitest 5.

## Processes and stores

```
           ┌──────────── browser ────────────┐
           │  RSC pages, Server Actions,      │
           │  EventSource /api/events/stream  │
           └──────────────┬──────────────────┘
                          │ HTTPS
                ┌─────────▼─────────┐  enqueue jobs  ┌──────────────┐
                │   web (Next.js)   ├───────────────►│    Redis     │
                │ actions, SSE relay│◄───────────────┤ BullMQ +     │
                └───┬───────────────┘ Pub/Sub sub.   │ Pub/Sub      │
                    │ Prisma                         └──────▲───────┘
                ┌───▼──────────┐                            │ consume / publish
                │  PostgreSQL  │◄───────────────────┬───────┴──────┐
                └──────────────┘        Prisma      │    worker    ├──► GitHub REST/GraphQL
                                                    │   (BullMQ)   ├──► webhooks / SMTP
                                                    └──────────────┘
```

Dependencies module (only when deployed and enabled in Admin → Dependencies):

```
   web ──enqueue deps-*──► Redis ◄──consume / publish / heartbeat──┐
   POST /api/github-app/webhook ──enqueue deps-scan                │
                                                     ┌─────────────┴─────┐ Prisma ┌────────────┐
                                                     │    deps-worker    ├───────►│ PostgreSQL │
     GitHub REST (App installation tokens)   ◄───────┤ scan, update PRs, │        └────────────┘
     npm registry / PyPI (cached in Redis)   ◄───────┤ notify            ├──► webhooks / SMTP
                                                     └─────────┬─────────┘
                       network deps_sandbox (internal)         │ POST /v1/lock (Bearer DEPS_SANDBOX_TOKEN)
                                                     ┌─────────▼─────────┐ CONNECT :443 ┌─────────────┐
                                                     │   deps-sandbox    ├─────────────►│ deps-egress ├──► npm / PyPI
                                                     │ npm, pnpm, Bun,   │              │   (Squid    │    registries
                                                     │ uv, Poetry;       │              │  allowlist) │    only
                                                     │ no secrets        │              └─────────────┘
                                                     └───────────────────┘
```

## Core flows

### 1. Add a repository (web, synchronous)
`addRepositoryAction` (`apps/web/src/server/actions/repositories.ts`):
1. `parseRepoInput()` normalizes `owner/repo`, URLs and SSH forms.
2. `validateAndFetchRepo()` fetches metadata, the latest 10 releases (`INITIAL_RELEASES_LIMIT`) and the `ETag`. This
   happens **before** the transaction, so no DB connection is held during network I/O.
3. One transaction upserts the `Repository` by `githubRepoId`, inserts the releases, and creates the
   `UserSubscription`, the `SubscriptionTag` links (only tags the user owns) and unread `UserReleaseState` rows.
4. Best effort afterwards: queue `release-backfill` (if `backfillStatus` is `NONE`/`ERROR`) and a priority poll
   (`queueRepoImport`) for `TAGS_AND_COMMITS` when tags were never read, and/or with `trackPaths` when a watched path
   is not in `polledPaths` yet.
- Release tracking (`trackMode`) and "Files / folders" (`trackPaths`) are independent: a subscription can follow both.
  Releases are seeded unless `trackMode = NONE`; with `trackPaths`, `syncCommitStates` also gives the user states for
  stored commits matching their paths (another user may already watch them).

### 2. Scheduled polling (worker)
`repo-scheduler` runs on `POLL_INTERVAL_CRON` (default `*/30 * * * *`) plus once at startup. It enqueues one
`repo-poll` job per due repository (jobId `poll-{repositoryId}` deduplicates). `repo-poll` makes a conditional request
(`If-None-Match: lastEtag`):
- `304` → only bookkeeping.
- `200` → insert the new releases, then `planFanOut()`: unread rows for each subscriber (pre-releases only for
  subscriptions that opt in), SSE `NEW_RELEASE` events, and `notification-dispatch` jobs for matching rules.
- With any `TAGS_AND_COMMITS` subscriber, a best-effort tag step (`pollRepoTags`) runs after the release step.
- With any `trackPaths` subscriber, a best-effort path step (`pollRepoPaths`) runs after that: commits touching the watched
  paths, fanned out per subscriber.
Details: [worker.md](./worker.md).

### 3. Manual sync
`triggerManualRepoSyncAction` enqueues a priority-1 `repo-poll` (5-minute cooldown per repository, based on
`lastPolledAt`) and returns `QUEUED` or `COOLDOWN`. The result arrives over SSE as `SYNC_STARTED` →
`SYNC_COMPLETED` / `SYNC_FAILED`, addressed to the requesting user.

### 4. History backfill
`release-backfill` pages through older releases (100 per page) and stores them **without** `UserReleaseState`, which
means read: no unread counts and no notifications. It stops at `backfillTarget`, at the end of the history, or at
the age limit (automatic runs only). "Load older releases" raises the target by a step (200), up to the hard cap. All
of these come from `RELEASE_BACKFILL_*` (or defaults) with per-value overrides in Admin → Release history
(`InstanceSettings.backfill*`), read by the worker on every backfill job and by web for "Load older releases".

### 5. Live updates
Worker → `publishUserEvent(redis, userId, event)` on `user:{userId}:events` → `GET /api/events/stream` (one Redis
subscriber per open stream, 25 s heartbeat) → `SseListener` shows toasts and calls `router.refresh()`.
Events (`packages/queue/src/events.ts`): `NEW_RELEASE`, `SYNC_STARTED`, `SYNC_COMPLETED`, `SYNC_FAILED`,
`HISTORY_BACKFILLED`, and from `deps-worker` `DEPS_SCAN_COMPLETED`, `DEPS_SCAN_FAILED`, `DEPS_PULL_REQUEST_UPDATED`.
Publishing is best effort: a missed event is fixed by the next page load.

### 6. Notifications
`notification-dispatch` job `{ ruleId, releaseId, userId }` → re-check the rule (enabled, `RELEASES` in `events`,
major-only, still subscribed, tag still assigned) → for email, load the SMTP settings from `InstanceSettings` →
`dispatchNotification()`. Permanent failures become `UnrecoverableError` (no retry). Details:
[notifications.md](./notifications.md).

### 7. Dependency scan and update PR
1. A user adds a project (`addDependencyProjectsAction`) or clicks "Check now", the hourly `deps-scheduler` finds it
   due (`nextScanAt`), or a GitHub App `push` webhook arrives → `deps-scan` (jobId `deps-scan-{projectId}`).
2. `deps-worker` reads the default-branch tree with the best credentials (App installation token → the owner's OAuth
   token → anonymous), detects and parses manifests and lockfiles in TypeScript, looks up the npm registry / PyPI
   (Redis cache), applies the project policy (`selectTarget`) and stores `DependencyManifest` / `DependencyUpdate`
   rows in one transaction. Then it refreshes open PR states, publishes `DEPS_SCAN_COMPLETED`, queues `deps-notify`
   digests for new targets and, in `AUTO_PR` mode, `deps-update` jobs.
3. `deps-update` (or "Create PR") re-checks the mode, PR ownership, App installation and the owner's `write`
   permission, recomputes the group, span-edits the manifests, asks `deps-sandbox` for the regenerated lockfile
   (validated by the worker), commits through the Git Data API to `repopulse/deps/<groupKey>` as `<slug>[bot]` and
   opens or updates the PR. `DEPS_PULL_REQUEST_UPDATED` and `deps-notify` follow.
4. A merged or closed PR is picked up by the next scan (sooner with the `pull_request` webhook). Details:
   [dependencies.md](./dependencies.md).

## Cross-cutting design decisions

| Decision | Why |
| --- | --- |
| Repository and release data are **shared** between users; subscriptions, tags, read state and rules are per user | Each repository is polled once per interval, however many users track it |
| Deterministic BullMQ jobIds (`poll-`, `backfill-`, `notify-{rule}-{release}`) | Overlapping triggers can't stack jobs or send twice. `:` is not allowed in ids, so `-` is used |
| `removeOnComplete: true` for poll and backfill jobs | A retained job would keep its jobId taken and block the next poll |
| GitHub tokens of subscribers are tried in turn (`tokenCandidates`, max 3), falling back to anonymous | Uses the 5,000 req/h authenticated quota; moves on only after a 401 |
| Rate limit → `queue.rateLimit(until X-RateLimit-Reset)` + `Worker.RateLimitError()` | Pauses the whole queue without spending an attempt |
| Instance settings live in the single `InstanceSettings` row (`id = 1`); a missing row means defaults | Settings editable in the UI, read by both processes |
| Release notes are rendered server-side through `rehype-sanitize` (GitHub allow-list) | Release bodies are untrusted input |
| Repository content is only parsed in `deps-worker`; package managers run in `deps-sandbox` (no secrets, egress allowlist) | Lockfile regeneration runs third-party tooling on untrusted input; nothing that holds a token may run it |
| Writes to users' repositories go through a GitHub App installed per repository, never the sign-in token | Sign-in keeps `read:user user:email`; App tokens are short-lived, narrowed to one repository, and commits are bot-authored |

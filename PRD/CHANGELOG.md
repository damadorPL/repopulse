# Changelog

All notable changes to RepoPulse are documented here, one entry per implementation slice.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added
- **Slice 04c: tag tracking ("Releases + tags").** Details: [`slice_04c_implementation_summary.md`](./slice_04c_implementation_summary.md)
  - Migration `20261101090000_tag_tracking`: enum `ReleaseSource`, plus `Release.source` / `tagSha`. `githubReleaseId` is now optional,
    with a new unique key `(repositoryId, source, tagName)`. Also adds `Repository.lastTagsPolledAt`.
  - Each subscription chooses `RELEASES` or `TAGS_AND_COMMITS`: in the Add dialog, or with the "Tags" toggle on each repository card.
  - The `repo-poll` job also reads the newest 20 tags (GraphQL) while any subscriber tracks tags. Each tag without a GitHub Release is
    stored with "commits since the previous tag" (compare API) as its notes. New tags fan out only to tag-mode subscribers.
    The tag step is best effort and never breaks release polling.
  - When a tag later gets a GitHub Release, its row is promoted in place: one entry, no second notification for tag-mode users.
  - The feed and reader show a "Tag" badge on tag entries.
- **Slice 04b: release history backfill.** Details: [`slice_04b_implementation_summary.md`](./slice_04b_implementation_summary.md)
  - Migration `20261031120000_release_backfill`: enum `BackfillStatus`, plus `Repository.backfillStatus`, `backfillNextPage`, `backfillTarget`,
    `backfilledAt` and `backfillRequestedAt`.
  - `fetchReleasesPage()` in `@repopulse/github`: 100 per page, never conditional, with `Link`-header paging.
  - `release-backfill` queue and worker (concurrency 2, jobId `backfill-{repositoryId}`). It imports older releases as read history,
    without `UserReleaseState` rows and without notifications, and it never imports a release newer than the newest one stored.
    It resumes from `backfillNextPage` and pauses itself until the rate-limit reset when the quota falls below `RELEASE_BACKFILL_MIN_QUOTA`.
  - Triggers:
    - after `addRepositoryAction`
    - a `repo-scheduler` sweep, for repositories added before this slice
    - "Load older releases" (`requestDeepBackfillAction`): +200 up to `RELEASE_BACKFILL_HARD_CAP`, with an atomic 5-minute cooldown claim
  - `/repositories` shows the history status on every card. A new `HISTORY_BACKFILLED` event refreshes the page quietly.
  - New settings `RELEASE_BACKFILL_DEFAULT_TARGET`, `RELEASE_BACKFILL_MAX_AGE_DAYS`, `RELEASE_BACKFILL_HARD_CAP` and `RELEASE_BACKFILL_MIN_QUOTA`.
    Add them to existing env files with `pnpm env:sync`.
- Local development environment:
  - `pnpm env:setup` (`scripts/setup-env.mjs`) writes a git-ignored root `.env` with freshly generated
    Postgres and Redis passwords, `AUTH_SECRET` and `TOKEN_ENCRYPTION_KEY`. It refuses to overwrite an existing `.env` unless run with `--force`.
  - `docker-compose.dev.yml` (`pnpm services:up` / `services:down`): Postgres 16 and Redis 7 bound to `127.0.0.1`.
- The root `.env` is loaded automatically outside production by `next.config.ts`, `prisma.config.ts` (Prisma 7 no longer
  loads `.env` files) and the worker `dev` script (`--env-file-if-exists`).

## [0.4.0] — 2026-10-31 — Slice 04: BullMQ worker, ETag polling & live SSE updates

Details: [`slice_04_implementation_summary.md`](./slice_04_implementation_summary.md)

### Added
- **`@repopulse/queue`** workspace package: queue and job names, job payload types, jobId helpers, default job options, the Redis connection
  factory and the `RealtimeEvent` contract (`NEW_RELEASE`, `SYNC_STARTED`, `SYNC_COMPLETED`, `SYNC_FAILED`) on `user:{userId}:events`.
- **Background worker** (`apps/worker`, `bullmq@6.3.16`, `ioredis@6.0.0`):
  - `repo-scheduler` runs a repeatable scan on `POLL_INTERVAL_CRON` (default `*/30 * * * *`) plus one at startup. Each repository with
    subscribers is polled at most once per 25 minutes, however many users track it.
  - `repo-poll` (concurrency 5, exponential backoff) makes conditional `If-None-Match` requests using a subscriber's decrypted token, falling back past
    revoked tokens. New releases are stored and fanned out to subscribers as unread, honoring `includePrereleases`.
  - Rate-limit responses pause the queue until `X-RateLimit-Reset`. Repeated 404s flag the repository `ERROR` after 5.
  - `notification-dispatch` (concurrency 10) receives one job per matching notification rule and release; delivery ships in Slice 05.
  - Graceful SIGTERM/SIGINT shutdown drains active jobs, then closes Redis and the database and exits with code 0.
- **Live updates** (`apps/web`):
  - `GET /api/events/stream` is a Server-Sent Events endpoint backed by Redis Pub/Sub.
  - `SseListener` shows toasts for new releases and sync results and refreshes the dashboard without a reload.

### Changed
- "Sync now" (`triggerManualRepoSyncAction`) enqueues a priority `repo-poll` job instead of polling inline. It returns `QUEUED` or `COOLDOWN`, and the
  result arrives over SSE. A new `UNAVAILABLE` error code covers Redis being unreachable.
- `pollRepoReleases()` accepts an `AbortSignal`.
- `pnpm env:sync` (`scripts/sync-env.mjs`) adds settings introduced by later slices to existing `.env.example` and `.env` files without
  touching existing values. The optional `REPO_POLL_CONCURRENCY` and `NOTIFICATION_CONCURRENCY` settings are added to the `env:setup` template and passed to the worker in
  `docker-compose.coolify.yml`.

## [0.3.0] — 2026-10-31 — Slice 03: Dashboard panel UI, tags & Markdown changelog reader

Details: [`slice_03_implementation_summary.md`](./slice_03_implementation_summary.md)

### Added
- **Dashboard UI** (`apps/web`, Tailwind CSS v4, shadcn/ui on `radix-ui`, light/dark):
  - The sidebar has All Releases (with an unread badge), Unread Only and Tracked Repositories, plus tags with color dots and unread counts.
  - The top bar has a debounced search, an unread bell with a per-repository breakdown, Add Repo and an account menu.
  - On mobile, the sidebar moves into a sheet.
- **Unified release feed** (`/`):
  - Each card shows the repository avatar, a SemVer badge (Major/Minor/Patch/Pre-release), tag pills, a relative time and an unread dot.
  - Filters for All/Unread, SemVer type, tag, repository and search. Sort by newest or oldest.
  - Keyset "Load more" and "Mark all as read".
  - All filter state lives in the URL.
- **Changelog reader:**
  - Slide-over drawer (`?release=`) with sanitized GitHub Flavored Markdown: tables, task lists, `<details>`, highlighted code.
  - Releases are marked read automatically when opened.
  - Buttons for View on GitHub, Mark as unread and Sync repo now.
- **Tags/categories:** create, rename, recolor and delete them in a modal; assign them to repositories on the `/repositories` page.
- **Server Actions:**
  - `createTagAction`, `updateTagAction`, `deleteTagAction`, `assignTagsAction`
  - `toggleReleaseReadAction`, `markAllReadAction`
  - `loadMoreReleasesAction`
  - `triggerManualRepoSyncAction`: polls inline with `If-None-Match` and a 5-minute cooldown per repository. Slice 04 switches it to a BullMQ job.
- **Feed queries** (`server/queries/feed.ts`): a single visibility rule that respects `includePrereleases`, shared by the feed, the reader and every
  unread counter.
- 58 Vitest tests for apps/web, including XSS sanitization of release notes.

### Changed
- The Slice 02 temporary home page is replaced by the `(dashboard)` route group.
- Action result helpers moved to `server/action-result.ts`, and repository actions now revalidate the whole dashboard layout.

### Security
- Release notes pass through `rehype-raw` → `rehype-sanitize` (GitHub allow-list) → `rehype-highlight` on the server. Scripts, event handlers,
  `javascript:`/`data:` URLs, iframes, styles and forms are stripped, and the raw body is never sent to the client.
- Every action is scoped to the signed-in user: tags, subscriptions and read state can only belong to the current user.

## [0.2.0] — 2026-10-31 — Slice 02: GitHub OAuth & shared GitHub ingestion package

Details: [`slice_02_implementation_summary.md`](./slice_02_implementation_summary.md)

### Added
- **`@repopulse/github`** workspace package (ESM, `@octokit/rest@22.0.1`, `semver@7.8.5`):
  - `parseRepoInput()` accepts `owner/repo`, `github.com/owner/repo(.git)`, full `https://github.com/...` URLs
    (deep links such as `/releases/tag/...` included) and `git@github.com:owner/repo.git`; throws
    `InvalidRepositoryInputError`.
  - `classifySemver()` sorts tags into `MAJOR` / `MINOR` / `PATCH` / `PRERELEASE` / `OTHER`.
  - `createOctokit()` (user agent `RepoPulse-Coolify/2.0`) and `getRateLimitInfo()` header inspector.
  - `validateAndFetchRepo()` returns repo metadata, the latest 10 published releases and the exact releases `ETag`.
  - `pollRepoReleases()` makes conditional requests (`If-None-Match`): `304` → `NOT_MODIFIED`, `200` → `UPDATED`.
  - Typed errors: `GitHubRepositoryNotFoundError` (404), `GitHubRateLimitError` (403 with quota 0, or 429).
  - 42 Vitest unit tests (parser, SemVer classifier, poller against a mocked `fetch`).
- **GitHub sign-in** in `apps/web` via Auth.js v5 (`next-auth@5.0.0-beta.32`), JWT sessions, scope `read:user user:email`.
  - On sign-in the OAuth token is AES-256-GCM encrypted (`encryptToken`), and the `User` row is created or updated by `githubId`.
  - `getCurrentUserOrThrow()` helper (cached per request) and `UnauthorizedError`.
  - `/api/auth/[...nextauth]` route handler and `/login` page with error messages.
- **Server Actions** (`apps/web/src/server/actions/repositories.ts`, input validated with `zod@4.6.7`):
  - `addRepositoryAction()`: validates/fetches the repo, then in a single transaction creates or updates the `Repository`
    (keyed by `githubRepoId`), its initial `Release`s, the `UserSubscription`, the `SubscriptionTag` links and unread
    `UserReleaseState`s.
  - `removeSubscriptionAction()`: removes the user's subscription and read states, keeping the shared repo data.
  - Both return serializable `{ ok, data | error }` results (`UNAUTHORIZED`, `INVALID_INPUT`, `NOT_FOUND`,
    `RATE_LIMITED`, `INTERNAL`).
- Temporary signed-in home page (add repo, list and remove subscriptions, sign out) for manual acceptance testing.
- README section on creating the GitHub OAuth App.

### Changed
- `turbo.json`: `dev` now depends on `^build`, so workspace packages' `dist` exists before `next dev` starts.

### Security
- The GitHub access token is never stored in the session cookie; only the internal `userId` is.
- Draft releases are never ingested. Repository data is shared across subscribers, and drafts are only visible to tokens with push access.
- Tags passed to `addRepositoryAction` are attached only if owned by the current user.
- The login `callbackUrl` is restricted to same-origin relative paths.

## [0.1.0] — 2026-10-31 — Slice 01: Monorepo, database & Coolify foundation

### Added
- Turborepo + pnpm workspace (`apps/web`, `apps/worker`, `packages/db`, `packages/tsconfig`), Node ≥ 24, TypeScript 7.
- `@repopulse/db`: Prisma 7 schema (users, repositories, releases, subscriptions, tags, read state, notification
  rules), initial migration, singleton client via `@prisma/adapter-pg`, AES-256-GCM `encryptToken` / `decryptToken`
  with tests.
- `apps/web`: Next.js 16 App Router shell with `GET /api/health`, standalone output.
- `apps/worker`: Node worker shell with `GET :3001/health`.
- Multi-stage Dockerfiles (web, worker, one-off migrator) and `docker-compose.coolify.yml` (Postgres 16, Redis 7 with
  `noeviction`, migrator gating web/worker startup).

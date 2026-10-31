# Changelog

All notable changes to RepoPulse are documented here, one entry per implementation slice.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added
- Local development environment:
  - `pnpm env:setup` (`scripts/setup-env.mjs`) writes a git-ignored root `.env` with freshly generated
    Postgres and Redis passwords, `AUTH_SECRET` and `TOKEN_ENCRYPTION_KEY`. It refuses to overwrite an existing `.env` unless run with `--force`.
  - `docker-compose.dev.yml` (`pnpm services:up` / `services:down`): Postgres 16 and Redis 7 bound to `127.0.0.1`.
- The root `.env` is loaded automatically outside production by `next.config.ts`, `prisma.config.ts` (Prisma 7 no longer
  loads `.env` files) and the worker `dev` script (`--env-file-if-exists`).

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

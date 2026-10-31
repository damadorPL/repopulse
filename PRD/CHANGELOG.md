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

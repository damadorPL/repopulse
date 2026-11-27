# Changelog

All notable changes to RepoPulse are documented here, one entry per implementation slice.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Implementation details of each slice are in
[`PRD/`](./PRD/); architecture and conventions are in [`docs/`](./docs/README.md).

## [Unreleased]

## [0.9.8.4] — 2026-11-27 — Covering indexes, session cookie cache, and query/pool audit

### Performance

- **Database covering & partial indexes (`@repopulse/db`)**: Added migrations `20261127153000_feed_covering_indexes` (covering `INCLUDE` partial indexes on non-draft `Release` rows and partial `OUTDATED` index on `DependencyUpdate`) and `20261127160000_audit_query_indexes` (Session/Verification `expiresAt` indexes, composite outbox `(createdAt, id)` index, and partial indexes for open PRs, pending backfills, and pending invites).
- **30-second Better Auth session cookie cache (`apps/web`)**: Enabled Better Auth signed `session.cookieCache` (`maxAge: 30` s) in `apps/web/src/lib/auth.ts` so consecutive requests skip live PostgreSQL session lookups within the 30-second window (same-browser logout clears the cache immediately), and aligned `account.update.after` with the transaction context.
- **Feed listing & database query audit fixes (`apps/web`)**: Added request-cached `getUserFeedContext` so `ReleaseFeedPage`, `getDashboardData`, `loadMoreReleasesAction`, and `markAllReadAction` run in parallel without per-row `Repository`/`UserSubscription`/`Tag` joins; aggregated dashboard unread counts in SQL (`$queryRaw` `GROUP BY` starting from `UserReleaseState`), replaced `loadTrackedRepositories` `distinct` commit scans with indexed `LATERAL` probes, added outer `publishedAt` bounds to `afterCursorWhere`, hoisted `repositoryId` in `buildFeedWhereForSubscriptions` and flattened `markNewerThanMine`, combined `getRepositoryActivity` `count` + `aggregate`, cached `isDepsEnabled` with 15 s TTL + generation guard, disabled automatic `<Link>` viewport prefetching (`prefetch={false}`) on dynamic dashboard links, split `ReaderContext` into list/drawer slices with memoized `ReleaseCard` and `TopNavbar` route watching, deferred `RelativeTime` `Intl.DateTimeFormat` formatting until hover/focus, and deferred background-tab SSE refreshes until the tab becomes visible.
- **Worker query & connection-pool fixes (`apps/worker`, `apps/deps-worker`)**: Eliminated unindexed `OR` in `repo-paths`, added `source` filter to `storeAndFanOut` tag lookups and two-seek O(log N) `newestBefore` in `repo-poll`, resolved `preloadedSubscribers` outside `$transaction` in `repo-tags` (preventing pool deadlocks), bounded backfill tag promotions with concurrency `4` + `select: { id: true }`, batched `storeNotificationIntents` via `createMany({ skipDuplicates: true })`, eliminated redundant manifest/update/user fetches in `deps-scan` and `deps-notify`, and wired `loadDepsEnabledCached` into the `deps-worker` outbox flusher.

## [0.9.8.3] — 2026-11-27 — End-to-end performance optimization

### Performance

- **Database & `@repopulse/db`**: Added migration `20261127143000_performance_indexes` enabling `pg_trgm` GIN trigram indexes (`Repository.fullName`, `Release.tagName`, `Release.title`, `Release.bodyMarkdown`, `Tag.name`), case-insensitive `LOWER("fullName")` indexes on `Repository` and `DependencyProject`, and a partial unread index on `UserReleaseState`. Added `createCachedLoader` (`DEFAULT_SETTINGS_CACHE_TTL_MS = 15_000`) for single-flight TTL caching of instance settings in workers.
- **`@repopulse/github` & `@repopulse/deps`**: Added conditional `onEtag` reporting in `fetchCommitsForPath`, single-parse `prepareLockfile` shared across workspace manifests with an O(1) fallback index in `yarn-lock`, concurrent `/simple/` + `/pypi/<name>/json` fetching in the PyPI client, and removed duplicate JSON parsing of cached npm `time` documents.
- **Web (`apps/web`)**: Removed the redundant `User` database query in `getCurrentUserOrThrow` (lazy-loading encrypted GitHub tokens only at GitHub call sites), flattened feed/dashboard/unread queries via subscription-derived `repositoryId` buckets (`visibleReleasesWhereForSubscriptions` / `buildFeedWhereForSubscriptions`), combined `/dependencies` page queries (`getDependenciesListData`), replaced full-page RSC drawer navigation/mark-read revalidation with `getReleaseDrawerAction` + shallow `window.history.pushState` + optimistic `UnreadProvider`, added 400 ms trailing debounce on `SseListener` refreshes, deferred filter updates and cached date formatters, and enabled `content-visibility: auto` on feed cards and outdated dependency rows.
- **Release Worker (`apps/worker`)**: Parallelized tag comparisons and path commit/detail fetches with bounded concurrency (`4`), added 7-day Redis conditional ETag caching (`repo:path-etag:...`) for path polling, ran tag and path polling concurrently with shared subscriber loading and batched DB updates, and wrapped SMTP/backfill settings loaders in 15 s TTL caches.
- **Dependencies Worker (`apps/deps-worker`)**: Added Redis snapshot tree caching (`deps:tree:...`, 24 h TTL) with `knownCommitSha` short-circuiting, batched Redis `MGET`/pipeline reads and writes in `BlobCache`, single-parse lockfile reuse per snapshot, parallelized manifest upserts and chunked `DependencyUpdate` batches, bounded concurrency (`4`) for open PR status refreshes, and 15 s TTL caching for module/GitHub App/SMTP settings loaders.

## [0.9.8.2] — 2026-11-27 — SMTP transport cache & docs slugifier cleanup

### Fixed

- **SMTP transport cache (`packages/notifications`)**: Replaced SHA-256 hashing of SMTP credentials in `createSmtpSender` with direct field comparison (`sameSmtpTransportConfig`) on a single cached transport.
- **Docs heading slugifier (`scripts/check-docs.mjs`)**: Replaced regex HTML tag stripping in `slugifyHeading` with iterative `stripInlineHtmlTags`.

## [0.9.8.1] — 2026-11-27 — Docs hierarchy, AGENTS.md, and dependency updates

### Added

- **Per-workspace `AGENTS.md` files**: Added atomic `AGENTS.md` guides for `apps/{worker,deps-worker,deps-sandbox}` and `packages/{db,deps,github,notifications,queue}`, expanded root [`AGENTS.md`](./AGENTS.md) into a reference router, and refined [`apps/web/AGENTS.md`](./apps/web/AGENTS.md) while preserving the Next.js rules block.
- **Documentation validation (`pnpm docs:check`)**: Added `scripts/check-docs.mjs` and wired it into `.github/workflows/ci.yml` to verify relative Markdown links and heading anchors, `AGENTS.md` line budgets and timeless hygiene, and per-workspace doc/agent coverage.

### Changed

- **Reorganized `docs/` hierarchy**: Restructured documentation into [`docs/README.md`](./docs/README.md), [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md), [`docs/CONTRACTS.md`](./docs/CONTRACTS.md), [`docs/CODING_STANDARDS.md`](./docs/CODING_STANDARDS.md), `docs/apps/`, `docs/packages/`, `docs/guides/`, and `docs/operations/`.
- Updated dependencies in `apps/web`:
  - `lucide-react` 1.81.0 → 1.82.0
  - `postcss` 8.5.33 → 8.5.34

## [0.9.8.0] — 2026-11-27 — Better Auth, Oxlint/Oxfmt, ESM, Vitest 5 & resilience

### Added

- **CI verification workflow**: Added `.github/workflows/ci.yml` running `packages/*` build, `typecheck`, `lint`, `format:check`, `test`, and `@repopulse/web` build on pushes to `main` and pull requests (Node 26).
- **Web resilience & streaming UI**: Added `global-error.tsx`, root `not-found.tsx`, `(dashboard)/error.tsx`, route `loading.tsx` skeletons, and `<Suspense>` boundaries around secondary repository/dependency detail queries.
- **Security headers & proxy**: Added `apps/web/src/proxy.ts` generating per-request nonces and strict `Content-Security-Policy` headers.
- **Structured logging**: Added `pino` (`10.4.0`, with `pino-pretty` in dev TTY) via `createLogger` in `@repopulse/queue` and `apps/deps-sandbox`, emitting JSON logs with `service`, `queue`, `jobId`, `repositoryId`, and `projectId` context.
- **Database migrations & indexes**:
  - `20261127090000_audit_indexes`: Added missing Postgres indexes on `NotificationRule`, `UserSubscription(repositoryId)`, `Release(publishedAt DESC, id DESC)` and `(repositoryId, source, publishedAt DESC)`, `DependencyUpdate(projectId, status, level)`, and foreign-key relations (`UserReleaseState`, `SubscriptionTag`, `DependencyProject`, `DependencyNotificationOutbox`, `Invite`).
  - `20261127100000_better_auth`: Added `User.emailVerified`, `Session`, `Account` (with backfill for existing GitHub users), and `Verification` tables for Better Auth.
- **Test coverage & Vitest projects**: Consolidated Vitest 5 into root `vitest.config.ts` (`test.projects`) with `@vitest/coverage-v8` (`pnpm test:coverage`) and `unstubEnvs`/`restoreMocks` defaults.

### Changed

- **Auth migration (`next-auth` → `better-auth@1.7.28`)**: Replaced Auth.js v5 beta with Better Auth using Prisma database sessions, catch-all route `apps/web/src/app/api/auth/[...all]/route.ts`, `AsyncLocalStorage` transaction-scoped atomic first-user super-admin bootstrap and single-use invite admission (`admitNewGitHubUser`), and encrypted `User.githubAccessTokenEncrypted` without storing plaintext OAuth tokens in `Account`.
- **Client bundle optimization**: Split Zod schemas into server-only `*-schema.ts` modules out of 5 client-imported `lib/*` modules, removing ~106 KB of Zod 4 runtime from dashboard client chunks.
- **Next.js 16 & React 19**: Enabled `reactCompiler: true` (`babel-plugin-react-compiler@1.0.0`) and `typedRoutes: true`, replaced mount `setState`-in-`useEffect` and render `Date.now()` with `useSyncExternalStore`, added `useFormStatus` pending states and `useEffectEvent`, and unified canonical `lucide-react` icon names.
- **BullMQ 6 & SSE scaling**: Migrated `repo-poll`, `release-backfill`, `deps-scan`, and `deps-update` queues from custom `jobId` to native `deduplication: { keepLastIfActive: true }` with bounded log/job retention; wired `worker.cancelAllJobs("shutdown")` and `deps-sandbox` client-disconnect abort; multiplexed SSE Redis Pub/Sub over one shared subscriber per web process; raised `lockDuration` on heavy deps workers; and extracted shared health/rate-limit helpers into `@repopulse/queue`.
- **GitHub, Email & Registry clients**: Enabled `@octokit/plugin-retry`, bounded `createAppOctokit` LRU caching, GraphQL batched `readBlobs`, `knownCommitSha` skip in `fetchGitTree`, `etag`/`since` support in `fetchCommitsForPath`, Nodemailer `pool: true` + `TLSv1.2` + `verifySmtpConfig()`/`closeSmtpTransports()`, and registry fetch timeouts, byte caps, body cancellation, and single-flight deduplication.
- **Monorepo ESM, TypeScript 7 & Tooling**: Upgraded `tsconfig` targets to `ES2024` + `ES2025.Collection`, `jsx: "react-jsx"`, `verbatimModuleSyntax`, `noUncheckedSideEffectImports`, `erasableSyntaxOnly`; unified `@repopulse/db` (`moduleFormat = "esm"`) and all Node apps on native ESM; added `pnpm-workspace.yaml` `catalog:` + `trustPolicy: no-downgrade`; fixed `turbo.json` `db:generate` caching, `test` `^build`, and `apps/worker`/`deps-worker`/`deps-sandbox` test typechecking; modernized `scripts/*.mjs` with `import.meta.dirname`, `util.parseArgs`, `Object.groupBy`, and fetch timeouts; and migrated linting/formatting from ESLint + TS 6 shim to **Oxlint `--type-aware` (`oxlint-tsgolint`) + `oxfmt`**.
- **Docker & Coolify**: Added BuildKit cache mounts, tightened `.dockerignore`, slimmed the `migrator` stage, stripped source/test files from runtime worker/sandbox images, and added healthchecks for `web`, `worker`, `deps-worker`, and `deps-egress`.

### Fixed

- **Dark mode on auth pages**: Replaced hardcoded light-mode inline hex styles on `/login` and `/invite/[token]` with Tailwind v4 semantic tokens, and updated `outline-none` → `outline-hidden` and Tailwind v4 utility syntax across `apps/web`.
- **Security & correctness**: Disabled HTTP keep-alive socket reuse (`agent: false`) and destroyed oversized webhook responses in `postWebhook`; expanded SSRF IPv4/IPv6 blocklists (NAT64, 6to4, Teredo, TEST-NETs); fixed inline-code/Slack/email/ntfy escaping bugs; unified GitHub `403` secondary rate-limit (`retry-after`) handling across `poller.ts`/`tags.ts`; prevented `rethrowAppError` from misclassifying network/timeout errors as invalid keys; enabled Prisma 7 global `omit` on encrypted columns + `PrismaPg` timeouts/error hooks; and zeroized derived AES keys in `crypto.ts`.

## [0.9.7.8] — 2026-11-26 — Dependency updates

### Changed

- Updated dependencies across workspace packages:
  - `@types/node` 26.6.10 → 26.6.11 (`apps/deps-sandbox`, `apps/deps-worker`, `apps/web`, `apps/worker`, `packages/db`, `packages/deps`, `packages/github`, `packages/notifications`, `packages/queue`)
  - `@types/react` 19.3.1 → 19.3.3 (`apps/web`)
  - `lucide-react` 1.80.0 → 1.81.0 (`apps/web`)
  - `vitest` 5.1.1 → 5.1.2 (`apps/deps-sandbox`, `apps/deps-worker`, `apps/web`, `apps/worker`, `packages/db`, `packages/deps`, `packages/github`, `packages/notifications`, `packages/queue`)

## [0.9.7.7] — 2026-11-25 — MIT License

### Added

- Added the MIT License (`LICENSE`, root `package.json`, and `README.md`).

## [0.9.7.6] — 2026-11-25 — Dependency and sandbox updates

### Changed

- Updated dependencies across workspace packages:
  - `@types/node` 26.6.6 → 26.6.10 (`apps/deps-sandbox`, `apps/deps-worker`, `apps/web`, `apps/worker`, `packages/db`, `packages/deps`, `packages/github`, `packages/notifications`, `packages/queue`)
  - `@types/react` 19.3.0 → 19.3.1 (`apps/web`)
  - `lucide-react` 1.79.0 → 1.80.0 (`apps/web`)
- Updated `deps-sandbox` container runtime tool pin (`apps/deps-sandbox/Dockerfile`):
  - `uv` 0.13.9 → 0.13.10

## [0.9.7.5] — 2026-11-24 — Dependency and sandbox updates

### Changed

- Updated dependencies and pinned builder tools across workspace packages and Dockerfiles:
  - `bullmq` 6.7.8 → 6.7.10 (`apps/deps-worker`, `apps/web`, `apps/worker`, `packages/queue`)
  - `ioredis` 6.0.0 → 6.1.0 (`apps/deps-worker`, `apps/web`, `apps/worker`, `packages/queue`)
  - `lucide-react` 1.77.0 → 1.79.0 (`apps/web`)
  - `pnpm` 12.21.0 → 12.23.0 (`package.json` `packageManager`, Dockerfile builder stages)
  - `typescript-eslint` 8.73.0 → 8.74.0 (root `package.json`)
- Updated `deps-sandbox` container runtime tool pin (`apps/deps-sandbox/Dockerfile`):
  - `pnpm` 12.21.0 → 12.23.0

## [0.9.7.4] — 2026-11-22 — Dependency and sandbox updates

### Changed

- Updated `deps-sandbox` container runtime tool pin:
  - `poetry` 2.5.1 → 2.5.2
- Updated transitive dependencies across workspace in `pnpm-lock.yaml`.

## [0.9.7.3] — 2026-11-21 — Override transitive effect to fix GHSA-7589-6fvf-x4pw

### Fixed

- Overrode transitive `effect` to `3.22.5` in `pnpm-workspace.yaml` to resolve high-severity ReDoS advisory GHSA-7589-6fvf-x4pw (`@prisma/config` 7.10.1 pinned `3.20.0`).

## [0.9.7.2] — 2026-11-21 — UI fixes, version release link, and dependency updates

### Changed

- Linked the RepoPulse version label in the sidebar and admin overview to its corresponding GitHub release page (`apps/web`).
- Updated `nodemailer` from `10.6.0` to `10.6.1` (`packages/notifications`).

### Fixed

- Prevented URL-synced search inputs (feed navbar search, `/repositories` toolbar, `/dependencies` toolbar) from dropping characters when typing while an earlier debounced navigation is still in flight.

## [0.9.7.1] — 2026-11-20 — PostgreSQL 19 and dependency updates

### Changed

- Upgraded PostgreSQL from `18-alpine3.23` to `19-alpine3.24` (`deploy/postgres/Dockerfile`):
  - Bundled PG 16 and PG 18 binaries and updated `deploy/postgres/docker-entrypoint-upgrade.sh` so both existing PG 16 and PG 18 volumes upgrade automatically in-place via `pg_upgrade` (copy mode) on first boot while keeping the original cluster at `/var/lib/postgresql/16-pre-upgrade` or `/var/lib/postgresql/18-pre-upgrade` as a backup.
- Updated dependencies across workspace packages to their latest releases:
  - `lucide-react` 1.76.0 → 1.77.0 (`apps/web`)
  - `tailwind-merge` 3.7.0 → 3.7.1 (`apps/web`)

## [0.9.7] — 2026-11-19 — PostgreSQL 18, Redis 8, and dependency updates

### Changed

- Upgraded PostgreSQL from `16-alpine` to `18-alpine3.23` (`deploy/postgres/Dockerfile`) and updated the Docker volume mount from `/var/lib/postgresql/data` to `/var/lib/postgresql` in `docker-compose.coolify.yml` and `docker-compose.dev.yml`:
  - Bundled PG 16 binaries and an automatic upgrade entrypoint (`deploy/postgres/docker-entrypoint-upgrade.sh`) so existing PG 16 volumes upgrade automatically in-place via `pg_upgrade` (copy mode) on first boot while keeping the original cluster at `/var/lib/postgresql/16-pre-upgrade` as a backup.
- Upgraded Redis from `redis:7-alpine` to `redis:8-alpine` in `docker-compose.coolify.yml` and `docker-compose.dev.yml`.
- Updated dependencies across workspace packages to their latest releases:
  - `bullmq` 6.7.7 → 6.7.8 (`apps/deps-worker`, `apps/web`, `apps/worker`, `packages/queue`)
  - `lucide-react` 1.75.0 → 1.76.0 (`apps/web`)
- Updated `deps-sandbox` container runtime tool pin:
  - `bun` 1.4.4 → 1.4.5

## [0.9.6.2] — 2026-11-18 — Dependency updates and update check script improvements

### Changed

- Updated dependencies and pinned builder tools to their latest releases:
  - `pnpm` 12.16.1 → 12.21.0 (`package.json` `packageManager`, Dockerfile builder stages)
  - `turbo` 2.11.12 → 2.11.13 (`package.json`, Dockerfile builder stages)
- Extended `scripts/check-updates.mjs` to also check `optionalDependencies`, root `packageManager`, and `npm install -g` pins in `apps/*/Dockerfile` and `deploy/*/Dockerfile`.

## [0.9.6.1] — 2026-11-18 — Dependency and sandbox runtime updates

### Changed
- Updated dependencies across workspace packages to their latest releases:
  - `turbo` 2.11.11 → 2.11.12 (`package.json`, Dockerfile builder stages)
  - `lucide-react` 1.74.0 → 1.75.0 (`apps/web`)
  - `vitest` 5.1.0 → 5.1.1 across workspace packages
- Updated `deps-sandbox` container runtime tool pins:
  - `npm` 12.2.2 → 12.2.3
  - `uv` 0.13.8 → 0.13.9

## [0.9.6] — 2026-11-17 — CodeQL security fixes and dependency updates

### Changed
- Updated dependencies across workspace packages to their latest releases:
  - `bullmq` 6.7.6 → 6.7.7 (`apps/deps-worker`, `apps/web`, `apps/worker`, `packages/queue`)
  - `lucide-react` 1.73.0 → 1.74.0 (`apps/web`)
- Updated `deps-sandbox` container runtime tool pin:
  - `pnpm` 12.18.0 → 12.21.0

### Fixed

- Hardening across `@repopulse/deps`, `@repopulse/github`, `@repopulse/notifications`, and `@repopulse/web` by replacing polynomial trailing-character and overlapping regexes with linear string trimming, running HTML comment/tag stripping in `cleanMarkdown` to a fixed point without regexes, and extracting repository display names without an unanchored hostname regex.

## [0.9.5.5] — 2026-11-16 — Dependency updates across workspace packages

### Changed

- Updated dependencies across workspace packages to their latest releases:
  - `typescript-eslint` 8.72.2 → 8.73.0 (`package.json`)
  - `nodemailer` 10.5.0 → 10.6.0 (`packages/notifications`)

## [0.9.5.4] — 2026-11-14 — Dependency updates across workspace packages

### Changed

- Updated dependencies across workspace packages to their latest releases:
  - `eslint` 10.14.0 → 10.15.0 (`package.json`)
  - `lucide-react` 1.72.0 → 1.73.0 (`apps/web`)
  - `postcss` 8.5.32 → 8.5.33 (`apps/web`)
  - Updated builder image stages to `turbo@2.11.11` across Dockerfiles (`apps/deps-sandbox/Dockerfile`, `apps/deps-worker/Dockerfile`, `apps/web/Dockerfile`, `apps/worker/Dockerfile`)

## [0.9.5.3] — 2026-11-13 — Sandbox runtime updates and check script

### Added

- Added `scripts/check-sandbox-updates.mjs` and `pnpm deps:sandbox:check` script to check pinned `deps-sandbox` runtime versions (`npm`, `pnpm`, `bun`, `poetry`, `uv`) against upstream registries and releases.

### Changed

- Updated `deps-sandbox` container runtime tool pins to their latest releases:
  - `pnpm` 12.16.1 → 12.18.0
  - `uv` 0.13.7 → 0.13.8 (with updated AMD64 and ARM64 sha256 checksums)

## [0.9.5.2] — 2026-11-13 — Dependency PR actions, pnpm 12 lockfile fixes, and dependency updates

### Added

- Added a "Create PR" / "Update PR" action (with a multi-group PR chooser and batch action when multiple groups are planned) directly on project rows in the `/dependencies` window next to "Check now".

### Fixed

- Support pnpm 11/12 multi-document `pnpm-lock.yaml` files (with `packageManagerDependencies` / `configDependencies` boot documents) when scanning projects and validating regenerated lockfiles.
- Avoid caching failed lockfile parses in Redis and bump the lockfile-read cache key so previously failed scans recover immediately on re-check.
- Set `pnpm_config_pm_on_fail` and `pnpm_config_ignore_scripts` in `deps-sandbox` for pnpm 12 compatibility without downloading external pnpm binaries or stripping existing `packageManagerDependencies` sections.

### Changed

- Updated dependencies across workspace packages to their latest releases:
  - `bullmq` 6.7.3 → 6.7.6 (`apps/web`, `apps/deps-worker`, `apps/worker`, `packages/queue`)
  - `lucide-react` 1.71.0 → 1.72.0 (`apps/web`)

## [0.9.5.1] — 2026-11-10 — Dependency updates across workspace packages

### Added

- Added `scripts/check-updates.mjs` and `pnpm deps:check` script to scan all monorepo dependencies against the npm registry.

### Changed

- Updated dependencies across workspace packages to their latest releases:
  - `bullmq` 6.7.2 → 6.7.3 (`apps/web`, `apps/deps-worker`, `apps/worker`, `packages/queue`)
  - `lucide-react` 1.70.0 → 1.71.0 (`apps/web`)
  - `next` 16.4.5 → 16.4.6 (`apps/web`)
  - `nodemailer` 10.4.0 → 10.5.0 (`packages/notifications`)

## [0.9.5] — 2026-11-05 — Security hardening and vulnerability mitigations

### Security

- Harden custom registry and index detection in `deps-sandbox` (`bunfig.toml` scoped tables, `pnpm-workspace.yaml` scoped/quoted registry keys, `uv.toml`/`pyproject.toml` `default-index`, `[sources]`, underscore keys, and multi-URL lists).
- Separate Python registry policy families (`pyproject.toml`/`uv.toml` vs `pip.conf`/`pip.ini`) and prevent public default index overrides from clearing private default index policies in `@repopulse/deps`.
- Bound YAML alias expansion (`maxAliasCount`) when parsing `pnpm-lock.yaml`, Berry `yarn.lock`, and `pnpm-workspace.yaml`.
- Eliminate superlinear regex backtracking in `workspaceGlobToRegExp` / `matchesWorkspaceGlobs` for untrusted workspace globs.
- Reject backslash-prefixed and non-local `callbackUrl` values on `/login` (`safeCallbackUrl`), and add baseline security headers in `next.config.ts`.
- Re-resolve collaborator login from immutable `githubId` whenever permission checks fail (not only on HTTP 404).

## [0.9.4.3] — 2026-11-05 — Release history candidates and GitHub API quota display

### Added

- **Release history candidate repositories and missing count:** In Admin → Release history ("Apply to existing repositories"), listed tracked repositories that have older releases remaining on GitHub, showing their stored releases count, oldest stored release tag and date, and how many releases are missing to reach the automatic target.
- **GitHub API quota card:** Added a dedicated card in Admin → Release history displaying live remaining quota, hourly limit, requests used, reset time (with countdown), status relative to the minimum quota threshold (`minQuota`), and a refresh button.

## [0.9.4.2] — 2026-11-05 — Comprehensive test suite expansion and hardening

### Added

- Expanded unit and integration test coverage across all workspace packages and services (`apps/web`, `apps/worker`, `apps/deps-worker`, `apps/deps-sandbox`, `packages/deps`, `packages/github`, `packages/notifications`, `packages/queue`, and `packages/db`).
- Added tests for route handlers, server actions, processors, registry caches, rate limiters, sandbox execution guards, and edge cases.

## [0.9.4.1] — 2026-11-05 — Dependency updates and sandbox runtimes bump

### Changed

- Updated dependencies across workspace packages to their latest releases:
  - `bullmq` 6.5.4 → 6.7.0 (`apps/web`, `apps/deps-worker`, `apps/worker`, `packages/queue`)
  - `lucide-react` 1.67.0 → 1.69.0 (`apps/web`)
- Updated `deps-sandbox` container runtime tool pins to their latest releases:
  - `npm` 12.2.1 → 12.2.2
  - `pnpm` 12.14.0 → 12.16.1 (aligned with monorepo base and `packageManager`)
  - `Bun` 1.4.3 → 1.4.4
  - `uv` 0.13.1 → 0.13.7 (with updated AMD64 and ARM64 sha256 checksums)

## [0.9.4] — 2026-11-03 — Security and reliability fixes

**Upgrade notes**

- Two new migrations, applied by the migrator on deploy: `20261103130000_dependency_branch_write_intents`
  and `20261103131000_dependency_notification_outbox`. No environment changes.

### Security

- Serialize first-account registration so concurrent sign-ins cannot create multiple super admins.
- Mark dependencies using custom registries or repository sources unsupported before public registry lookups,
  including manifest-only update pull requests.

### Fixed

- Recover dependency update pull requests after a failure between pushing the bot branch and saving its state,
  while preserving protection for human edits.
- Recheck automatic/manual mode and PR slots when queued dependency update jobs execute.
- Retain dependency digest notification intents in a transactional outbox and retry enqueueing after Redis failures.
- Select the latest visible release before limiting repository summaries, so tags and excluded prereleases cannot
  hide stable releases or distort activity sorting.
- Preserve search text and current filters when a pending debounced search overlaps sort or filter changes.

### Changed

- Run actual ESLint checks in workspace lint tasks instead of completing without linting any source files.

## [0.9.3] — 2026-11-03 — Coolify-generated sandbox token

**Upgrade notes**

- Nothing to set: Coolify now generates the sandbox token on deploy. A `DEPS_SANDBOX_TOKEN` you added in Coolify
  is no longer used by `docker-compose.coolify.yml` and can be removed.

### Fixed

- **"Sandbox unreachable" on Coolify**: the token was read from `${DEPS_SANDBOX_TOKEN}`, which Coolify only writes to
  the runtime `.env` once someone sets it, so `deps-sandbox` restarted in a loop and lockfile pull requests stayed
  disabled. `deps-worker` and `deps-sandbox` now get it from the Coolify magic variable
  `SERVICE_PASSWORD_64_DEPSSANDBOX`, generated and stored by Coolify (the same value for both). `.env.example`,
  `env:setup` and `env:sync` set it to `${DEPS_SANDBOX_TOKEN}` for local compose.

## [0.9.2] — 2026-11-03 — Sandbox environment isolation on Coolify

**Upgrade notes**

- Set `DEPS_SANDBOX_TOKEN` in Coolify (Environment Variables, `openssl rand -hex 32`) and redeploy if Admin →
  Dependencies shows "Sandbox unreachable": without it `deps-sandbox` refuses to start.

### Security

- **`deps-sandbox` no longer sees the app's secrets on Coolify.** Coolify adds the application's whole `.env` to every
  compose service, so the sandbox container started with the database, Redis, auth and encryption secrets in its
  environment, readable by the package managers it runs. Its entrypoint now re-executes with an allowlisted
  environment (`env -i`) before `tini` and the server start, and the healthcheck runs through `env -i` as well.

## [0.9.1] — 2026-11-03 — Coolify deploy fix for deps-egress

### Fixed

- **Coolify deploy of `deps-egress`**: the container failed to start ("Are you trying to mount a directory onto a
  file") because Coolify keeps no repository files on the host, so the `squid.conf` bind mount had an empty directory
  as its source. `squid.conf` is now baked into a small image built from the pinned Squid image
  (`deploy/deps-egress/Dockerfile`).

## [0.9.0] — 2026-11-03 — Dependencies

**Upgrade notes**

- Two migrations (`20261103090000_dependency_projects`, `20261103100000_github_app`), applied by the migrator on
  deploy. Existing notification rules get `events = [RELEASES]` and keep sending releases only.
- Three new services in `docker-compose.coolify.yml`: `deps-worker`, `deps-sandbox` and `deps-egress`, plus the
  internal `deps_sandbox` network. After the first deploy, check that Coolify kept the network internal
  ([docs/operations/deployment.md](./docs/operations/deployment.md#dependencies-services-network-and-hardening); the fallback is a host
  firewall rule).
- Set **`DEPS_SANDBOX_TOKEN`** in Coolify (`openssl rand -hex 32`): `deps-sandbox` does not start without it.
  Optional: `DEPS_SANDBOX_URL`, `DEPS_SCAN_CRON`, `DEPS_SCAN_CONCURRENCY`, `DEPS_UPDATE_CONCURRENCY`,
  `DEPS_HEALTH_PORT`, `DEPS_SANDBOX_TIMEOUT_MS`. `pnpm env:sync` adds them to an existing `.env` (with a generated
  token).
- **The Dependencies module is off until the super admin enables it in Admin → Dependencies.** Private repositories
  and update pull requests also need the RepoPulse GitHub App (Admin → GitHub App).

### Added

- **Dependencies: projects and checks** (Part A). A new **Dependencies** page lists your own repositories ("projects"),
  separate from tracked repositories: add them from your tracked repositories (up to 20 at once), by URL, or from a
  repository's settings page. A new `deps-worker` service detects `package.json`, `pyproject.toml` and
  `requirements*.txt` manifests (npm, pnpm, Bun, Yarn, pip, pip-tools, uv, Poetry, workspaces included), reads the
  current versions from lockfiles, checks the npm registry and PyPI, and lists what is outdated, with level, release
  date and changelog links. Per-project policy: notify only / PR on request / automatic PRs, highest update level,
  pre-releases, minimum release age (3 days by default), grouping, range strategy, PR limit, check interval,
  notification level, manifest paths, commit prefix and ignore rules. Deprecated and yanked versions are never
  suggested. Live updates over SSE, a sidebar badge with the number of projects that have outdated dependencies, and
  "Check now".
- **Dependency notifications**: a digest after each check that found new target versions (each version is announced
  once; up to 25 per message), and pull request notices (opened, updated, edited by someone else, access lost), over
  Discord, Slack, ntfy, Gotify, email and custom webhooks (`dependencies.outdated` / `dependencies.pull_request`).
- **GitHub App** (Part B): Admin → GitHub App creates a RepoPulse GitHub App in one click (manifest flow, for your
  account or an organization) or takes an existing one. Users install it on their repositories to check private
  repositories and to get update pull requests. RepoPulse always checks your own permission on the repository.
- **Update pull requests** (Parts C and D): "Create PR" (or automatic PRs) bumps the manifests, regenerates
  `package-lock.json`, `pnpm-lock.yaml`, `bun.lock`, `uv.lock` or `poetry.lock`, and opens one pull request per group
  from a `repopulse/deps/…` branch, authored by the App's bot. Hashed `requirements.txt` files get the new hashes.
  Lockfiles are regenerated by the new `deps-sandbox` service, which has no secrets and reaches only the npm and PyPI
  registries through the `deps-egress` allowlist proxy, with install scripts disabled. Closed PRs dismiss their
  versions until a newer one appears; a branch someone else pushed to is left alone. Yarn, `bun.lockb` and pip-tools
  are check only.
- **GitHub App webhooks** (Part E, optional): Admin → GitHub App → "Enable webhooks" points the App at
  `/api/github-app/webhook`, so pushes that change dependency files and closed update PRs trigger a check right away.
  Scheduled checks remain the fallback.
- **Admin → Dependencies**: turn the module on or off, see whether `deps-worker` runs, the sandbox's tool versions and
  instance-wide counts.

### Changed

- **Notification rules choose their events**: Releases, Dependency updates and Dependency pull requests. Existing
  rules cover releases only; edit a rule's events from Settings → Notifications. A rule limited to a tag can only
  notify about releases.
- Your GitHub login is now stored at sign-in (used for the GitHub App permission checks).

## [0.8.0] — 2026-11-02 — Repository settings page

**Upgrade notes**

- One migration (`20261102120000_subscription_settings`), applied by the migrator on deploy. Existing subscriptions
  get the defaults (not pinned, no note, notification level "All updates", not snoozed, no version).

### Added

- **Repository settings page** (`/repositories/<owner>/<name>`): every setting of a tracked repository in one place,
  with a header (sync, open in feed, pin), tracking, tags, notifications & feed, release history and a danger zone.
  The URL is case-insensitive and redirects to the canonical casing; a repository you don't track shows a "Not
  tracked" page with an Add button prefilled with it.
- **Activity grid**: a GitHub-style heatmap of the repository's updates in your feed over the last 53 weeks, bucketed by
  your local day, with major-release markers, a source filter (releases / tags / commits), tooltips, click-to-read,
  and stats (updates in the last 12 months, last update, typical gap between releases, busiest month, weekly streak).
- **Search, sort and filters on Tracked repositories**: search by name, description, note, tags or watched paths;
  sort by name, date added, latest update, last synced, unread or stars; filter by tag and by Pinned / Unread /
  Files / folders / Sync failed. Everything is kept in the URL, and the settings page's back link returns to it.
- **Pin to top**: pinned repositories sort first on Tracked repositories, whatever the sort.
- **Personal note** per repository, shown on the settings page and as a one-line hint on the card, and searchable.
- **Notification level** per repository: All updates, Minor and major, Major releases only, or Feed only. Applied
  before your notification rules; the feed and unread count always update. Commits count as "other" updates.
- **Snooze notifications** of a repository for 1 day, 1 week, 1 month or until a date. The card shows "Snoozed
  until …"; nothing is sent afterwards for what happened meanwhile.
- **My version**: set the version you run (on the settings page, or "Set as my version" in the reader). Cards and the
  settings page show "N releases behind · M major", and feed cards of newer releases are marked "Newer than yours".

### Changed

- The tracking controls (release mode select, "Files / folders" popover) moved from the repository cards to the
  settings page, where the path editor is shown inline. Cards show a read-only tracking summary that links to it, and
  their title now opens the settings page (a new feed icon opens the repository in the feed).
- **Include pre-releases** can now be changed after adding a repository. Turning it on marks the stored pre-releases
  among the 10 newest updates as unread; turning it off removes unread pre-releases from the feed and the counters.
- Updated dependencies to their latest stable releases:
  - `next` 16.4.3 → 16.4.4 (`apps/web`)
  - `semver` 7.8.5 → 7.8.6 (`packages/github`)
  - `vitest` 5.0.5 → 5.1.0 (`apps/web`, `apps/worker`, `packages/{db,github,notifications,queue}`)
  - Switched `apps/web/vitest.config.ts` JSX configuration to `oxc: { jsx: { runtime: "automatic" } }` for compatibility with Vitest 5.1.0 and Vite 8 Oxc transformation.

## [0.7.1] — 2026-11-01 — Admin panel

**Upgrade notes**

- One migration (`20261101230000_backfill_settings`), applied by the migrator on deploy.
- The `web` service now also receives `RELEASE_BACKFILL_DEFAULT_TARGET`, `RELEASE_BACKFILL_MAX_AGE_DAYS` and
  `RELEASE_BACKFILL_MIN_QUOTA` (`docker-compose.coolify.yml`), so the admin panel shows the values the worker uses.
- `/settings/access` and `/settings/email` moved to `/admin/access` and `/admin/email`; the old URLs redirect.

### Added

- **Admin panel** (`/admin`, super admin only): one place for every instance setting, with tabs for Overview, Access,
  Email (SMTP) and Release history. The overview shows members, tracked repositories and pending invites, plus the
  state of each section. The sidebar and the account menu now have a single **Admin** entry instead of the
  "Instance" links.
- **Release history settings** (Admin → Release history): the automatic import target and age limit, the
  "Load older releases" step and cooldown, the hard cap per repository and the minimum GitHub quota. Each field
  falls back to its `RELEASE_BACKFILL_*` environment variable (or the built-in default) when left empty, and
  changes apply to the worker's next import without a restart.
- **Re-run automatic import**: applies a raised target or age limit to repositories imported before the change.
  Imported history stays read and sends no notifications.

## [0.7.0] — 2026-11-01 — Releases and files / folders together

**Upgrade notes**

- One migration (`20261101210000_combined_tracking`), applied by the migrator on deploy. Existing "Files / folders"
  subscriptions keep tracking only their paths.

### Added

- **Track releases and files / folders at once.** "Files / folders" is no longer a separate mode: it can be combined
  with "Releases only" or "Releases + tags" on the same repository.
  - Add dialog: the three tracking cards are now checkboxes. "Releases only" and "Releases + tags" exclude each other,
    "Files / folders" combines with either, and at least one must be picked.
  - Repository cards: the select sets the release mode ("Releases", "Releases + tags" or "No releases"), and a
    separate **Files / folders** button turns path tracking on (opening the path editor). The editor has a
    **Stop watching paths** button. Choosing "No releases" without watched paths asks for paths first.

### Changed

- The sidebar section and the manage dialog are now called **Tags** (was "Categories / Tags" and "Categories & tags").

### Fixed

- Repository cards line up again: the description always takes two lines ("No description" when empty) and the
  details sit on fixed rows (stars, latest and unread / sync status / history / tracking mode) instead of wrapping to
  two to four lines depending on content. Long release tags are truncated, with the full tag on hover.

## [0.6.1] — 2026-11-01 — Theme switcher

**Upgrade notes**

- No migrations or environment changes. Redeploy to pick up the new images.

### Added

- **Theme switcher** in the account menu (avatar, top right): System / Light / Dark. "System" follows the OS setting
  as before. The choice is stored per browser in a `theme` cookie and applied while the page is server-rendered, so
  there is no flash of the wrong theme. Toasts follow the selected theme too.
- **File and folder picker** for "Files / folders" tracking, in the add dialog and in the watched paths popover of
  repository cards (click the paths next to the tracking mode to edit them on a tracked repository):
  - Autocomplete from the repository's default branch: type part of a path or file name, pick with ↑/↓ and Enter,
    Tab opens a folder to keep typing inside it. Matches are highlighted.
  - **Browse** opens a folder browser with breadcrumbs and checkboxes to tick files and folders.
  - Selected paths show as removable chips with a counter (up to 10). Adding a folder drops selected paths inside it,
    since the folder already covers them. Paths not on the default branch yet are flagged but still accepted.
  - Any valid path can still be typed or pasted (comma-separated), so very large repositories (only the 10,000
    shallowest entries are listed), private repositories without access or GitHub errors never block the form.
  - The tree costs two GitHub API requests per repository and is cached in the browser for 5 minutes.
- The app version (e.g. "RepoPulse v0.6.1") is shown at the bottom left of the sidebar. It comes from `version` in
  `apps/web/package.json`, inlined at build time.

## [0.6.0] — 2026-11-01 — Slice 06: file & folder change tracking

**Upgrade notes**

- Run the new migration `20261101180000_path_tracking` (the compose `migrator` service does this). It adds
  `TrackMode.PATHS`, `ReleaseSource.COMMIT`, `Repository.lastPathsPolledAt` / `polledPaths`, `Release.changedPaths`
  and `UserSubscription.watchedPaths`. No environment changes.

### Added

- **"Files / folders" tracking mode** (Slice 06) for repositories without releases or tags, and for monorepos where only
  some paths matter. Watch up to 10 repo-relative files or folders (e.g. `CHANGELOG.md, packages/cli`): every commit
  on the default branch that changes one of them becomes a feed entry with a **Commit** badge, titled with the commit
  subject and labeled with its short SHA. Its notes hold the full commit message, the author, the changed files with
  `+/-` line counts (watched files first, up to 50) and a link to the commit.
  - The add dialog has a 3-way "Tracking mode" selector (Releases only / Releases + tags / Files / folders) that
    replaces the "Also track Git tags" checkbox. Repository cards get the same selector plus a popover to edit the
    watched paths.
  - Users watching different paths of the same repository each see only commits touching their own paths.
    "Releases only" and "Releases + tags" subscribers never see commits, and "Files / folders" subscribers no longer
    receive GitHub Releases.
  - A newly watched path imports its 10 most recent commits as unread, quietly: no webhook or email notifications for
    existing history. Later commits notify like new releases.
  - Watched paths are polled once per repository and deduplicated across users (10 newest commits per path per poll,
    one detail request per new commit). Like tags, the path step is best effort: GitHub errors and rate limits are
    logged and retried at the next poll, and never fail release polling.
- Notifications for commits say "new commit" and link to the commit (Discord, Slack, email, ntfy, Gotify), and the
  custom webhook payload has `release.source = "COMMIT"`.

### Fixed

- Tag tracking compared new tags against the newest stored row of any source. It now ignores commit rows, which would
  otherwise push genuinely new tags into read history.

## [0.5.2] — 2026-11-01 — Security: postcss-selector-parser override

**Upgrade notes**

- No migrations or environment changes. Redeploy to pick up the new images.

### Security

- `postcss-selector-parser` is forced to 6.1.5 through `overrides` in `pnpm-workspace.yaml`, fixing
  [GHSA-rj75-hqrm-r3gf](https://github.com/advisories/GHSA-rj75-hqrm-r3gf) (quadratic selector parsing, CPU
  exhaustion). `@tailwindcss/typography` 0.5.20, its latest release, pins the affected 6.0.10. The parser only runs
  when the web CSS is built. Remove the override once a typography release depends on a fixed version.

## [0.5.1] — 2026-11-01 — Dependency updates

**Upgrade notes**

- No migrations or environment changes. Redeploy to pick up the new images.

### Changed

- Updated dependencies to their latest stable releases (versions stay pinned exactly):
  - `bullmq` 6.3.16 → 6.5.3 (`@repopulse/queue`, web, worker)
  - `nodemailer` 10.1.2 → 10.3.1 (`@repopulse/notifications`)
  - `lucide-react` 1.58.0 → 1.66.0 (web)
  - `postcss` 8.5.30 → 8.5.32 (web, dev)
- Prisma stays on 7.10.1: npm's `latest` tag for `prisma` points to the `8.0.0-rc.29` release candidate, and
  `@prisma/client` / `@prisma/adapter-pg` are still on 7.10.1.

## [0.5.0] — 2026-11-01 — Slice 05: notifications, tag tracking, history backfill, super admin & invites

**Upgrade notes**

- Run the migrations (the compose `migrator` service does this): `20261031120000_release_backfill`,
  `20261101090000_tag_tracking`, `20261101120000_invites_registration`, `20261101150000_super_admin_smtp_settings`.
- Email: the `SMTP_*` environment variables are gone. If you used email, re-enter the values in **Settings → Email**
  after deploying (see Removed).
- `SERVICE_FQDN_WEB` is replaced by `SERVICE_URL_WEB`, which includes the scheme. Coolify sets it automatically. For
  local compose, run `pnpm env:sync`, which adds it and lists the old keys you can delete.

### Added

- **Super admin and instance settings.**
  - Migration `20261101150000_super_admin_smtp_settings`: `User.isAdmin` is renamed to `User.isSuperAdmin`, and
    `InstanceSettings` gets `smtpHost`, `smtpPort`, `smtpSecure`, `smtpUser`, `smtpPasswordEncrypted` and `smtpFrom`.
  - The first account to sign up is the super admin; on existing installs it is the oldest account. The super admin
    manages every instance setting, under a new **Instance** group in the sidebar and the account menu.
  - Server actions check the role through one guard (`getSuperAdminOrThrow`) and return `FORBIDDEN` to anyone else.
    The pages use `requireSuperAdmin`, which shows a 404 to other members.
- **Settings → Email (SMTP)** (`/settings/email`, super admin only): the SMTP server is set up in the UI instead of
  environment variables.
  - Fields: host, port, encryption (automatic / implicit TLS / STARTTLS), optional username and password, and an
    optional sender (`Name <address>`).
  - The password is AES-256-GCM encrypted with `TOKEN_ENCRYPTION_KEY` and never sent back to the browser. Leave the
    field empty to keep the saved password.
  - **Send test email** delivers the sample `v1.0.0` release through the saved settings, to the super admin or another
    address. **Turn off email** removes the settings.
  - The worker reads the settings on every email job, so a change applies without a restart.
  - If the saved password can't be decrypted (for example after `TOKEN_ENCRYPTION_KEY` changed), the job fails without
    retries and says to re-enter the password.
  - In Settings → Notifications, the Email channel stays disabled until SMTP is set up. The super admin sees a link to
    Settings → Email; other members are told to ask the super admin.
- **Invite-only registration.**
  - Migration `20261101120000_invites_registration`: adds the admin flag on `User`, the single-row `InstanceSettings`
    (`publicRegistration`) and `Invite`.
  - **Settings → Access** (`/settings/access`, super admin only):
    - a **public registration** toggle. When it is off, new accounts need an invite; existing members can always sign in.
    - **invite links**: single-use, they expire after 1, 7 or 30 days and can be revoked. Only the token's SHA-256 is
      stored, so a link is shown once.
  - `/invite/<token>` checks the link, sets a short-lived httpOnly cookie and starts GitHub sign-in. The `signIn`
    callback (`admitGitHubUser`) claims the invite and creates the account in one transaction, so a link can't be used
    twice.
  - New sign-in errors on `/login`: `InviteRequired` and `InviteInvalid`.
- **Slice 05: notifications (Discord, Slack, ntfy, Gotify, email, custom webhooks).** Details: [`slice_05_implementation_summary.md`](./PRD/slice_05_implementation_summary.md)
  - New `@repopulse/notifications` package:
    - `dispatchNotification()` plus formatters for Discord embeds, Slack Block Kit, ntfy, Gotify, SMTP email (nodemailer
      10.1.2, HTML + text) and generic JSON webhooks.
    - SSRF guard: private and loopback addresses are blocked unless `ALLOW_INTERNAL_WEBHOOK_HOSTS` allows them. Cloud
      metadata addresses are always blocked. The address is checked again at connect time.
  - The `notification-dispatch` worker now delivers. It re-checks the rule (enabled, major-only, subscription, tag scope)
    and retries transient failures (3 attempts, exponential from 5 s). Permanent failures fail the job at once.
  - New page **Settings → Notifications** (`/settings/notifications`):
    - add rules with a channel, a tag scope and "only major releases";
    - enable/disable, delete, and **Send Test** (a synthetic `v1.0.0 - RepoPulse Test Release`);
    - destinations are shown masked.
  - Email uses the SMTP server from **Settings → Email** (see above).
  - New optional settings `ALLOW_INTERNAL_WEBHOOK_HOSTS` and `APP_BASE_URL`, on both `web` (for Send Test) and `worker`.
    Add them to existing env files with `pnpm env:sync`.
- **Slice 04c: tag tracking ("Releases + tags").** Details: [`slice_04c_implementation_summary.md`](./PRD/slice_04c_implementation_summary.md)
  - Migration `20261101090000_tag_tracking`: enum `ReleaseSource`, plus `Release.source` / `tagSha`. `githubReleaseId` is now optional,
    with a new unique key `(repositoryId, source, tagName)`. Also adds `Repository.lastTagsPolledAt`.
  - Each subscription chooses `RELEASES` or `TAGS_AND_COMMITS`: in the Add dialog, or with the "Tags" toggle on each repository card.
  - The `repo-poll` job also reads the newest 20 tags (GraphQL) while any subscriber tracks tags. Each tag without a GitHub Release is
    stored with "commits since the previous tag" (compare API) as its notes. New tags fan out only to tag-mode subscribers.
    The tag step is best effort and never breaks release polling.
  - When a tag later gets a GitHub Release, its row is promoted in place: one entry, no second notification for tag-mode users.
  - The feed and reader show a "Tag" badge on tag entries.
- **Slice 04b: release history backfill.** Details: [`slice_04b_implementation_summary.md`](./PRD/slice_04b_implementation_summary.md)
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

### Changed

- `@repopulse/notifications` no longer reads `SMTP_*` from the environment. `dispatchNotification()` takes the SMTP
  settings as an option (`smtp`), built with `toSmtpConfig()`. `readSmtpConfig()` and `isSmtpConfigured()` are replaced
  by `toSmtpConfig()`, `defaultSmtpFrom()` and the `StoredSmtpSettings` type.
- `@repopulse/db` exports `loadSmtpSettings()` (it decrypts the password), `SmtpPasswordUnreadableError`,
  `SMTP_SETTINGS_SELECT` and `INSTANCE_SETTINGS_ID`.
- When the SMTP settings change, the cached nodemailer transport is closed and a new one is created.
- `pnpm env:sync` now also lists settings that are no longer used (the old `SMTP_*` keys and `SERVICE_FQDN_WEB`). It
  only reports them and never deletes anything.

### Removed

- The `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_SECURE` and `SMTP_FROM` environment variables. They are
  gone from `.env.example`, `pnpm env:setup` and both services in `docker-compose.coolify.yml`. **Upgrading:** if you
  used email, re-enter the values in Settings → Email after deploying. Until then, email rules fail and are not retried.

### Fixed

- Deploy: `docker-compose.coolify.yml` sets `NEXTAUTH_URL` and `APP_BASE_URL` from `SERVICE_URL_WEB` instead of
  `SERVICE_FQDN_WEB`. Coolify 4.5 gives `SERVICE_FQDN_WEB` as a bare host without the scheme, which broke the
  sign-in callback URL and the links in notifications. `.env.example` and `pnpm env:setup` use `SERVICE_URL_WEB` too, and
  `pnpm env:sync` adds it to existing env files.
- The icons in select items stay on the same line as their labels.
- In the add-rule form, the Channel and Repositories fields are aligned to the top.

### Security

- Webhook destinations pass the SSRF guard twice: when a rule is created, and again inside the socket's DNS lookup on
  every delivery, so DNS rebinding can't slip past it. Private and loopback addresses need `ALLOW_INTERNAL_WEBHOOK_HOSTS`.
  Link-local and cloud metadata addresses are always blocked.
- Webhook URLs carry secrets, so they are masked everywhere they are shown or logged.
- The SMTP password is AES-256-GCM encrypted at rest and never sent to the browser. Invite tokens are stored only as
  SHA-256 hashes.
- Instance settings (registration, invites, SMTP) are super admin only, checked on the server in every action and page.
- "Send Test" and "Send test email" have a 10-second cooldown, so they can't be used to flood a channel or an inbox.

## [0.4.0] — 2026-10-31 — Slice 04: BullMQ worker, ETag polling & live SSE updates

Details: [`slice_04_implementation_summary.md`](./PRD/slice_04_implementation_summary.md)

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

Details: [`slice_03_implementation_summary.md`](./PRD/slice_03_implementation_summary.md)

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

Details: [`slice_02_implementation_summary.md`](./PRD/slice_02_implementation_summary.md)

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

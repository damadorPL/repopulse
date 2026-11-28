# Recipes

> **Summary:** step-by-step checklists for recurring changes. Each ends with verification (`pnpm verify`, which runs guardrails, manifests, packages build, typecheck, oxlint, stylelint, knip, knip:strict, format:check, react-doctor, tests, docs:check, and `@repopulse/web` build) and a `CHANGELOG.md` entry under `## [Unreleased]`.
>
> **Related Docs:** [../CODING_STANDARDS.md](../CODING_STANDARDS.md) · [../CONTRACTS.md](../CONTRACTS.md) · [../operations/development.md](../operations/development.md)

## Add a database column or model

1. Edit `packages/db/prisma/schema.prisma`. Add `///` doc comments on non-obvious fields.
2. `cd packages/db && npx prisma migrate dev --create-only --name <snake_name>`, or write `prisma/migrations/<YYYYMMDDHHMMSS>_<snake_name>/migration.sql` by hand. Renames use `RENAME COLUMN`; backfill existing rows in the same SQL when needed.
3. `npx prisma migrate deploy && npx prisma generate` (or root `pnpm db:migrate:deploy && pnpm db:generate`), rebuild `@repopulse/db` (`pnpm --filter @repopulse/db build`) so apps/workers consume the updated `dist/`, then verify the diff is empty:
   `npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script`.
4. Update the code and tests that mock the changed model.
5. Update [../packages/db.md](../packages/db.md) and mention the migration in `CHANGELOG.md`.

## Add a Server Action

1. Pick the area file in `apps/web/src/server/actions/` (or create `<area>.ts` starting with `"use server"`).
2. Follow the template in [../apps/web.md](../apps/web.md#action-template-and-rules): Zod input (prefer `z.strictObject`; shared or unit-tested schemas go in `lib/<area>-schema.ts`, while small action-only schemas may stay inline in the `"use server"` file), `getCurrentUserOrThrow()` / `getSuperAdminOrThrow()`, user-scoped queries, `revalidatePath`, `return ok(...)`, and `catch → toActionError(error, "<name>")`.
3. Shared constants go in `src/lib/<area>.ts`; server-only Zod schemas in `src/lib/<area>-schema.ts`; server-only helpers in `src/server/<area>.ts`.
4. Client: call it in `startTransition`, handle `result.ok`, toast, and `UNAUTHORIZED` → `/login`.
5. Test pure parts (schemas, helpers) with Vitest.

## Add an instance setting (super admin)

1. Add a column to `InstanceSettings` (with a default, or nullable) plus a migration.
2. Add a select constant and loader in `packages/db/src/instance-settings.ts` (reading `INSTANCE_SETTINGS_ID` and treating a missing row as the default), and include the field in `ADMIN_OVERVIEW_SETTINGS_SELECT` / `loadAdminSettingsSnapshot` for `/admin`. If a worker needs it, wrap the loader with `createCachedLoader` (15 s TTL, no restart needed).
3. Write it with `upsert({ where: { id: INSTANCE_SETTINGS_ID }, create: { id: INSTANCE_SETTINGS_ID, ...data }, update: data })` in an action guarded by `getSuperAdminOrThrow()`.
4. UI: a section on an existing admin page, or a new `app/(dashboard)/admin/<name>/page.tsx` starting with `await requireSuperAdmin()`. Add it to `ADMIN_SECTIONS` in `components/admin/admin-nav.tsx` and give it a card on `app/(dashboard)/admin/page.tsx` (fed by `loadAdminSettingsSnapshot`). Revalidate `/admin` too after saving.
5. Secrets: store `encryptToken(value)`, add to `GLOBAL_OMIT` in `packages/db/src/index.ts`, and never return it. Expose `hasX: boolean` in the view type, and keep the saved value when input is empty.
6. Document it in [./auth-and-access.md](./auth-and-access.md) or the relevant feature doc.

## Add an environment variable

Only for things fixed per deployment (URLs, secrets, capacity). Runtime-editable settings belong on `InstanceSettings`. Then follow the checklist in [../operations/configuration.md](../operations/configuration.md#rules): `.env.example`, `scripts/setup-env.mjs`, `scripts/sync-env.mjs` `ADDITIONS`, the compose `environment:` blocks, docs, and `CHANGELOG.md`. For a removal, add the key to `OBSOLETE` in `sync-env.mjs`.

## Add a queue or job type

1. `packages/queue/src/names.ts` (or `deps.ts`): queue name, job name, payload interface, jobId / deduplication helper (no `:`), job options, and explicit priority if shared. Export from `src/index.ts`.
2. Worker: create the queue in `apps/worker/src/queues/index.ts` (and `closeQueues`), write `src/processors/<name>.processor.ts` taking a `deps` object, and register a `Worker` in `startWorkers` in `src/index.ts` (for `apps/deps-worker`, add the queue in `apps/deps-worker/src/queues.ts` and register the `Worker` in `main()` in `apps/deps-worker/src/index.ts`). Use `deduplicatedJobOptions` / `enqueueDeduplicated` (`packages/queue/src/queues.ts`) for deduplicated jobs.
3. Web producer (if any): a cached `Queue` using `getRedis()` + `withRedisTimeout` from `apps/web/src/server/realtime.ts` (release queues live in `server/realtime.ts`; `deps-*` queues live alongside their callers in `server/actions/dependencies.ts` and `server/deps-webhook-queue.ts`).
4. Permanent failures throw `UnrecoverableError`; rate limits use `queue.rateLimit()` + `Worker.RateLimitError()`, or `job.moveToDelayed()` + `DelayedError`.
5. Document it in [../CONTRACTS.md](../CONTRACTS.md#bullmq-queues--job-contracts) and [../apps/worker.md](../apps/worker.md) (or [../apps/deps-worker.md](../apps/deps-worker.md)).

## Add a realtime (SSE) event

1. Add the variant to `RealtimeEvent` and a case to `parseRealtimeEvent` in `packages/queue/src/events.ts`, with tests in `events.test.ts`.
2. Publish with `publishUserEvent(redis, userId, event)` (worker) or `publishToUser` (web), best effort.
3. Handle it in `apps/web/src/components/realtime/sse-listener.tsx`.
4. Document it in [../CONTRACTS.md](../CONTRACTS.md#realtime-sse-contract).

## Add a notification channel

1. Enum value in `NotificationChannel` (schema + migration) and in `packages/notifications/src/types.ts`.
2. `channels.ts`: add to `DELIVERABLE_CHANNELS` and `CHANNEL_INFO` (label, destination kind, placeholder, hint), plus masking if the destination carries a secret.
3. Release formatter in `src/formatters/<name>.ts` + `switch` case in `dispatchNotification` (`src/dispatcher.ts`), dependency formatter in `src/formatters/dependencies.ts` + `switch` case in `dispatchDependencyNotification` (`src/dependency-dispatcher.ts`), and exports in `index.ts`.
4. Webhooks reuse `postWebhook` (two-layer SSRF guard included). Never open raw sockets yourself.
5. `apps/web/src/components/notifications/channel-icon.tsx`: icon. Destination validation in `server/notification-destination.ts` if not a plain URL.
6. Tests in `formatters.test.ts`, `dispatcher.test.ts`, `formatters/dependencies.test.ts`, and `dependency-dispatcher.test.ts`. Docs: [../packages/notifications.md](../packages/notifications.md#channels).

## Add a dependency ecosystem or package manager

Background: [./dependencies.md](./dependencies.md). Everything that parses or plans stays pure in `packages/deps`; anything that executes a tool goes to `apps/deps-sandbox`.

**A package manager for an existing ecosystem** (e.g., a new npm-family tool):

1. Enum value in `PackageManager` (schema + migration), `PackageManager` in `packages/deps/src/types.ts`, and `PackageManagerValue` + `PACKAGE_MANAGER_LABELS` in `apps/web/src/lib/dependency-settings.ts`.
2. Detection (`detect.ts`): lockfile in `NPM_LOCKFILES` (order = precedence) or pyproject rules, `packageManagerFromField`. Lockfile reader in `src/lockfiles/<name>.ts` (name → version + format version, empty map + warning on failure), wired into `prepareLockfile` and re-exported from `src/lockfiles/index.ts`, with fixtures in `lockfiles.test.ts`.
3. Check-only: return a reason from `manifestCheckOnlyReason` (`plan.ts`) and add a detection warning. Stop here.
4. Lockfile regeneration: add to `SANDBOX_PACKAGE_MANAGERS` (`sandbox-contract.ts`); in `apps/deps-sandbox/src/commands.ts` update `TOOL_NAMES`, `TOOL_FOR`, `LOCKFILE_NAMES`, format constants, `buildCommands` (scripts off, lockfile only, `LOCKFILE_ONLY` variant), and tool-version checks; registry config files in `packages/deps/src/registry-config.ts` (`NPM_CONFIGS` / `PYTHON_CONFIGS`, `applyRegistryPolicy`), `run-lock.ts` (`RISKY_CONFIG_FILES`, `findConfigRegistries`), and worker's `*_REGISTRY_CONFIG_FILES` / workspace files (`deps-update.processor.ts`); pinned binary in `apps/deps-sandbox/Dockerfile` (verify every flag in the built image). Worker side: `validateLockfile` (`sandbox-client.ts`) must read the new format back.
5. Webhooks: manifest / lockfile names in `isDependencyFilePath` (`apps/web/src/server/github-app-webhook.ts`).

**A new ecosystem** (e.g., Cargo), on top of the steps above:

1. Enum value in `DependencyEcosystem` (schema + migration), `types.ts` (`DependencyEcosystem`, `RangeSyntax`, `ecosystemOfSyntax`), and `DEPENDENCY_ECOSYSTEMS` in `lib/dependency-settings.ts` (plus registry link there and in `pull-request.ts`).
2. Versions: module in `src/versions/` (parse, compare, pre-release, satisfies, max satisfying, lower bound, bump keeping operator and precision), wired into `versions/index.ts`, unit-tested.
3. Manifest parser (`src/manifests/`, located spans) and rewriter (`src/rewrite/`, span edits + structural re-check), `ManifestFormat`, `manifestFormatOf`, and `toCandidate` in `detect.ts`, barrel exports in `packages/deps/src/index.ts`, parsing dispatch in `apps/deps-worker/src/analysis.ts` (`analyzeProject`), and rewrite dispatch in `deps-update.processor.ts`.
4. Registry client in `src/registries/` (fixed host constant, `cachedGet` with ETag, publish dates, deprecated/yanked, source repo URL), a `RegistryCacheNamespace` and `RegistryUnavailableError.registry` / `cachedGet` union entry in `src/registries/cache.ts`, `fetchRegistryPackage` + re-export in `src/registries/index.ts`, `registryMessage` in `apps/deps-worker/src/processors/deps-scan.processor.ts`, and range syntax wiring in `packages/deps/src/plan.ts` (`isValidIgnoreVersions`) and `apps/web/src/server/actions/dependencies.ts` (`rangeSyntaxes`).
5. Registry policy & egress: update `packages/deps/src/registry-config.ts` (`registryConfigPaths`, `publicRegistry`, `applyRegistryPolicy`); if the sandbox must reach a new registry host, also update `deploy/deps-egress/squid.conf` (`registries` ACL) and `DEFAULT_REGISTRY_HOSTS` in `run-lock.ts`. Document in [../operations/deployment.md](../operations/deployment.md) and [../apps/deps-sandbox.md](../apps/deps-sandbox.md).
6. Update [../packages/deps.md](../packages/deps.md#supported-ecosystems--detection) and `CHANGELOG.md`.

## Add a dashboard page

1. `apps/web/src/app/(dashboard)/<route>/page.tsx`: `export const metadata = { title: "X · RepoPulse" }`, then `const user = await requireUser()` (or `requireSuperAdmin()`).
2. Data from `server/queries/*`. Pass plain objects to client components; type-only imports from `server/*`.
3. Layout: `mx-auto max-w-4xl space-y-6`, then `h1` + description, then card sections. Add navigation in `apps/web/src/components/layout/app-sidebar.tsx`.

## Release a version

1. Rename `## [Unreleased]` to `## [X.Y.Z] — YYYY-MM-DD — <summary>` (3- or 4-part version matching `scripts/release-notes.mjs`), add **Upgrade notes** for migrations and env changes, and put a fresh empty `## [Unreleased]` above it.
2. Set `version` in `apps/web/package.json` to `X.Y.Z`. `next.config.ts` inlines it as `process.env.APP_VERSION`, shown at the bottom of the sidebar. Preview the extracted release metadata locally with `node scripts/release-notes.mjs`.
3. Pushing `apps/web/package.json` and `CHANGELOG.md` to `main` triggers [`.github/workflows/release.yml`](../../.github/workflows/release.yml), creating an annotated `v<version>` tag (embedding the release title and `CHANGELOG.md` notes) and GitHub Release automatically. Only tag manually (`git tag vX.Y.Z`) when the user explicitly asks.

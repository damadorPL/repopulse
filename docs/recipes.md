# Recipes

> **Summary:** step-by-step checklists for recurring changes. Each ends with the same verification:
> `pnpm --filter "./packages/*" build && pnpm typecheck && pnpm lint && pnpm test` (+ `pnpm --filter @repopulse/web build`
> for web changes), then a `CHANGELOG.md` entry under `## [Unreleased]`.

## Add a database column or model

1. Edit `packages/db/prisma/schema.prisma`. Add `///` doc comments on non-obvious fields.
2. `cd packages/db && npx prisma migrate dev --create-only --name <snake_name>`, or write
   `prisma/migrations/<YYYYMMDDHHMMSS>_<snake_name>/migration.sql` by hand. Renames use `RENAME COLUMN`; backfill
   existing rows in the same SQL when needed.
3. `npx prisma migrate deploy && npx prisma generate`, then check the diff is empty:
   `npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script`.
4. Update the code and tests that mock the changed model.
5. Update [data-model.md](./data-model.md) and mention the migration in the changelog.

## Add a Server Action

1. Pick the area file in `apps/web/src/server/actions/` (or create `<area>.ts` starting with `"use server"`).
2. Follow the template in [web-app.md](./web-app.md#server-actions): zod input, `getCurrentUserOrThrow()` /
   `getSuperAdminOrThrow()`, user-scoped queries, `revalidatePath`, `return ok(...)`, and
   `catch → toActionError(error, "<name>")`.
3. Shared constants and schemas go in `src/lib/<area>.ts`; server-only helpers in `src/server/<area>.ts`.
4. Client: call it in `startTransition`, handle `result.ok`, toast, and `UNAUTHORIZED` → `/login`.
5. Test the pure parts (schemas, helpers) with Vitest.

## Add an instance setting (super admin)

1. Add a column to `InstanceSettings` (with a default, or nullable) plus a migration.
2. Read it server-side with `prisma.instanceSettings.findUnique({ where: { id: INSTANCE_SETTINGS_ID } })`, and treat a
   missing row as the default. If the worker needs it, read it per job (no restart needed) or cache it briefly.
3. Write it with `upsert({ where: { id: INSTANCE_SETTINGS_ID }, create: { id: INSTANCE_SETTINGS_ID, ...data }, update: data })`
   in an action guarded by `getSuperAdminOrThrow()`.
4. UI: a section on an existing admin page, or a new `app/(dashboard)/admin/<name>/page.tsx` starting with
   `await requireSuperAdmin()`. Add it to `ADMIN_SECTIONS` in `components/admin/admin-nav.tsx` (the admin panel tabs)
   and give it a card on the overview `app/(dashboard)/admin/page.tsx`. Revalidate `/admin` too after saving.
5. Secrets: store `encryptToken(value)` and never return it. Expose `hasX: boolean` in the view type, and keep the
   saved value when the input is empty.
6. Document it in [auth-and-access.md](./auth-and-access.md) or the relevant feature doc.

## Add an environment variable

Only for things fixed per deployment (URLs, secrets, capacity). Runtime-editable settings belong on
`InstanceSettings`. Then follow the checklist in [configuration.md](./configuration.md#rules): `.env.example`,
`scripts/setup-env.mjs`, `scripts/sync-env.mjs` `ADDITIONS`, the compose `environment:` blocks, docs and changelog.
For a removal, add the key to `OBSOLETE` in `sync-env.mjs`.

## Add a queue or job type

1. `packages/queue/src/names.ts`: queue name, job name, payload interface, a jobId helper (no `:`), job options
   (`removeOnComplete: true` if the jobId must be reusable) and a priority if it shares a worker with other priorities.
   Export them from `src/index.ts`.
2. Worker: create the queue in `apps/worker/src/queues/index.ts` (and in `closeQueues`), write
   `src/processors/<name>.processor.ts` taking a `deps` object, and register a `Worker` in `startWorkers` in
   `src/index.ts`.
3. Web producer (if any): a cached `Queue` in `apps/web/src/server/realtime.ts`, wrapped with `withRedisTimeout`.
4. Permanent failures throw `UnrecoverableError`; rate limits use `queue.rateLimit()` + `Worker.RateLimitError()`, or
   `job.moveToDelayed()` + `DelayedError`.
5. Document it in [worker.md](./worker.md#queues).

## Add a realtime (SSE) event

1. Add the variant to `RealtimeEvent` and a case to `parseRealtimeEvent` in `packages/queue/src/events.ts`, with tests
   in `events.test.ts`.
2. Publish with `publishUserEvent(redis, userId, event)` (worker) or `publishToUser` (web), best effort.
3. Handle it in `apps/web/src/components/realtime/sse-listener.tsx`.

## Add a notification channel

1. Enum value in `NotificationChannel` (schema + migration) and in `packages/notifications/src/types.ts`.
2. `channels.ts`: add it to `DELIVERABLE_CHANNELS` and `CHANNEL_INFO` (label, destination kind, placeholder, hint),
   and masking if the destination carries a secret.
3. A formatter in `src/formatters/<name>.ts`, a `switch` case in `dispatchNotification`, exports in `index.ts`.
4. Webhooks reuse `postWebhook` (the SSRF guard included). Never open sockets yourself.
5. `apps/web/src/components/notifications/channel-icon.tsx`: an icon. Destination validation in
   `server/notification-destination.ts` if it is not a plain URL.
6. Tests in `formatters.test.ts` and `dispatcher.test.ts`. Docs: [notifications.md](./notifications.md#channels).

## Add a dependency ecosystem or package manager

Background: [dependencies.md](./dependencies.md). Everything that parses or plans stays pure in `packages/deps`;
anything that executes a tool goes to `apps/deps-sandbox`.

**A package manager for an existing ecosystem** (e.g. a new npm-family tool):
1. Enum value in `PackageManager` (schema + migration), `PackageManager` in `packages/deps/src/types.ts`, and
   `PackageManagerValue` + `PACKAGE_MANAGER_LABELS` in `apps/web/src/lib/dependency-settings.ts`.
2. Detection (`detect.ts`): its lockfile in `NPM_LOCKFILES` (order = precedence) or the pyproject rules,
   `packageManagerFromField`. A lockfile reader in `src/lockfiles/<name>.ts` (name → version + format version, empty
   map + warning on failure), wired into `readLockfile`, with fixtures in `lockfiles.test.ts`.
3. Check only: return a reason from `manifestCheckOnlyReason` (`plan.ts`) and add a detection warning. Stop here.
4. Lockfile regeneration: add it to `SANDBOX_PACKAGE_MANAGERS` (`sandbox-contract.ts`); in `apps/deps-sandbox/src/commands.ts`
   `TOOL_NAMES`, `TOOL_FOR`, `LOCKFILE_NAMES`, the lockfile format constants, `buildCommands` (scripts off, lockfile
   only, `LOCKFILE_ONLY` variant) and the tool-version checks; registry config files in `run-lock.ts`
   (`RISKY_CONFIG_FILES`, `findConfigRegistries`) and in the worker's `*_REGISTRY_CONFIG_FILES` / workspace files
   (`deps-update.processor.ts`); the pinned binary in `apps/deps-sandbox/Dockerfile` (verify every flag against it in
   the built image). Worker side: `validateLockfile` (`sandbox-client.ts`) must read the new format back.
5. Webhooks: its manifest / lockfile names in `isDependencyFilePath` (`apps/web/src/server/github-app-webhook.ts`).

**A new ecosystem** (e.g. Cargo), on top of the steps above:
1. Enum value in `DependencyEcosystem` (schema + migration), `types.ts` (`DependencyEcosystem`, a `RangeSyntax`,
   `ecosystemOfSyntax`) and `DEPENDENCY_ECOSYSTEMS` in `lib/dependency-settings.ts` (plus the registry link there and
   in `pull-request.ts`).
2. Versions: a module in `src/versions/` (parse, compare, pre-release, satisfies, max satisfying, lower bound, bump
   keeping the operator and precision), wired into `versions/index.ts`, fully unit-tested.
3. Manifest parser (`src/manifests/`, located spans) and rewriter (`src/rewrite/`, span edits + structural re-check),
   `manifestFormatOf` in `detect.ts`, and the rewrite dispatch in `deps-update.processor.ts`.
4. Registry client in `src/registries/` (fixed host constant, `cachedGet` with ETag, publish dates, deprecated /
   yanked, source repository URL), a `RegistryCacheNamespace`, and the switch in `fetchRegistryPackage`.
5. If the sandbox must reach a new registry host: `deploy/deps-egress/squid.conf` (`registries` ACL) and
   `DEFAULT_REGISTRY_HOSTS` in `run-lock.ts`. Document it in [deployment.md](./deployment.md).
6. Update [dependencies.md](./dependencies.md#supported-ecosystems) and the changelog.

## Add a dashboard page

1. `apps/web/src/app/(dashboard)/<route>/page.tsx`: `export const metadata = { title: "X · RepoPulse" }`, then
   `const user = await requireUser()` (or `requireSuperAdmin()`).
2. Data from `server/queries/*`. Pass plain objects to client components; type-only imports from `server/*`.
3. Layout: `mx-auto max-w-4xl space-y-6`, then `h1` + description, then card sections. Add navigation in
   `app-sidebar.tsx`.

## Release a version

1. Rename `## [Unreleased]` to `## [X.Y.Z] — YYYY-MM-DD — <summary>`, add **Upgrade notes** for migrations and env
   changes, and put a fresh empty `## [Unreleased]` above it.
2. Set `version` in `apps/web/package.json` to `X.Y.Z`. `next.config.ts` inlines it as `process.env.APP_VERSION`,
   shown at the bottom of the sidebar.
3. Optionally tag it: `git tag vX.Y.Z` (only when the user asks).

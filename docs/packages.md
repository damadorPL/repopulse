# Workspace packages

> **Summary:** five libraries shared by `apps/web`, `apps/worker`, `apps/deps-worker` and `apps/deps-sandbox`. Each `package.json` points `types` at `src/`
> (so typecheck sees changes immediately) and `default` at `dist/` (so **runtime and tests use the built output**:
> run `pnpm --filter "./packages/*" build` after edits). Build with `tsc -p tsconfig.build.json`.

## Rules

- **MUST** export new public API from the package's `src/index.ts` (and the browser-safe subpath, if relevant).
- **MUST NOT** import Node-only modules (`node:*`, ioredis, nodemailer, Prisma) from a browser-safe subpath:
  `@repopulse/queue/events`, `@repopulse/notifications/channels`, `@repopulse/github/watched-paths`,
  `@repopulse/deps/limits`, `@repopulse/deps/sandbox-contract`.
- **MUST NOT** make `@repopulse/notifications` or `@repopulse/deps` depend on `@repopulse/db` (or `deps` on Octokit).
  Keep their inputs structural.
- ESM packages (`github`, `queue`, `notifications`, `deps`) use `.js` extensions in relative imports. `db` compiles to
  CJS (Prisma `moduleFormat = "cjs"`).
- Each package has its own Vitest suite (`src/**/*.test.ts`).

## `@repopulse/db` (`packages/db`)

| Export | What |
| --- | --- |
| `prisma` / `db` | Singleton `PrismaClient` with the `PrismaPg` adapter (`DATABASE_URL`) |
| `* from generated/prisma/client` | Model types (`User`, `Release`, …), enums, the `Prisma` namespace |
| `encryptToken(plain)` / `decryptToken(cipher)` | AES-256-GCM with `TOKEN_ENCRYPTION_KEY` (64 hex chars), format `ivHex:tagHex:cipherHex`. The key is read on every call |
| `INSTANCE_SETTINGS_ID` | `1`, the id of the single `InstanceSettings` row |
| `SMTP_SETTINGS_SELECT` | Prisma `select` for the SMTP columns |
| `loadBackfillOverrides(client)`, `BACKFILL_SETTINGS_SELECT`, `NO_BACKFILL_OVERRIDES` | The admin overrides of the release history settings (`null` = keep env / default), keyed like `BackfillConfig`; merge with `applyBackfillOverrides` |
| `loadSmtpSettings(client)` | Reads the row and decrypts the password into `DecryptedSmtpSettings`, or `null` without a row. Throws `SmtpPasswordUnreadableError` when decryption fails |
| `loadGitHubAppSettings(client)`, `GITHUB_APP_SETTINGS_SELECT`, `DecryptedGitHubAppSettings`, `GitHubAppKeyUnreadableError` | The GitHub App (Slice 08): `{ appId, slug, clientId, owner, privateKey, webhookSecret }` decrypted, or `null` unless id, slug and key are all set. Throws `GitHubAppKeyUnreadableError` when a secret can't be decrypted. Server-side only |
| `loadDepsEnabled(client)` | The Admin → Dependencies switch (`false` without a row) |

Scripts: `db:generate`, `db:migrate:deploy`, `db:migrate:dev`. See [data-model.md](./data-model.md).

## `@repopulse/github` (`packages/github`)

| Export | What |
| --- | --- |
| `parseRepoInput(input)` → `{ owner, name }` | Accepts `owner/repo`, `github.com/owner/repo(.git)`, full URLs (deep links too), `git@github.com:owner/repo.git`. Throws `InvalidRepositoryInputError` |
| `classifySemver(tag)` | → `MAJOR` / `MINOR` / `PATCH` / `PRERELEASE` / `OTHER` |
| `createOctokit({ token })`, `GITHUB_USER_AGENT` | Octokit with the RepoPulse user agent |
| `getRateLimitInfo(headers)`, `isGitHubHttpError` | Header and error inspection |
| `validateAndFetchRepo({ owner, name, token })` | Metadata, latest `INITIAL_RELEASES_LIMIT` (10) published releases, the releases `ETag` |
| `pollRepoReleases({ …, etag, signal })` | Conditional GET of `RELEASES_PAGE_SIZE` (20): `NOT_MODIFIED` or `UPDATED` with releases, the new ETag and the remaining quota |
| `fetchReleasesPage({ page })`, `hasNextLink`, `BACKFILL_PAGE_SIZE` (100) | Unconditional paging for the backfill |
| `mapRelease` | GitHub release → `MappedRelease` (the `Release` columns). Drafts are excluded upstream |
| `fetchRecentTags` (GraphQL, needs a token), `compareCommits`, `buildTagChangelog`, `mapTag`, `mapGraphqlTag`, `TAGS_PAGE_SIZE` (20), `TAG_CHANGELOG_MAX_COMMITS` (50) | Tag tracking |
| `fetchCommitsForPath` (REST, `PATH_COMMITS_PAGE_SIZE` 10; 409 empty repo = `[]`), `fetchCommitDetail`, `buildCommitChangelog`, `mapPathCommit`, `COMMIT_CHANGELOG_MAX_FILES` (50) | "Files / folders" tracking |
| `fetchRepoTree` (repo + recursive Git tree of the default branch, 2 requests; empty repo = empty tree), `mapRepoTree`, `REPO_TREE_MAX_ENTRIES` (10,000, shallowest first; `truncated` flags the rest) | The web path picker's autocomplete and folder browser |
| `normalizeWatchedPath`, `parseWatchedPaths`, `commitMatchesPath`, `commitMatchesAnyPath`, `MAX_WATCHED_PATHS` (10), `MAX_WATCHED_PATH_LENGTH` (240) | Watched paths. Pure and browser-safe: client code imports them from `@repopulse/github/watched-paths` |
| `GitHubRepositoryNotFoundError` (404), `GitHubRateLimitError` (`resetAt`; 403 with quota 0, or 429) | Typed errors, mapped to `NOT_FOUND` / `RATE_LIMITED` by `toActionError` |
| `fetchGitTree({ owner, name, repositoryId?, octokit })` (metadata by id so renames are followed, head SHA, recursive tree with blob SHAs and sizes; 3 requests), `mapGitTreeEntries` | Dependency scans (`git-tree.ts`) |
| `createAppOctokit`, `getAuthenticatedApp` (`GET /app`), `convertAppManifest(code)`, `buildAppManifest`, `appManifestFormUrl(state, org?)`, `defaultAppName`, `getRepoInstallation` (`null` = not installed), `createInstallationToken(auth, id, { repositoryIds, permissions })`, `getCollaboratorPermission` (`role_name`; `null` on 404), `permissionAtLeast`, `getUserLoginById`, `installUrl(slug, repoId?, targetId?)` (pre-selects the repository only with the owner account id), `isValidGitHubLogin`, `GitHubAppAuthError`, `GitHubAppInstallationError` | GitHub App (`app.ts`, `@octokit/auth-app`). Errors never contain the key, a JWT or a token |
| `getAppWebhookConfig`, `updateAppWebhookConfig` (`PATCH /app/hook/config`: URL, content type, secret; it can't activate the hook or change events), `verifyWebhookSignature` (constant time), `signWebhookPayload` | App webhooks (`app-hook.ts`) |
| `readBlobs`, `commitFiles` (blobs → tree → commit without author → create / force-update the ref; 409 / 422 → `RefUpdateConflictError`), `inspectBranch` / `branchIsBotOwned` / `getBranchHead`, `treeHasContent`, `treeMatchesFiles`, `gitBlobSha`, `upsertPullRequest`, `closePullRequest`, `getPullRequestState` (`null` on 404), `toRateLimitError` / `rethrowRateLimit` (primary and secondary limits), `GIT_WRITE_CONCURRENCY` (4) | Update PRs through the Git Data API (`git-write.ts`) |

## `@repopulse/queue` (`packages/queue`)

| Export | What |
| --- | --- |
| `QUEUE_NAMES`, `JOB_NAMES`, `SCHEDULER_ID`, `DEFAULT_POLL_INTERVAL_CRON` | Names (see [worker.md](./worker.md#queues)) |
| `RepoPollJobData`, `ReleaseBackfillJobData`, `NotificationJobData`, `SchedulerJobData` | Payload types |
| `REPO_POLL_JOB_OPTIONS`, `RELEASE_BACKFILL_JOB_OPTIONS`, `NOTIFICATION_JOB_OPTIONS`, `REPO_POLL_PRIORITY`, `RELEASE_BACKFILL_PRIORITY` | Shared job options, so the web and worker producers agree |
| `repoPollJobId`, `releaseBackfillJobId`, `notificationJobId` | Deterministic jobIds |
| `BACKFILL_DEFAULTS`, `readBackfillConfig(env)`, `applyBackfillOverrides(base, overrides)`, `BACKFILL_LIMITS`, `DEEP_BACKFILL_STEP` (200), `DEEP_BACKFILL_COOLDOWN_MS` (5 min) | Backfill settings: env / defaults, then the admin overrides (clamped to `BACKFILL_LIMITS`; the default target never exceeds the hard cap). `deepStep` and `deepCooldownMinutes` have no env var |
| `createRedisConnection(opts)` | ioredis with `maxRetriesPerRequest: null` (worker default; web overrides it) |
| `publishUserEvent(redis, userId, event)` | Publishes to `user:{userId}:events` |
| `DEPS_QUEUE_NAMES`, `DEPS_JOB_NAMES`, `DEPS_SCHEDULER_ID`, `DEFAULT_DEPS_SCAN_CRON`, `DepsScanJobData` / `DepsUpdateJobData` / `DepsNotifyJobData` / `DepsSchedulerJobData` / `DepsScanTrigger`, `DEPS_{SCAN,UPDATE,NOTIFY}_JOB_OPTIONS`, `DEPS_SCAN_PRIORITY`, `DEPS_UPDATE_PRIORITY`, `depsScanJobId`, `depsUpdateJobId`, `depsNotifyJobId` | The Dependencies queues (`deps.ts`, [dependencies.md](./dependencies.md#queues-deps_queue_names-consumed-only-by-deps-worker)) |
| `@repopulse/queue/events`: `RealtimeEvent`, `userEventsChannel`, `serializeRealtimeEvent`, `parseRealtimeEvent` | Browser-safe SSE contract. `parseRealtimeEvent` validates and returns `null` for anything unknown. The `DEPS_*` events carry `projectId` + `fullName` instead of a repository |

Changing `RealtimeEvent`: update the union, `parseRealtimeEvent` and its tests (`events.test.ts`), the publisher in
the worker and `components/realtime/sse-listener.tsx`.

## `@repopulse/notifications` (`packages/notifications`)

| Export | What |
| --- | --- |
| `dispatchNotification(input, { smtp, env, appBaseUrl, timeoutMs, signal, sendWebhook, sendMail, resolveAll, policy })` | Formats and delivers one notification. Throws `NotificationDeliveryError` (`permanent`) |
| `dispatchDependencyNotification(input, options)` | Same options and error classification, for a dependency digest or PR event (`{ project, kind, updates, pullRequest, rule, user }`). `IN_APP` / `EMAIL_DIGEST` → permanent error |
| `formatDependencyDiscordPayload`, `formatDependencySlackPayload`, `buildDependencyNtfyRequest`, `buildDependencyGotifyRequest`, `formatDependencyGotifyMessage`, `formatDependencyWebhookPayload`, `renderDependencyEmail`, `buildDependencyContext`, `dependencyHeadline`, `dependencyLevelLabel`, `DIGEST_MAX_ITEMS` (25) | Dependency formatters (`formatters/dependencies.ts`) |
| `buildTestRelease()` | The synthetic `v1.0.0 - RepoPulse Test Release` |
| `resolveAppBaseUrl(env)`, `releaseReaderUrl(base, id)` | Links back to the app (`APP_BASE_URL` → `AUTH_URL` → `NEXTAUTH_URL`) |
| `toSmtpConfig(StoredSmtpSettings)` → `SmtpConfig \| null`, `defaultSmtpFrom`, `createSmtpSender`, `renderReleaseEmail`, `SMTP_NOT_CONFIGURED_MESSAGE` | Email |
| `formatDiscordPayload`, `formatSlackPayload`, `buildNtfyRequest`, `buildGotifyRequest`, `resolveGotifyEndpoint`, `formatCustomWebhookPayload` | Per-channel formatters |
| `validateWebhookUrl`, `createGuardedLookup`, `classifyAddress`, `parseInternalHostsPolicy`, `internalHostsPolicyFromEnv` | SSRF guard |
| `postWebhook` | HTTP sender (guarded lookup, timeout, no redirects) |
| `NotificationDeliveryError`, `WebhookUrlError`, `isNotificationDeliveryError` | Errors |
| `@repopulse/notifications/channels`: `CHANNEL_INFO`, `DELIVERABLE_CHANNELS`, `isDeliverableChannel`, `channelLabel`, `maskDestination` | Browser-safe channel metadata used by the settings UI |

Details: [notifications.md](./notifications.md).

## `@repopulse/deps` (`packages/deps`)

Pure logic of the Dependencies module (no Prisma, no Octokit; `fetch` and the cache are injected). Used by
`apps/deps-worker`, `apps/deps-sandbox` (contract only) and `apps/web` (limits, schemas, planning helpers).
Dependencies: `semver`, `smol-toml`, `yaml`, `zod`. Details: [dependencies.md](./dependencies.md).

| Export | What |
| --- | --- |
| `@repopulse/deps/limits` (also from the root): `MAX_DEPENDENCY_PROJECTS_PER_USER` (50), `MAX_PROJECTS_PER_ADD` (20), `MAX_MANIFESTS_PER_PROJECT` (25), `MAX_DEPENDENCIES_PER_PROJECT` (1,000), `MAX_MANIFEST_BYTES` (1 MiB), `MAX_LOCKFILE_BYTES` (20 MiB), `MAX_IGNORE_RULES` (50), `SCAN_COOLDOWN_MS` (5 min), `REGISTRY_CACHE_TTL_MS` (1 h), `REGISTRY_CONCURRENCY` (8), `DIGEST_MAX_ITEMS`, `SCAN_INTERVAL_HOURS`, `MIN_RELEASE_AGE_DAYS_MAX` (30), `MAX_OPEN_PRS_MAX` (20), sandbox caps, `DEPS_BRANCH_PREFIX`, `DEPS_WORKER_HEARTBEAT_*`, `DEPENDENCY_PROJECT_DEFAULTS` | Browser-safe caps and defaults |
| `@repopulse/deps/sandbox-contract`: `lockRequestSchema`, `lockResponseSchema`, `sandboxHealthSchema`, `SANDBOX_PACKAGE_MANAGERS`, `LOCK_ERROR_CODES` | The `deps-worker` ↔ `deps-sandbox` HTTP contract (zod) |
| `detectManifests(tree, opts)`, `resolveManifestGroups`, `detectManifestsWithReader`, `manifestFormatOf`, `packageManagerFromField`, `SKIPPED_DIRECTORIES` | Manifest detection: groups, package manager, lockfile, workspace root, warnings |
| `parsePackageJson`, `parseRequirements` / `parseRequirementsTree` / `readRequirementsPins`, `parsePyproject`, `parsePep508` | Manifest parsers; each dependency keeps the span (JS string offsets) of its value |
| `readLockfile` and `read{PackageLock,PnpmLock,BunLock,YarnLock,UvLock,PoetryLock}` | Lockfile readers → name → resolved version + format version; oversized or broken files give an empty map and a warning |
| `compareVersions`, `satisfiesRange`, `maxSatisfying`, `rangeLowerBound`, `bumpRange`, npm (`npm*`) and PEP 440 / Poetry (`pep440*`, `parsePep440`) helpers | Versions and ranges per `RangeSyntax` (`npm`, `pep440`, `poetry`) |
| `fetchRegistryPackage`, `fetchNpmPackage`, `fetchPypiPackage`, `RegistryCache`, `registryCacheKey`, `createMemoryRegistryCache`, `RegistryUnavailableError`, `REGISTRY_CACHE_RETENTION_MS` (7 days) | Registry clients (fixed hosts, ETag revalidation) |
| `selectTarget`, `applyPolicy`, `classifyUpdate`, `groupUpdates`, `groupCapability`, `manifestCheckOnlyReason`, `manifestNeedsLockfile`, `ignoreRuleSchema`, `ignoreRulesSchema`, `isValidGroupKey`, `slugifyGroupName` | Planning (pure) |
| `rewritePackageJson`, `rewriteRequirements`, `rewritePyproject`, `ManifestRewriteError` | Span edits with a structural re-parse check |
| `depsBranchName`, `buildCommitMessage` / `buildPrTitle`, `buildPrBody`, `buildTargets`, `formatTarget` / `parseTarget`, `depsPrMarker` | PR branch, commit and body text |

# Workspace packages

> **Summary:** four libraries shared by `apps/web` and `apps/worker`. Each `package.json` points `types` at `src/`
> (so typecheck sees changes immediately) and `default` at `dist/` (so **runtime and tests use the built output**:
> run `pnpm --filter "./packages/*" build` after edits). Build with `tsc -p tsconfig.build.json`.

## Rules

- **MUST** export new public API from the package's `src/index.ts` (and the browser-safe subpath, if relevant).
- **MUST NOT** import Node-only modules (`node:*`, ioredis, nodemailer, Prisma) from a browser-safe subpath:
  `@repopulse/queue/events`, `@repopulse/notifications/channels`.
- **MUST NOT** make `@repopulse/notifications` depend on `@repopulse/db`. Keep its inputs structural.
- ESM packages (`github`, `queue`, `notifications`) use `.js` extensions in relative imports. `db` compiles to CJS
  (Prisma `moduleFormat = "cjs"`).
- Each package has its own Vitest suite (`src/**/*.test.ts`).

## `@repopulse/db` (`packages/db`)

| Export | What |
| --- | --- |
| `prisma` / `db` | Singleton `PrismaClient` with the `PrismaPg` adapter (`DATABASE_URL`) |
| `* from generated/prisma/client` | Model types (`User`, `Release`, …), enums, the `Prisma` namespace |
| `encryptToken(plain)` / `decryptToken(cipher)` | AES-256-GCM with `TOKEN_ENCRYPTION_KEY` (64 hex chars), format `ivHex:tagHex:cipherHex`. The key is read on every call |
| `INSTANCE_SETTINGS_ID` | `1`, the id of the single `InstanceSettings` row |
| `SMTP_SETTINGS_SELECT` | Prisma `select` for the SMTP columns |
| `loadSmtpSettings(client)` | Reads the row and decrypts the password into `DecryptedSmtpSettings`, or `null` without a row. Throws `SmtpPasswordUnreadableError` when decryption fails |

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
| `normalizeWatchedPath`, `parseWatchedPaths`, `commitMatchesPath`, `commitMatchesAnyPath`, `MAX_WATCHED_PATHS` (10), `MAX_WATCHED_PATH_LENGTH` (240) | Watched paths. Pure and browser-safe: client code imports them from `@repopulse/github/watched-paths` |
| `GitHubRepositoryNotFoundError` (404), `GitHubRateLimitError` (`resetAt`; 403 with quota 0, or 429) | Typed errors, mapped to `NOT_FOUND` / `RATE_LIMITED` by `toActionError` |

## `@repopulse/queue` (`packages/queue`)

| Export | What |
| --- | --- |
| `QUEUE_NAMES`, `JOB_NAMES`, `SCHEDULER_ID`, `DEFAULT_POLL_INTERVAL_CRON` | Names (see [worker.md](./worker.md#queues)) |
| `RepoPollJobData`, `ReleaseBackfillJobData`, `NotificationJobData`, `SchedulerJobData` | Payload types |
| `REPO_POLL_JOB_OPTIONS`, `RELEASE_BACKFILL_JOB_OPTIONS`, `NOTIFICATION_JOB_OPTIONS`, `REPO_POLL_PRIORITY`, `RELEASE_BACKFILL_PRIORITY` | Shared job options, so the web and worker producers agree |
| `repoPollJobId`, `releaseBackfillJobId`, `notificationJobId` | Deterministic jobIds |
| `BACKFILL_DEFAULTS`, `readBackfillConfig(env)`, `DEEP_BACKFILL_STEP` (200), `DEEP_BACKFILL_COOLDOWN_MS` (5 min) | Backfill settings |
| `createRedisConnection(opts)` | ioredis with `maxRetriesPerRequest: null` (worker default; web overrides it) |
| `publishUserEvent(redis, userId, event)` | Publishes to `user:{userId}:events` |
| `@repopulse/queue/events`: `RealtimeEvent`, `userEventsChannel`, `serializeRealtimeEvent`, `parseRealtimeEvent` | Browser-safe SSE contract. `parseRealtimeEvent` validates and returns `null` for anything unknown |

Changing `RealtimeEvent`: update the union, `parseRealtimeEvent` and its tests (`events.test.ts`), the publisher in
the worker and `components/realtime/sse-listener.tsx`.

## `@repopulse/notifications` (`packages/notifications`)

| Export | What |
| --- | --- |
| `dispatchNotification(input, { smtp, env, appBaseUrl, timeoutMs, signal, sendWebhook, sendMail, resolveAll, policy })` | Formats and delivers one notification. Throws `NotificationDeliveryError` (`permanent`) |
| `buildTestRelease()` | The synthetic `v1.0.0 - RepoPulse Test Release` |
| `resolveAppBaseUrl(env)`, `releaseReaderUrl(base, id)` | Links back to the app (`APP_BASE_URL` → `AUTH_URL` → `NEXTAUTH_URL`) |
| `toSmtpConfig(StoredSmtpSettings)` → `SmtpConfig \| null`, `defaultSmtpFrom`, `createSmtpSender`, `renderReleaseEmail`, `SMTP_NOT_CONFIGURED_MESSAGE` | Email |
| `formatDiscordPayload`, `formatSlackPayload`, `buildNtfyRequest`, `buildGotifyRequest`, `resolveGotifyEndpoint`, `formatCustomWebhookPayload` | Per-channel formatters |
| `validateWebhookUrl`, `createGuardedLookup`, `classifyAddress`, `parseInternalHostsPolicy`, `internalHostsPolicyFromEnv` | SSRF guard |
| `postWebhook` | HTTP sender (guarded lookup, timeout, no redirects) |
| `NotificationDeliveryError`, `WebhookUrlError`, `isNotificationDeliveryError` | Errors |
| `@repopulse/notifications/channels`: `CHANNEL_INFO`, `DELIVERABLE_CHANNELS`, `isDeliverableChannel`, `channelLabel`, `maskDestination` | Browser-safe channel metadata used by the settings UI |

Details: [notifications.md](./notifications.md).

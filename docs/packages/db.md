# `@repopulse/db` (`packages/db`)

> **Summary:** PostgreSQL 19 through Prisma 7 (`@prisma/adapter-pg`, `moduleFormat = "esm"`). Schema lives in `packages/db/prisma/schema.prisma`, migrations in `packages/db/prisma/migrations/`, and the client is generated into `packages/db/src/generated/prisma` (git-ignored) and re-exported with helpers from `@repopulse/db`.
>
> **Related Docs:** [../CODING_STANDARDS.md](../CODING_STANDARDS.md) · [../guides/auth-and-access.md](../guides/auth-and-access.md) · [../guides/recipes.md](../guides/recipes.md#add-a-database-column-or-model)

## Rules

- **MUST** add a new migration folder for every schema change: `packages/db/prisma/migrations/<YYYYMMDDHHMMSS>_<snake_name>/migration.sql`.
- **MUST NOT** edit or delete a migration that has already shipped: `20261031000000_init`, `20261031120000_release_backfill`, `20261101090000_tag_tracking`, `20261101120000_invites_registration`, `20261101150000_super_admin_smtp_settings`, `20261101180000_path_tracking`, `20261101210000_combined_tracking`, `20261101230000_backfill_settings`, `20261102120000_subscription_settings`, `20261103090000_dependency_projects`, `20261103100000_github_app`, `20261103130000_dependency_branch_write_intents`, `20261103131000_dependency_notification_outbox`, `20261127090000_audit_indexes`, `20261127100000_better_auth`, `20261127143000_performance_indexes`, `20261127153000_feed_covering_indexes`, `20261127160000_audit_query_indexes`, `20261127170000_postgresql_best_practices`.
- **MUST** keep migration SQL and `schema.prisma` aligned and review `prisma migrate diff` carefully: partial, covering (`INCLUDE`), GIN (`searchVector`), extended statistics (`Release_visibility_stats`), `fillfactor`/autovacuum parameters, and domain `CHECK` constraints are raw-SQL-managed (`packages/db/src/migrations.test.ts` guards against accidental drops).
- **MUST** use renames (`ALTER TABLE … RENAME COLUMN`) instead of drop + add when renaming columns so data is preserved.
- **MUST** use `INSTANCE_SETTINGS_ID` (`1`) rather than a literal when touching `InstanceSettings`, and always `upsert` (missing row = defaults).
- **MUST** keep ESM `.js` extensions on relative imports in `packages/db/src/` and rebuild `packages/*` (`pnpm --filter "./packages/*" build`) so `dist/` reflects edits.

## Models & Enums

| Model | Scope | Key fields and invariants |
| --- | --- | --- |
| `User` | per person | `githubId` unique (identity), `email` unique, `emailVerified` (Better Auth), `githubAccessTokenEncrypted` (AES-256-GCM `iv:tag:cipher` hex, globally omitted by default), `githubLogin` (refreshed on sign-in; cache for GitHub App permission check, re-resolved from `githubId` on 404), `isSuperAdmin` (first account; see [../guides/auth-and-access.md](../guides/auth-and-access.md)) |
| `Session`, `Account`, `Verification` | Better Auth | Database sessions, OAuth `Account` links (plaintext tokens cleared by auth hooks), and verification records |
| `InstanceSettings` | instance, row `id = 1` | `publicRegistration` (default `true`); SMTP (`smtpHost`, `smtpPort` 587, `smtpSecure` null = auto, `smtpUser`, `smtpPasswordEncrypted`, `smtpFrom`); release history (`backfillDefaultTarget`, `backfillMaxAgeDays`, `backfillHardCap`, `backfillMinQuota`, `backfillDeepStep`, `backfillDeepCooldownMinutes`; `null` = env/default); Dependencies (`depsEnabled` default `false`); GitHub App (`githubAppId`, `githubAppSlug`, `githubAppClientId`, `githubAppOwner`, `githubAppPrivateKeyEncrypted`, `githubAppWebhookSecretEncrypted`, never sent to browser). Always `upsert` |
| `Invite` | instance | `tokenHash` unique (SHA-256 of raw token; raw token never stored), `expiresAt`, `usedAt`/`usedById` (unique: one invite per account), `createdById` (cascade) |
| `Repository` | shared | `githubRepoId` (`BigInt`) unique (immutable; survives renames), `fullName` unique, `lastEtag`, `lastPolledAt`, `pollStatus` (`IDLE`/`POLLING`/`ERROR`), `errorCount`; backfill: `backfillStatus`, `backfillNextPage`, `backfillTarget` (100), `backfilledAt`, `backfillRequestedAt`; `lastTagsPolledAt`; `lastPathsPolledAt`, `polledPaths` (watched paths whose initial import is done; cleared when nobody watches paths) |
| `Release` | shared | unique `(repositoryId, githubReleaseId)` and `(repositoryId, source, tagName)`; `source` `RELEASE`/`TAG`/`COMMIT`; `githubReleaseId` (`BigInt`) null for tag/commit rows; `tagSha` for tag rows (tagged commit) and commit rows (full SHA, `tagName` = 7-char short SHA); `changedPaths` for commit rows; `semverType`; `isDraft` (never ingested as true); `searchVector` stored generated `tsvector` (`tagName` A / `title` B / `bodyMarkdown` C) with GIN index |
| `UserSubscription` | per user | unique `(userId, repositoryId)`, `includePrereleases`, `trackMode` (`RELEASES` / `TAGS_AND_COMMITS` / `NONE`), `trackPaths` ("Files / folders", independent of `trackMode`; at least one active, enforced by actions), `watchedPaths` (normalized, ≤ 10; kept while `trackPaths` is off), `isPinned`, `note` (plain text, ≤ 2,000), `notificationLevel` (`ALL` / `MINOR_AND_UP` / `MAJOR_ONLY` / `NONE`), `snoozedUntil`, `currentVersion` (≤ 100, "my version") |
| `Tag` | per user | unique `(userId, slug)`, `colorHex` `#RRGGBB` |
| `SubscriptionTag` | per user | join of subscription ↔ tag (both cascade) |
| `UserReleaseState` | per user | PK `(userId, releaseId)`, `isRead`, `readAt`. **No row = read** |
| `NotificationRule` | per user | `channel`, `destinationUrl` (webhook URL or optional email recipient), `tagId` (`null` = all repositories; `SetNull` on tag delete), `onlyMajorReleases`, `enabled`, `events` (`NotificationEvent[]`, default `[RELEASES]`; ≥ 1; tag-scoped rules may only have `RELEASES`). Max 25 per user (`MAX_NOTIFICATION_RULES`) |
| `DependencyProject` | per user | Independent of subscriptions. Unique `(userId, githubRepoId)` (`BigInt`); `owner` / `name` / `fullName` / `defaultBranch` / `isPrivate` refreshed per scan; `repositoryId` (`SetNull`); policy: `updateMode` (`NOTIFY` / `MANUAL_PR` / `AUTO_PR`), `maxUpdateLevel` (`MINOR`), `includePrereleases`, `minReleaseAgeDays` (3, 0–30), `groupMode` (`SEPARATE_MAJORS`), `rangeStrategy` (`BUMP`), `maxOpenPrs` (5, 1–20), `scanIntervalHours` (24: 6/12/24/168), `notificationLevel` (`MINOR_AND_UP`), `ignoreRules` (JSONB `[{ name, versions? }]`, ≤ 50), `manifestPaths` (empty = auto-detect), `commitPrefix` (`chore(deps):`), `notifyOnFirstScan`; scan state: `lastScannedAt`, `lastScannedSha`, `nextScanAt`, `scanStatus` (`IDLE` / `QUEUED` / `SCANNING` / `ERROR`), `scanError` (user-safe), `errorCount` |
| `DependencyManifest` | per project | Unique `(projectId, path)`; `ecosystem`, `packageManager`, `lockfilePath`, `workspaceRoot`, `blobSha`, `dependencyCount`, `warnings` (project-level warnings stored on first manifest). Cascade from project |
| `DependencyUpdate` | per project | One outdated direct dependency (up-to-date rows are deleted). Unique `(manifestId, name, kind, group)` (`group` is `""`, not null, so the key works); `declared`, `currentVersion`, `wantedVersion`, `targetVersion` (set for `OUTDATED` and `DISMISSED` only), `latestVersion`, `level`, `status`, `targetReleasedAt`, `sourceRepoUrl`, `firstSeenAt`, `notifiedAt` |
| `DependencyPullRequest` | per project | Unique `(projectId, groupKey)`; `branch` (`repopulse/deps/<groupKey>`), `number`, `htmlUrl`, `state` (`OPEN` / `MERGED` / `CLOSED` / `EDITED`), `headSha`, `targets` (`manifestPath#name@version`), `closedAt` |
| `DependencyPrOwner` | instance | PK `githubRepoId` (`BigInt`), `projectId` unique (cascade): the single project per GitHub repository allowed to open PRs |
| `DependencyBranchWriteIntent` | per project/group | PK `(projectId, groupKey)`; prepared `commitSha` and observed `previousHeadSha`, persisted before mutating a bot branch; project deletion cascades |
| `DependencyNotificationOutbox` | per project | Deterministic BullMQ job `id`, JSON `payload`, `createdAt`; retained until BullMQ acknowledges enqueueing; project deletion cascades |

Enums: `PollStatus`, `SemverType` (`MAJOR`, `MINOR`, `PATCH`, `PRERELEASE`, `OTHER`), `TrackMode`, `ReleaseSource`, `NotificationLevel` (`ALL`, `MINOR_AND_UP`, `MAJOR_ONLY`, `NONE`), `BackfillStatus` (`NONE`, `QUEUED`, `RUNNING`, `DONE`, `PARTIAL`, `ERROR`), `NotificationChannel` (`IN_APP`, `EMAIL_INSTANT`, `EMAIL_DIGEST`, `DISCORD_WEBHOOK`, `SLACK_WEBHOOK`, `NTFY_WEBHOOK`, `GOTIFY_WEBHOOK`, `CUSTOM_WEBHOOK`), `NotificationEvent` (`RELEASES`, `DEPENDENCY_UPDATES`, `DEPENDENCY_PULL_REQUESTS`), `DependencyEcosystem` (`NPM`, `PYPI`), `PackageManager` (`NPM`, `PNPM`, `BUN`, `YARN`, `PIP`, `PIP_TOOLS`, `UV`, `POETRY`, `NONE`), `DependencyKind` (`PROD`, `DEV`, `PEER`, `OPTIONAL`, `GROUP`), `DepsUpdateMode`, `DepsUpdateLevel` (`PATCH`, `MINOR`, `MAJOR`), `DepsGroupMode`, `DepsRangeStrategy` (`BUMP`, `LOCKFILE_ONLY`), `DepsScanStatus`, `DependencyUpdateStatus` (`OUTDATED`, `TOO_NEW`, `ABOVE_LEVEL`, `BLOCKED_BY_RANGE`, `IGNORED`, `DISMISSED`, `UNSUPPORTED_SOURCE`), `DepsPrState`. Client code mirrors enums as string unions in `apps/web/src/lib/dependency-settings.ts` and `apps/web/src/lib/notification-events.ts`.

## Semantics to Preserve

- **Visibility (`visibleReleasesWhere`, `apps/web/src/server/queries/feed.ts`):** `isDraft = false`, user subscribes to the repository, not a pre-release (unless `includePrereleases`), and source matches subscription mode (`RELEASE` in `RELEASES`/`TAGS_AND_COMMITS`, `TAG` in `TAGS_AND_COMMITS`, `COMMIT` with `trackPaths` **and** a `UserReleaseState` row for that user).
- **Unread:** rows are created only for genuinely new releases. On add, initial 10 releases are unread. On poll, only items published after the newest stored release (`selectFreshReleases`). Backfill and extra releases of a first poll stay read.
- **Tag promotion:** when a GitHub Release appears for a tag already stored as `source = TAG`, the row is updated in place (one entry). `TAGS_AND_COMMITS` subscribers keep their read state and receive no second notification.
- **Commit states follow watched paths (`apps/web/src/server/commit-states.ts`):** adding a repo with `trackPaths`, turning it on, or changing paths drops states of commits that no longer match and seeds matching stored commits (newest 10 unread, older read) via `syncCommitStates` (`planCommitStates` / `commitMatchesAnyPath`).
- **Per-subscription notification settings (`apps/worker/src/processors/fan-out.ts` → `mayNotify`):** while `snoozedUntil > now`, or when release is below `notificationLevel` (`MINOR_AND_UP` skips `PATCH`/`PRERELEASE`/`OTHER` and pre-releases; `MAJOR_ONLY` keeps `MAJOR`; `NONE` skips all; commits are `OTHER`), no notification job is queued. Unread states and SSE are unaffected, and snooze is not retroactive.
- **Pre-releases toggled after adding (`updateSubscriptionSettingsAction`):** on → stored pre-releases among the 10 newest visible items get unread states; off → user's unread states on pre-releases of that repository are deleted.
- **Read cursor:** feed pages by keyset `(publishedAt, id)` (`encodeFeedCursor` / `afterCursorWhere`).
- **Notification events:** release fan-out (`ruleMatches`) and processor require `RELEASES` in `events`; `deps-worker` queues dependency jobs only for enabled, untagged rules with `DEPENDENCY_UPDATES` / `DEPENDENCY_PULL_REQUESTS`.
- **Dependency projects are separate from subscriptions:** removing either never touches the other. Dependency updates are not `Release` rows and never enter the feed or unread counters.
- **One PR owner per GitHub repository (`DependencyPrOwner`):** claimed when switching to a PR mode; released by `NOTIFY`, deleting the project, or losing repo access.
- **`notifiedAt` follows `targetVersion`:** scan preserves `firstSeenAt`/`notifiedAt` while `targetVersion` is unchanged and resets both when it changes. Digest rows receive `notifiedAt` in the same transaction that persists `DependencyNotificationOutbox` intents (first scan marks notified silently unless `notifyOnFirstScan`).
- **Closed PR → `DISMISSED`:** rows of a closed-without-merging PR stay `DISMISSED` for that version; a newer target becomes `OUTDATED` again. A PR whose branch head is neither `headSha` nor a pending `DependencyBranchWriteIntent` is `EDITED` and untouched.

## Migrations

```sh
# 1. edit packages/db/prisma/schema.prisma
cd packages/db
npx prisma migrate dev --create-only --name your_change   # or write migration.sql by hand
# 2. review packages/db/prisma/migrations/<ts>_your_change/migration.sql (renames, backfills, defaults)
npx prisma migrate deploy && npx prisma generate
npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script   # must be empty
cd ../.. && pnpm --filter "./packages/*" build && pnpm typecheck && pnpm test
```

In production the `migrator` service runs `prisma migrate deploy` before `web`, `worker`, and `deps-worker` start ([../operations/deployment.md](../operations/deployment.md)). Mention every new migration in `CHANGELOG.md`.

## Client Usage & Public Exports (`packages/db/src/index.ts`)

```ts
import { prisma, encryptToken, decryptToken, loadSmtpSettings, INSTANCE_SETTINGS_ID, type User } from "@repopulse/db";
import { loadDepsEnabled, loadGitHubAppSettings } from "@repopulse/db";
```

- `prisma` is a singleton cached unconditionally on `globalThis` using `@prisma/adapter-pg` (`max` via `parsePoolMax()` from `DATABASE_POOL_MAX` in `[1, 100]` default `10`, `idleTimeoutMillis: 30_000`, `connectionTimeoutMillis: 10_000`, `query_timeout: 35_000`, `application_name` from `DATABASE_APP_NAME`/`PGAPPNAME`, and `statementNameGenerator` intentionally omitted for PgBouncer compatibility and custom plans matching partial indexes). Never instantiate extra clients. All `DateTime` columns use `TIMESTAMPTZ(3)`.
- `GLOBAL_OMIT` excludes `User.githubAccessTokenEncrypted`, `InstanceSettings.smtpPasswordEncrypted`, `githubAppPrivateKeyEncrypted`, and `githubAppWebhookSecretEncrypted` by default; server-side readers must opt in explicitly via `select` or `omit: { ...: false }`.
- `packages/db/prisma.config.ts` loads root `.env` outside production.
- Client components in `apps/web` **MUST NOT** import `@repopulse/db`; use local string unions instead, and convert `BigInt` `githubRepoId` values to `Number` at DTO boundaries.

| Export | What |
| --- | --- |
| `prisma` | Singleton `PrismaClient` with `PrismaPg` adapter and `GLOBAL_OMIT` |
| `parsePoolMax(raw?)` | Parses `DATABASE_POOL_MAX` as an integer in `[1, 100]`, falling back to `10` |
| `* from generated/prisma/client` | Model types (`User`, `Release`, …), enums, `Prisma` namespace |
| `encryptToken(plain)` / `decryptToken(cipher)` | AES-256-GCM with `TOKEN_ENCRYPTION_KEY` (64 hex chars, format `ivHex:tagHex:cipherHex`, zeroizes derived key) |
| `INSTANCE_SETTINGS_ID` | `1`, id of the single `InstanceSettings` row |
| `loadBackfillOverrides(client)`, `BACKFILL_SETTINGS_SELECT`, `NO_BACKFILL_OVERRIDES`, `BackfillSettingsOverrides` | Admin overrides of release history settings (`null` = keep env/default) |
| `loadSmtpSettings(client)`, `SMTP_SETTINGS_SELECT`, `DecryptedSmtpSettings`, `SmtpPasswordUnreadableError` | Reads & decrypts SMTP columns (`null` if the `InstanceSettings` row does not exist yet; pass to `toSmtpConfig` to check whether `smtpHost` is configured; throws on unreadable password) |
| `loadGitHubAppSettings(client)`, `GITHUB_APP_SETTINGS_SELECT`, `DecryptedGitHubAppSettings`, `GitHubAppKeyUnreadableError` | Reads & decrypts GitHub App config (`null` unless id, slug, and key are all set) |
| `loadGitHubAppWebhookSettings(client)`, `GITHUB_APP_WEBHOOK_SETTINGS_SELECT`, `GitHubAppWebhookSettings` | Single-query webhook loader for `depsEnabled` + decrypted webhook secret |
| `loadAdminSettingsSnapshot(client)`, `ADMIN_OVERVIEW_SETTINGS_SELECT`, `AdminSettingsSnapshot` | Single-query safe snapshot of all settings for `/admin` |
| `loadDepsEnabled(client)` | Admin → Dependencies switch (`false` without a row) |
| `createCachedLoader(load, options?)`, `CachedLoaderOptions`, `DEFAULT_SETTINGS_CACHE_TTL_MS` | In-memory TTL + single-flight cache wrapper (`options`: `{ ttlMs?, now? }`, default 15 s, exposes `.invalidate()`) for worker settings reads |
| `packages/db/dist/bootstrap-app-role.js` | CLI entrypoint run by `migrator` to provision the least-privilege `repopulse_app` role, role-level timeouts, and `pg_stat_statements` |

# Data model

> **Summary:** PostgreSQL 16 through Prisma 7. The schema is `packages/db/prisma/schema.prisma`, migrations are in
> `packages/db/prisma/migrations/`, and the client is generated into `packages/db/src/generated/prisma` (git-ignored)
> and exported from `@repopulse/db`.

## Rules

- **MUST** add a new migration folder for every schema change: `YYYYMMDDHHMMSS_snake_name/migration.sql`.
- **MUST NOT** edit or delete a migration that has shipped. Released migrations so far: `20261031000000_init`,
  `20261031120000_release_backfill`, `20261101090000_tag_tracking`, `20261101120000_invites_registration`,
  `20261101150000_super_admin_smtp_settings`, `20261101180000_path_tracking`, `20261101210000_combined_tracking`,
  `20261101230000_backfill_settings` and `20261102120000_subscription_settings`. 0.9.0 (Slice 08):
  `20261103090000_dependency_projects` (Dependencies models and enums, `NotificationRule.events`, `User.githubLogin`,
  `InstanceSettings.depsEnabled`) and `20261103100000_github_app` (the `InstanceSettings.githubApp*` columns).
- **MUST** keep the migration and the schema identical. Check with
  `cd packages/db && npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script`
  against a migrated dev DB. The output must be `-- This is an empty migration.`
- **MUST** use renames (`ALTER TABLE … RENAME COLUMN`) instead of drop + add when renaming, so data is kept.
- Use `INSTANCE_SETTINGS_ID` (`1`) rather than a literal when touching `InstanceSettings`.

## Models

| Model | Scope | Key fields and invariants |
| --- | --- | --- |
| `User` | per person | `githubId` unique (the identity), `email` unique, `githubAccessTokenEncrypted` (AES-GCM, `iv:tag:cipher` hex), `githubLogin` (refreshed on every sign-in; a cache for the GitHub App permission check, re-resolved from `githubId` on a 404), `isSuperAdmin` (the first account; see [auth-and-access.md](./auth-and-access.md)) |
| `InstanceSettings` | instance, one row `id = 1` | `publicRegistration` (default `true`); SMTP: `smtpHost` (null = email off), `smtpPort` (587), `smtpSecure` (null = auto), `smtpUser`, `smtpPasswordEncrypted`, `smtpFrom`; release history (Admin → Release history, each `null` = the `RELEASE_BACKFILL_*` env var or default): `backfillDefaultTarget`, `backfillMaxAgeDays`, `backfillHardCap`, `backfillMinQuota`, `backfillDeepStep`, `backfillDeepCooldownMinutes`; Dependencies: `depsEnabled` (default `false`, Admin → Dependencies); GitHub App (Admin → GitHub App; configured when id, slug and key are all set): `githubAppId`, `githubAppSlug`, `githubAppClientId`, `githubAppOwner`, `githubAppPrivateKeyEncrypted` (PEM), `githubAppWebhookSecretEncrypted` (both AES-GCM, never sent to the browser). A missing row means defaults, so always `upsert` |
| `Invite` | instance | `tokenHash` unique (SHA-256 of the raw token; the token itself is never stored), `expiresAt`, `usedAt`/`usedById` (unique: one invite per account), `createdById` (cascade) |
| `Repository` | shared | `githubRepoId` unique (immutable; survives renames), `fullName` unique, `lastEtag`, `lastPolledAt`, `pollStatus` (`IDLE`/`POLLING`/`ERROR`), `errorCount`; backfill: `backfillStatus`, `backfillNextPage`, `backfillTarget` (100), `backfilledAt`, `backfillRequestedAt`; `lastTagsPolledAt`; `lastPathsPolledAt`, `polledPaths` (watched paths whose initial import is done; exactly the paths watched at the last path poll, cleared when nobody watches paths) |
| `Release` | shared | unique `(repositoryId, githubReleaseId)` and `(repositoryId, source, tagName)`; `source` `RELEASE`/`TAG`/`COMMIT`; `githubReleaseId` null for tag and commit rows; `tagSha` for tag rows (tagged commit) and commit rows (full SHA, `tagName` = 7-char short SHA); `changedPaths` for commit rows (changed files plus the watched paths the commit was found through); `semverType`; `isDraft` (never ingested as true) |
| `UserSubscription` | per user | unique `(userId, repositoryId)`, `includePrereleases`, `trackMode` (`RELEASES` / `TAGS_AND_COMMITS` / `NONE`: release tracking), `trackPaths` ("Files / folders", independent of `trackMode`; at least one of the two is on, enforced by the Server Actions), `watchedPaths` (normalized, at most 10; kept while `trackPaths` is off); Slice 07 settings: `isPinned`, `note` (plain text, ≤ 2 000), `notificationLevel` (`ALL` / `MINOR_AND_UP` / `MAJOR_ONLY` / `NONE`), `snoozedUntil`, `currentVersion` (≤ 100, "my version") |
| `Tag` | per user | unique `(userId, slug)`, `colorHex` `#RRGGBB` |
| `SubscriptionTag` | per user | join of subscription ↔ tag (both cascade) |
| `UserReleaseState` | per user | PK `(userId, releaseId)`, `isRead`, `readAt`. **No row = read** |
| `NotificationRule` | per user | `channel`, `destinationUrl` (webhook URL or optional email recipient), `tagId` (null = all repositories; `SetNull` on tag delete), `onlyMajorReleases`, `enabled`, `events` (`NotificationEvent[]`, default `[RELEASES]`; at least one; a tag-scoped rule may only have `RELEASES`). Max 25 per user (`MAX_NOTIFICATION_RULES`) |
| `DependencyProject` | per user | A repository whose dependencies the user checks, independent of subscriptions. Unique `(userId, githubRepoId)`; `owner` / `name` / `fullName` / `defaultBranch` / `isPrivate` refreshed by every scan; `repositoryId` (the tracked `Repository`, `SetNull`); policy: `updateMode` (`NOTIFY` / `MANUAL_PR` / `AUTO_PR`), `maxUpdateLevel` (`MINOR`), `includePrereleases`, `minReleaseAgeDays` (3, 0–30), `groupMode` (`SEPARATE_MAJORS`), `rangeStrategy` (`BUMP`), `maxOpenPrs` (5, 1–20), `scanIntervalHours` (24: 6 / 12 / 24 / 168), `notificationLevel` (`MINOR_AND_UP`), `ignoreRules` (JSON `[{ name, versions? }]`, ≤ 50), `manifestPaths` (empty = auto-detect), `commitPrefix` (`chore(deps):`), `notifyOnFirstScan`; scan state: `lastScannedAt`, `lastScannedSha`, `nextScanAt`, `scanStatus` (`IDLE` / `QUEUED` / `SCANNING` / `ERROR`), `scanError` (user-safe), `errorCount` |
| `DependencyManifest` | per project | Unique `(projectId, path)`; `ecosystem`, `packageManager`, `lockfilePath`, `workspaceRoot`, `blobSha`, `dependencyCount`, `warnings` (project-level warnings are stored on the first manifest). Cascade from the project |
| `DependencyUpdate` | per project | One direct dependency that is not up to date (up-to-date ones have no row). Unique `(manifestId, name, kind, group)` (`group` is `""`, not null, so the key works); `declared`, `currentVersion`, `wantedVersion`, `targetVersion` (set for `OUTDATED` and `DISMISSED` only), `latestVersion`, `level` (`SemverType` of current → target), `status`, `targetReleasedAt`, `sourceRepoUrl`, `firstSeenAt`, `notifiedAt` |
| `DependencyPullRequest` | per project | Unique `(projectId, groupKey)`; `branch` (`repopulse/deps/<groupKey>`), `number`, `htmlUrl`, `state` (`OPEN` / `MERGED` / `CLOSED` / `EDITED`), `headSha` (the bot's last commit), `targets` (`manifestPath#name@version`, every planned target incl. no-ops), `closedAt` |
| `DependencyPrOwner` | instance | Primary key `githubRepoId`, `projectId` unique (cascade): the one project per GitHub repository that may open PRs |
| `DependencyBranchWriteIntent` | per project/group | Primary key `(projectId, groupKey)`; prepared `commitSha` and observed `previousHeadSha`, persisted before changing a bot branch; project deletion cascades |
| `DependencyNotificationOutbox` | per project | Deterministic BullMQ job `id`, JSON `payload`, `createdAt`; retained until enqueue acknowledgement; project deletion cascades |

Enums: `PollStatus`, `SemverType` (`MAJOR`, `MINOR`, `PATCH`, `PRERELEASE`, `OTHER`), `TrackMode`, `ReleaseSource`,
`NotificationLevel` (`ALL`, `MINOR_AND_UP`, `MAJOR_ONLY`, `NONE`),
`BackfillStatus` (`NONE`, `QUEUED`, `RUNNING`, `DONE`, `PARTIAL`, `ERROR`), `NotificationChannel` (`IN_APP`,
`EMAIL_INSTANT`, `EMAIL_DIGEST`, `DISCORD_WEBHOOK`, `SLACK_WEBHOOK`, `NTFY_WEBHOOK`, `GOTIFY_WEBHOOK`,
`CUSTOM_WEBHOOK`). `IN_APP` and `EMAIL_DIGEST` are never dispatched: in-app is the unread state itself, and digests
are not built yet. Slice 08: `NotificationEvent` (`RELEASES`, `DEPENDENCY_UPDATES`, `DEPENDENCY_PULL_REQUESTS`),
`DependencyEcosystem` (`NPM`, `PYPI`), `PackageManager` (`NPM`, `PNPM`, `BUN`, `YARN`, `PIP`, `PIP_TOOLS`, `UV`,
`POETRY`, `NONE`), `DependencyKind` (`PROD`, `DEV`, `PEER`, `OPTIONAL`, `GROUP`), `DepsUpdateMode`, `DepsUpdateLevel`
(`PATCH`, `MINOR`, `MAJOR`), `DepsGroupMode`, `DepsRangeStrategy` (`BUMP`, `LOCKFILE_ONLY`), `DepsScanStatus`,
`DependencyUpdateStatus` (`OUTDATED`, `TOO_NEW`, `ABOVE_LEVEL`, `BLOCKED_BY_RANGE`, `IGNORED`, `DISMISSED`,
`UNSUPPORTED_SOURCE`), `DepsPrState`. `apps/web/src/lib/dependency-settings.ts` and `lib/notification-events.ts`
mirror them as string unions for client code.

## Semantics to preserve

- **Visibility** (`visibleReleasesWhere`, `apps/web/src/server/queries/feed.ts`): a user sees a release when
  `isDraft = false`, they subscribe to its repository, it is not a pre-release (unless the subscription has
  `includePrereleases`), and its source fits the subscription's mode: `RELEASE` in `RELEASES` and
  `TAGS_AND_COMMITS`, `TAG` in `TAGS_AND_COMMITS`, `COMMIT` with `trackPaths` **and only with a `UserReleaseState` row** for
  the user (commit rows are shared; the state row records that the commit matched the user's own watched paths).
- **Unread**: rows are created only for genuinely new releases. On add, the initial 10 releases are unread. On a poll,
  only inserts published after the newest stored release (`selectFreshReleases`). Backfill and the extra releases of a
  first poll stay read.
- **Tag promotion**: when a GitHub Release appears for a tag already stored as `source = TAG`, the row is updated in
  place (one entry). `TAGS_AND_COMMITS` subscribers keep their read state and get no second notification.
- **Commit states follow watched paths** (`apps/web/src/server/commit-states.ts`): adding a repository with `trackPaths`,
  turning it on or changing the paths drops the user's states of commits that no longer match and seeds matching stored commits
  (newest 10 unread, older read). Matching: a changed path equals a watched path or lies inside it (`commitMatchesPath`).
- **Per-subscription notification settings** (Slice 07, worker `fan-out.ts` → `mayNotify`, re-checked by the
  notification processor): while `snoozedUntil > now`, or when the release is below `notificationLevel`
  (`MINOR_AND_UP` skips `PATCH` / `PRERELEASE` / `OTHER` and anything flagged pre-release, `MAJOR_ONLY` keeps `MAJOR`,
  `NONE` skips all; commits are `OTHER`), no notification job is queued. Unread states and SSE events are unaffected,
  and a snooze is not retroactive. All per user: another subscriber of the same repository is unaffected.
- **Pre-releases toggled after adding** (`updateSubscriptionSettingsAction`): on → the stored pre-releases among the 10
  newest visible items get unread states; off → the user's unread states of pre-release rows of the repository are
  deleted.
- **Read cursor**: the feed pages by keyset `(publishedAt, id)` (`encodeFeedCursor` / `afterCursorWhere`).
- **Notification events** (Slice 08): the release fan-out (`ruleMatches`) and the notification processor require
  `RELEASES` in `events`; `deps-worker` queues dependency jobs only for enabled, untagged rules with
  `DEPENDENCY_UPDATES` / `DEPENDENCY_PULL_REQUESTS`. Existing rules got `[RELEASES]`, so they behave as before.
- **Dependency projects are separate from subscriptions**: removing either never touches the other. Dependency
  updates are not `Release` rows and never reach the feed or the unread counters.
- **One PR owner per GitHub repository** (`DependencyPrOwner`): only the owning project may open PRs. It is claimed
  when a project switches to a PR mode and released by `NOTIFY`, by removing the project (cascade) or when a scan or
  `deps-update` finds that the owner lost access.
- **`notifiedAt` follows `targetVersion`**: a scan keeps `firstSeenAt` / `notifiedAt` while the target is unchanged and
  resets both when it changes, so a digest mentions each target version once. Digest rows get `notifiedAt` in the
  same transaction that stores `DependencyNotificationOutbox` intents. A dispatcher retries enqueueing every five
  seconds and deletes intents only after BullMQ acknowledges their deterministic job ids. The first scan marks rows notified without sending,
  unless `notifyOnFirstScan`.
- **Closed PR → `DISMISSED`**: the rows of a PR closed without merging stay `DISMISSED` for that version; a newer target
  makes them `OUTDATED` again. A PR whose branch head is neither `headSha` nor a pending
  `DependencyBranchWriteIntent.commitSha` / `previousHeadSha` is `EDITED` and never touched again.

Version 0.9.4 adds `DependencyBranchWriteIntent` (prepared and previous bot SHAs per project/group) and
`DependencyNotificationOutbox` (JSON queue payloads keyed by deterministic job id). Both cascade when their project
is removed. Migrations: `20261103130000_dependency_branch_write_intents` and
`20261103131000_dependency_notification_outbox`.

## Migrations

Workflow (dev DB from `pnpm services:up`):

```sh
# 1. edit packages/db/prisma/schema.prisma
cd packages/db
npx prisma migrate dev --create-only --name your_change   # or write migration.sql by hand
# 2. review packages/db/prisma/migrations/<ts>_your_change/migration.sql (renames, data backfills, defaults)
npx prisma migrate deploy && npx prisma generate
npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script   # must be empty
cd ../.. && pnpm --filter "./packages/*" build && pnpm typecheck && pnpm test
```

In production the `migrator` service runs `prisma migrate deploy` before `web`, `worker` and `deps-worker` start
([deployment.md](./deployment.md)). Mention every new migration in `CHANGELOG.md`.

## Client usage

```ts
import { prisma, encryptToken, decryptToken, loadSmtpSettings, INSTANCE_SETTINGS_ID, type User } from "@repopulse/db";
import { loadDepsEnabled, loadGitHubAppSettings } from "@repopulse/db"; // Dependencies module (Slice 08)
```

- `prisma` is a singleton (cached on `globalThis` outside production because of HMR). Don't create new clients.
- `prisma.config.ts` loads the root `.env` outside production. Prisma 7 does not read `.env` files by itself.
- Generated types such as `Prisma.ReleaseWhereInput` come from `@repopulse/db` too. Client components must not
  import `@repopulse/db`: use local string unions (e.g. `SEMVER_TYPES` in `apps/web/src/lib/feed-filters.ts`).

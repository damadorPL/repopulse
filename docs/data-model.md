# Data model

> **Summary:** PostgreSQL 16 through Prisma 7. The schema is `packages/db/prisma/schema.prisma`, migrations are in
> `packages/db/prisma/migrations/`, and the client is generated into `packages/db/src/generated/prisma` (git-ignored)
> and exported from `@repopulse/db`.

## Rules

- **MUST** add a new migration folder for every schema change: `YYYYMMDDHHMMSS_snake_name/migration.sql`.
- **MUST NOT** edit or delete a migration that has shipped. Released migrations so far: `20261031000000_init`,
  `20261031120000_release_backfill`, `20261101090000_tag_tracking`, `20261101120000_invites_registration`,
  `20261101150000_super_admin_smtp_settings` and `20261101180000_path_tracking`.
- **MUST** keep the migration and the schema identical. Check with
  `cd packages/db && npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script`
  against a migrated dev DB. The output must be `-- This is an empty migration.`
- **MUST** use renames (`ALTER TABLE … RENAME COLUMN`) instead of drop + add when renaming, so data is kept.
- Use `INSTANCE_SETTINGS_ID` (`1`) rather than a literal when touching `InstanceSettings`.

## Models

| Model | Scope | Key fields and invariants |
| --- | --- | --- |
| `User` | per person | `githubId` unique (the identity), `email` unique, `githubAccessTokenEncrypted` (AES-GCM, `iv:tag:cipher` hex), `isSuperAdmin` (the first account; see [auth-and-access.md](./auth-and-access.md)) |
| `InstanceSettings` | instance, one row `id = 1` | `publicRegistration` (default `true`); SMTP: `smtpHost` (null = email off), `smtpPort` (587), `smtpSecure` (null = auto), `smtpUser`, `smtpPasswordEncrypted`, `smtpFrom`. A missing row means defaults, so always `upsert` |
| `Invite` | instance | `tokenHash` unique (SHA-256 of the raw token; the token itself is never stored), `expiresAt`, `usedAt`/`usedById` (unique: one invite per account), `createdById` (cascade) |
| `Repository` | shared | `githubRepoId` unique (immutable; survives renames), `fullName` unique, `lastEtag`, `lastPolledAt`, `pollStatus` (`IDLE`/`POLLING`/`ERROR`), `errorCount`; backfill: `backfillStatus`, `backfillNextPage`, `backfillTarget` (100), `backfilledAt`, `backfillRequestedAt`; `lastTagsPolledAt`; `lastPathsPolledAt`, `polledPaths` (watched paths whose initial import is done; exactly the paths watched at the last path poll, cleared when nobody watches paths) |
| `Release` | shared | unique `(repositoryId, githubReleaseId)` and `(repositoryId, source, tagName)`; `source` `RELEASE`/`TAG`/`COMMIT`; `githubReleaseId` null for tag and commit rows; `tagSha` for tag rows (tagged commit) and commit rows (full SHA, `tagName` = 7-char short SHA); `changedPaths` for commit rows (changed files plus the watched paths the commit was found through); `semverType`; `isDraft` (never ingested as true) |
| `UserSubscription` | per user | unique `(userId, repositoryId)`, `includePrereleases`, `trackMode` (`RELEASES` / `TAGS_AND_COMMITS` / `PATHS`), `watchedPaths` (normalized, at most 10; kept when switching to another mode) |
| `Tag` | per user | unique `(userId, slug)`, `colorHex` `#RRGGBB` |
| `SubscriptionTag` | per user | join of subscription ↔ tag (both cascade) |
| `UserReleaseState` | per user | PK `(userId, releaseId)`, `isRead`, `readAt`. **No row = read** |
| `NotificationRule` | per user | `channel`, `destinationUrl` (webhook URL or optional email recipient), `tagId` (null = all repositories; `SetNull` on tag delete), `onlyMajorReleases`, `enabled`. Max 25 per user (`MAX_NOTIFICATION_RULES`) |

Enums: `PollStatus`, `SemverType` (`MAJOR`, `MINOR`, `PATCH`, `PRERELEASE`, `OTHER`), `TrackMode`, `ReleaseSource`,
`BackfillStatus` (`NONE`, `QUEUED`, `RUNNING`, `DONE`, `PARTIAL`, `ERROR`), `NotificationChannel` (`IN_APP`,
`EMAIL_INSTANT`, `EMAIL_DIGEST`, `DISCORD_WEBHOOK`, `SLACK_WEBHOOK`, `NTFY_WEBHOOK`, `GOTIFY_WEBHOOK`,
`CUSTOM_WEBHOOK`). `IN_APP` and `EMAIL_DIGEST` are never dispatched: in-app is the unread state itself, and digests
are not built yet.

## Semantics to preserve

- **Visibility** (`visibleReleasesWhere`, `apps/web/src/server/queries/feed.ts`): a user sees a release when
  `isDraft = false`, they subscribe to its repository, it is not a pre-release (unless the subscription has
  `includePrereleases`), and its source fits the subscription's mode: `RELEASE` in `RELEASES` and
  `TAGS_AND_COMMITS`, `TAG` in `TAGS_AND_COMMITS`, `COMMIT` in `PATHS` **and only with a `UserReleaseState` row** for
  the user (commit rows are shared; the state row records that the commit matched the user's own watched paths).
- **Unread**: rows are created only for genuinely new releases. On add, the initial 10 releases are unread. On a poll,
  only inserts published after the newest stored release (`selectFreshReleases`). Backfill and the extra releases of a
  first poll stay read.
- **Tag promotion**: when a GitHub Release appears for a tag already stored as `source = TAG`, the row is updated in
  place (one entry). `TAGS_AND_COMMITS` subscribers keep their read state and get no second notification.
- **Commit states follow watched paths** (`apps/web/src/server/commit-states.ts`): adding a repository in `PATHS` mode
  or changing the paths drops the user's states of commits that no longer match and seeds matching stored commits
  (newest 10 unread, older read). Matching: a changed path equals a watched path or lies inside it (`commitMatchesPath`).
- **Read cursor**: the feed pages by keyset `(publishedAt, id)` (`encodeFeedCursor` / `afterCursorWhere`).

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

In production the `migrator` service runs `prisma migrate deploy` before `web` and `worker` start
([deployment.md](./deployment.md)). Mention every new migration in `CHANGELOG.md`.

## Client usage

```ts
import { prisma, encryptToken, decryptToken, loadSmtpSettings, INSTANCE_SETTINGS_ID, type User } from "@repopulse/db";
```

- `prisma` is a singleton (cached on `globalThis` outside production because of HMR). Don't create new clients.
- `prisma.config.ts` loads the root `.env` outside production. Prisma 7 does not read `.env` files by itself.
- Generated types such as `Prisma.ReleaseWhereInput` come from `@repopulse/db` too. Client components must not
  import `@repopulse/db`: use local string unions (e.g. `SEMVER_TYPES` in `apps/web/src/lib/feed-filters.ts`).

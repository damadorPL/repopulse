-- PostgreSQL best-practices migration:
-- 1. Drop dead & redundant indexes.
-- 2. Widen githubRepoId to BIGINT and convert all TIMESTAMP(3) columns to TIMESTAMPTZ(3).
-- 3. Add Release.searchVector stored generated tsvector + GIN index.
-- 4. Add composite/partial worker & outbox indexes and extended statistics.
-- 5. Configure fillfactor / autovacuum storage parameters and domain CHECK constraints.

-- ---------------------------------------------------------------------------
-- 1. Drop dead & redundant indexes
-- ---------------------------------------------------------------------------

DROP INDEX IF EXISTS "Repository_fullName_lower_idx";
DROP INDEX IF EXISTS "DependencyProject_userId_fullName_lower_idx";
DROP INDEX IF EXISTS "Release_bodyMarkdown_idx";
DROP INDEX IF EXISTS "Tag_name_idx";
DROP INDEX IF EXISTS "Release_repositoryId_publishedAt_idx";
DROP INDEX IF EXISTS "Release_publishedAt_id_idx";
DROP INDEX IF EXISTS "UserReleaseState_userId_isRead_idx";
DROP INDEX IF EXISTS "Repository_backfillStatus_idx";
DROP INDEX IF EXISTS "DependencyUpdate_projectId_outdated_idx";
DROP INDEX IF EXISTS "Repository_lastPolledAt_pollStatus_idx";
DROP INDEX IF EXISTS "DependencyProject_nextScanAt_scanStatus_idx";
DROP INDEX IF EXISTS "Release_repositoryId_source_publishedAt_idx";

-- ---------------------------------------------------------------------------
-- 2. Widen githubRepoId to BIGINT & convert TIMESTAMP(3) to TIMESTAMPTZ(3)
-- ---------------------------------------------------------------------------

ALTER TABLE "User"
  ALTER COLUMN "createdAt" TYPE TIMESTAMPTZ(3) USING "createdAt" AT TIME ZONE 'UTC',
  ALTER COLUMN "updatedAt" TYPE TIMESTAMPTZ(3) USING "updatedAt" AT TIME ZONE 'UTC';

ALTER TABLE "Session"
  ALTER COLUMN "expiresAt" TYPE TIMESTAMPTZ(3) USING "expiresAt" AT TIME ZONE 'UTC',
  ALTER COLUMN "createdAt" TYPE TIMESTAMPTZ(3) USING "createdAt" AT TIME ZONE 'UTC',
  ALTER COLUMN "updatedAt" TYPE TIMESTAMPTZ(3) USING "updatedAt" AT TIME ZONE 'UTC';

ALTER TABLE "Account"
  ALTER COLUMN "accessTokenExpiresAt" TYPE TIMESTAMPTZ(3) USING "accessTokenExpiresAt" AT TIME ZONE 'UTC',
  ALTER COLUMN "refreshTokenExpiresAt" TYPE TIMESTAMPTZ(3) USING "refreshTokenExpiresAt" AT TIME ZONE 'UTC',
  ALTER COLUMN "createdAt" TYPE TIMESTAMPTZ(3) USING "createdAt" AT TIME ZONE 'UTC',
  ALTER COLUMN "updatedAt" TYPE TIMESTAMPTZ(3) USING "updatedAt" AT TIME ZONE 'UTC';

ALTER TABLE "Verification"
  ALTER COLUMN "expiresAt" TYPE TIMESTAMPTZ(3) USING "expiresAt" AT TIME ZONE 'UTC',
  ALTER COLUMN "createdAt" TYPE TIMESTAMPTZ(3) USING "createdAt" AT TIME ZONE 'UTC',
  ALTER COLUMN "updatedAt" TYPE TIMESTAMPTZ(3) USING "updatedAt" AT TIME ZONE 'UTC';

ALTER TABLE "InstanceSettings"
  ALTER COLUMN "updatedAt" TYPE TIMESTAMPTZ(3) USING "updatedAt" AT TIME ZONE 'UTC';

ALTER TABLE "Invite"
  ALTER COLUMN "expiresAt" TYPE TIMESTAMPTZ(3) USING "expiresAt" AT TIME ZONE 'UTC',
  ALTER COLUMN "usedAt" TYPE TIMESTAMPTZ(3) USING "usedAt" AT TIME ZONE 'UTC',
  ALTER COLUMN "createdAt" TYPE TIMESTAMPTZ(3) USING "createdAt" AT TIME ZONE 'UTC';

ALTER TABLE "Repository"
  ALTER COLUMN "githubRepoId" TYPE BIGINT,
  ALTER COLUMN "lastPolledAt" TYPE TIMESTAMPTZ(3) USING "lastPolledAt" AT TIME ZONE 'UTC',
  ALTER COLUMN "backfilledAt" TYPE TIMESTAMPTZ(3) USING "backfilledAt" AT TIME ZONE 'UTC',
  ALTER COLUMN "backfillRequestedAt" TYPE TIMESTAMPTZ(3) USING "backfillRequestedAt" AT TIME ZONE 'UTC',
  ALTER COLUMN "lastTagsPolledAt" TYPE TIMESTAMPTZ(3) USING "lastTagsPolledAt" AT TIME ZONE 'UTC',
  ALTER COLUMN "lastPathsPolledAt" TYPE TIMESTAMPTZ(3) USING "lastPathsPolledAt" AT TIME ZONE 'UTC',
  ALTER COLUMN "createdAt" TYPE TIMESTAMPTZ(3) USING "createdAt" AT TIME ZONE 'UTC',
  ALTER COLUMN "updatedAt" TYPE TIMESTAMPTZ(3) USING "updatedAt" AT TIME ZONE 'UTC';

ALTER TABLE "Release"
  ALTER COLUMN "publishedAt" TYPE TIMESTAMPTZ(3) USING "publishedAt" AT TIME ZONE 'UTC',
  ALTER COLUMN "discoveredAt" TYPE TIMESTAMPTZ(3) USING "discoveredAt" AT TIME ZONE 'UTC',
  ADD COLUMN "searchVector" tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', coalesce("tagName", '')), 'A') ||
    setweight(to_tsvector('english', coalesce("title", '')), 'B') ||
    setweight(to_tsvector('english', coalesce("bodyMarkdown", '')), 'C')
  ) STORED;

ALTER TABLE "UserSubscription"
  ALTER COLUMN "snoozedUntil" TYPE TIMESTAMPTZ(3) USING "snoozedUntil" AT TIME ZONE 'UTC',
  ALTER COLUMN "createdAt" TYPE TIMESTAMPTZ(3) USING "createdAt" AT TIME ZONE 'UTC';

ALTER TABLE "UserReleaseState"
  ALTER COLUMN "readAt" TYPE TIMESTAMPTZ(3) USING "readAt" AT TIME ZONE 'UTC';

ALTER TABLE "NotificationRule"
  ALTER COLUMN "createdAt" TYPE TIMESTAMPTZ(3) USING "createdAt" AT TIME ZONE 'UTC';

ALTER TABLE "DependencyProject"
  ALTER COLUMN "githubRepoId" TYPE BIGINT,
  ALTER COLUMN "lastScannedAt" TYPE TIMESTAMPTZ(3) USING "lastScannedAt" AT TIME ZONE 'UTC',
  ALTER COLUMN "nextScanAt" TYPE TIMESTAMPTZ(3) USING "nextScanAt" AT TIME ZONE 'UTC',
  ALTER COLUMN "createdAt" TYPE TIMESTAMPTZ(3) USING "createdAt" AT TIME ZONE 'UTC',
  ALTER COLUMN "updatedAt" TYPE TIMESTAMPTZ(3) USING "updatedAt" AT TIME ZONE 'UTC';

ALTER TABLE "DependencyBranchWriteIntent"
  ALTER COLUMN "createdAt" TYPE TIMESTAMPTZ(3) USING "createdAt" AT TIME ZONE 'UTC';

ALTER TABLE "DependencyUpdate"
  ALTER COLUMN "targetReleasedAt" TYPE TIMESTAMPTZ(3) USING "targetReleasedAt" AT TIME ZONE 'UTC',
  ALTER COLUMN "firstSeenAt" TYPE TIMESTAMPTZ(3) USING "firstSeenAt" AT TIME ZONE 'UTC',
  ALTER COLUMN "notifiedAt" TYPE TIMESTAMPTZ(3) USING "notifiedAt" AT TIME ZONE 'UTC';

ALTER TABLE "DependencyPullRequest"
  ALTER COLUMN "openedAt" TYPE TIMESTAMPTZ(3) USING "openedAt" AT TIME ZONE 'UTC',
  ALTER COLUMN "updatedAt" TYPE TIMESTAMPTZ(3) USING "updatedAt" AT TIME ZONE 'UTC',
  ALTER COLUMN "closedAt" TYPE TIMESTAMPTZ(3) USING "closedAt" AT TIME ZONE 'UTC';

ALTER TABLE "DependencyPrOwner"
  ALTER COLUMN "githubRepoId" TYPE BIGINT;

ALTER TABLE "DependencyNotificationOutbox"
  ALTER COLUMN "createdAt" TYPE TIMESTAMPTZ(3) USING "createdAt" AT TIME ZONE 'UTC';

-- ---------------------------------------------------------------------------
-- 3. New / fixed indexes
-- ---------------------------------------------------------------------------

CREATE INDEX "Release_searchVector_idx"
  ON "Release" USING GIN ("searchVector");

CREATE INDEX "Release_repositoryId_source_publishedAt_id_idx"
  ON "Release" ("repositoryId", "source", "publishedAt" DESC, "id" DESC);

CREATE INDEX "Repository_pollStatus_lastPolledAt_idx"
  ON "Repository" ("pollStatus", "lastPolledAt" ASC NULLS FIRST);

CREATE INDEX "Repository_polling_updatedAt_idx"
  ON "Repository" ("updatedAt" ASC)
  WHERE "pollStatus" = 'POLLING';

CREATE INDEX "DependencyProject_due_nextScanAt_id_idx"
  ON "DependencyProject" ("nextScanAt" ASC NULLS FIRST, "id" ASC)
  WHERE "scanStatus" <> 'SCANNING';

CREATE INDEX "DependencyProject_scanning_updatedAt_idx"
  ON "DependencyProject" ("updatedAt" ASC)
  WHERE "scanStatus" = 'SCANNING';

CREATE INDEX "DependencyBranchWriteIntent_createdAt_idx"
  ON "DependencyBranchWriteIntent" ("createdAt");

-- ---------------------------------------------------------------------------
-- 4. Extended Statistics
-- ---------------------------------------------------------------------------

CREATE STATISTICS IF NOT EXISTS "Release_visibility_stats" (dependencies, ndistinct, mcv)
  ON "repositoryId", "source", "isPrerelease", "isDraft"
  FROM "Release";

-- ---------------------------------------------------------------------------
-- 5. HOT & Autovacuum Storage Parameters
-- ---------------------------------------------------------------------------

ALTER TABLE "Repository" SET (fillfactor = 80);
ALTER TABLE "DependencyProject" SET (fillfactor = 80);
ALTER TABLE "Release" SET (fillfactor = 90);
ALTER TABLE "DependencyNotificationOutbox" SET (autovacuum_vacuum_scale_factor = 0.05, autovacuum_vacuum_threshold = 50);

-- ---------------------------------------------------------------------------
-- 6. Domain CHECK Constraints
-- ---------------------------------------------------------------------------

ALTER TABLE "InstanceSettings"
  ADD CONSTRAINT "InstanceSettings_id_check" CHECK ("id" = 1),
  ADD CONSTRAINT "InstanceSettings_smtpPort_check" CHECK ("smtpPort" BETWEEN 1 AND 65535);

ALTER TABLE "Repository"
  ADD CONSTRAINT "Repository_starsCount_check" CHECK ("starsCount" >= 0),
  ADD CONSTRAINT "Repository_errorCount_check" CHECK ("errorCount" >= 0),
  ADD CONSTRAINT "Repository_backfillTarget_check" CHECK ("backfillTarget" > 0);

ALTER TABLE "DependencyProject"
  ADD CONSTRAINT "DependencyProject_minReleaseAgeDays_check" CHECK ("minReleaseAgeDays" BETWEEN 0 AND 30),
  ADD CONSTRAINT "DependencyProject_maxOpenPrs_check" CHECK ("maxOpenPrs" BETWEEN 1 AND 20),
  ADD CONSTRAINT "DependencyProject_scanIntervalHours_check" CHECK ("scanIntervalHours" IN (6, 12, 24, 168)),
  ADD CONSTRAINT "DependencyProject_errorCount_check" CHECK ("errorCount" >= 0),
  ADD CONSTRAINT "DependencyProject_ignoreRules_check" CHECK (jsonb_typeof("ignoreRules") = 'array' AND jsonb_array_length("ignoreRules") <= 50);

ALTER TABLE "DependencyManifest"
  ADD CONSTRAINT "DependencyManifest_dependencyCount_check" CHECK ("dependencyCount" >= 0);

ALTER TABLE "DependencyNotificationOutbox"
  ADD CONSTRAINT "DependencyNotificationOutbox_payload_check" CHECK (jsonb_typeof("payload") = 'object');

ALTER TABLE "Invite"
  ADD CONSTRAINT "Invite_expiresAt_check" CHECK ("expiresAt" > "createdAt");

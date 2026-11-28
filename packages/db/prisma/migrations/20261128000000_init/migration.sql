-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- CreateEnum
CREATE TYPE "PollStatus" AS ENUM ('IDLE', 'POLLING', 'ERROR');

-- CreateEnum
CREATE TYPE "SemverType" AS ENUM ('MAJOR', 'MINOR', 'PATCH', 'PRERELEASE', 'OTHER');

-- CreateEnum
CREATE TYPE "TrackMode" AS ENUM ('RELEASES', 'TAGS_AND_COMMITS', 'NONE');

-- CreateEnum
CREATE TYPE "ReleaseSource" AS ENUM ('RELEASE', 'TAG', 'COMMIT');

-- CreateEnum
CREATE TYPE "BackfillStatus" AS ENUM ('NONE', 'QUEUED', 'RUNNING', 'DONE', 'PARTIAL', 'ERROR');

-- CreateEnum
CREATE TYPE "NotificationLevel" AS ENUM ('ALL', 'MINOR_AND_UP', 'MAJOR_ONLY', 'NONE');

-- CreateEnum
CREATE TYPE "NotificationEvent" AS ENUM ('RELEASES', 'DEPENDENCY_UPDATES', 'DEPENDENCY_PULL_REQUESTS');

-- CreateEnum
CREATE TYPE "NotificationChannel" AS ENUM ('IN_APP', 'EMAIL_INSTANT', 'EMAIL_DIGEST', 'DISCORD_WEBHOOK', 'SLACK_WEBHOOK', 'NTFY_WEBHOOK', 'GOTIFY_WEBHOOK', 'CUSTOM_WEBHOOK');

-- CreateEnum
CREATE TYPE "DependencyEcosystem" AS ENUM ('NPM', 'PYPI');

-- CreateEnum
CREATE TYPE "PackageManager" AS ENUM ('NPM', 'PNPM', 'BUN', 'YARN', 'PIP', 'PIP_TOOLS', 'UV', 'POETRY', 'NONE');

-- CreateEnum
CREATE TYPE "DependencyKind" AS ENUM ('PROD', 'DEV', 'PEER', 'OPTIONAL', 'GROUP');

-- CreateEnum
CREATE TYPE "DepsUpdateMode" AS ENUM ('NOTIFY', 'MANUAL_PR', 'AUTO_PR');

-- CreateEnum
CREATE TYPE "DepsUpdateLevel" AS ENUM ('PATCH', 'MINOR', 'MAJOR');

-- CreateEnum
CREATE TYPE "DepsGroupMode" AS ENUM ('SINGLE', 'SEPARATE_MAJORS', 'PER_DEPENDENCY');

-- CreateEnum
CREATE TYPE "DepsRangeStrategy" AS ENUM ('BUMP', 'LOCKFILE_ONLY');

-- CreateEnum
CREATE TYPE "DepsScanStatus" AS ENUM ('IDLE', 'QUEUED', 'SCANNING', 'ERROR');

-- CreateEnum
CREATE TYPE "DependencyUpdateStatus" AS ENUM ('OUTDATED', 'TOO_NEW', 'ABOVE_LEVEL', 'BLOCKED_BY_RANGE', 'IGNORED', 'DISMISSED', 'UNSUPPORTED_SOURCE');

-- CreateEnum
CREATE TYPE "DepsPrState" AS ENUM ('OPEN', 'MERGED', 'CLOSED', 'EDITED');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "emailVerified" BOOLEAN NOT NULL DEFAULT false,
    "name" TEXT,
    "avatarUrl" TEXT,
    "githubId" TEXT NOT NULL,
    "githubAccessTokenEncrypted" TEXT,
    "githubLogin" TEXT,
    "isSuperAdmin" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "token" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "userId" TEXT NOT NULL,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Account" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "accessToken" TEXT,
    "refreshToken" TEXT,
    "idToken" TEXT,
    "accessTokenExpiresAt" TIMESTAMPTZ(3),
    "refreshTokenExpiresAt" TIMESTAMPTZ(3),
    "scope" TEXT,
    "password" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Verification" (
    "id" TEXT NOT NULL,
    "identifier" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Verification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InstanceSettings" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "publicRegistration" BOOLEAN NOT NULL DEFAULT true,
    "smtpHost" TEXT,
    "smtpPort" INTEGER NOT NULL DEFAULT 587,
    "smtpSecure" BOOLEAN,
    "smtpUser" TEXT,
    "smtpPasswordEncrypted" TEXT,
    "smtpFrom" TEXT,
    "backfillDefaultTarget" INTEGER,
    "backfillMaxAgeDays" INTEGER,
    "backfillHardCap" INTEGER,
    "backfillMinQuota" INTEGER,
    "backfillDeepStep" INTEGER,
    "backfillDeepCooldownMinutes" INTEGER,
    "depsEnabled" BOOLEAN NOT NULL DEFAULT false,
    "githubAppId" INTEGER,
    "githubAppSlug" TEXT,
    "githubAppClientId" TEXT,
    "githubAppPrivateKeyEncrypted" TEXT,
    "githubAppWebhookSecretEncrypted" TEXT,
    "githubAppOwner" TEXT,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "InstanceSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Invite" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "note" TEXT,
    "createdById" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "usedAt" TIMESTAMPTZ(3),
    "usedById" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Invite_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Repository" (
    "id" TEXT NOT NULL,
    "githubRepoId" BIGINT NOT NULL,
    "owner" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "description" TEXT,
    "avatarUrl" TEXT,
    "htmlUrl" TEXT NOT NULL,
    "starsCount" INTEGER NOT NULL DEFAULT 0,
    "lastPolledAt" TIMESTAMPTZ(3),
    "lastEtag" TEXT,
    "pollStatus" "PollStatus" NOT NULL DEFAULT 'IDLE',
    "errorCount" INTEGER NOT NULL DEFAULT 0,
    "backfillStatus" "BackfillStatus" NOT NULL DEFAULT 'NONE',
    "backfillNextPage" INTEGER,
    "backfillTarget" INTEGER NOT NULL DEFAULT 100,
    "backfilledAt" TIMESTAMPTZ(3),
    "backfillRequestedAt" TIMESTAMPTZ(3),
    "lastTagsPolledAt" TIMESTAMPTZ(3),
    "lastPathsPolledAt" TIMESTAMPTZ(3),
    "polledPaths" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Repository_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Release" (
    "id" TEXT NOT NULL,
    "repositoryId" TEXT NOT NULL,
    "githubReleaseId" BIGINT,
    "source" "ReleaseSource" NOT NULL DEFAULT 'RELEASE',
    "tagSha" TEXT,
    "tagName" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "bodyMarkdown" TEXT NOT NULL,
    "searchVector" tsvector GENERATED ALWAYS AS (
        setweight(to_tsvector('simple', coalesce("tagName", '')), 'A') ||
        setweight(to_tsvector('english', coalesce("title", '')), 'B') ||
        setweight(to_tsvector('english', coalesce("bodyMarkdown", '')), 'C')
    ) STORED,
    "htmlUrl" TEXT NOT NULL,
    "isPrerelease" BOOLEAN NOT NULL DEFAULT false,
    "isDraft" BOOLEAN NOT NULL DEFAULT false,
    "semverType" "SemverType" NOT NULL DEFAULT 'OTHER',
    "publishedAt" TIMESTAMPTZ(3) NOT NULL,
    "discoveredAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "changedPaths" TEXT[] DEFAULT ARRAY[]::TEXT[],

    CONSTRAINT "Release_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserSubscription" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "repositoryId" TEXT NOT NULL,
    "includePrereleases" BOOLEAN NOT NULL DEFAULT false,
    "trackMode" "TrackMode" NOT NULL DEFAULT 'RELEASES',
    "trackPaths" BOOLEAN NOT NULL DEFAULT false,
    "watchedPaths" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "isPinned" BOOLEAN NOT NULL DEFAULT false,
    "note" TEXT,
    "notificationLevel" "NotificationLevel" NOT NULL DEFAULT 'ALL',
    "snoozedUntil" TIMESTAMPTZ(3),
    "currentVersion" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Tag" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "colorHex" TEXT NOT NULL DEFAULT '#3B82F6',

    CONSTRAINT "Tag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SubscriptionTag" (
    "subscriptionId" TEXT NOT NULL,
    "tagId" TEXT NOT NULL,

    CONSTRAINT "SubscriptionTag_pkey" PRIMARY KEY ("subscriptionId","tagId")
);

-- CreateTable
CREATE TABLE "UserReleaseState" (
    "userId" TEXT NOT NULL,
    "releaseId" TEXT NOT NULL,
    "isRead" BOOLEAN NOT NULL DEFAULT false,
    "readAt" TIMESTAMPTZ(3),

    CONSTRAINT "UserReleaseState_pkey" PRIMARY KEY ("userId","releaseId")
);

-- CreateTable
CREATE TABLE "NotificationRule" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tagId" TEXT,
    "channel" "NotificationChannel" NOT NULL,
    "destinationUrl" TEXT,
    "onlyMajorReleases" BOOLEAN NOT NULL DEFAULT false,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "events" "NotificationEvent"[] DEFAULT ARRAY['RELEASES']::"NotificationEvent"[],
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NotificationRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DependencyProject" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "githubRepoId" BIGINT NOT NULL,
    "owner" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "defaultBranch" TEXT NOT NULL,
    "isPrivate" BOOLEAN NOT NULL DEFAULT false,
    "repositoryId" TEXT,
    "updateMode" "DepsUpdateMode" NOT NULL DEFAULT 'NOTIFY',
    "maxUpdateLevel" "DepsUpdateLevel" NOT NULL DEFAULT 'MINOR',
    "includePrereleases" BOOLEAN NOT NULL DEFAULT false,
    "minReleaseAgeDays" INTEGER NOT NULL DEFAULT 3,
    "groupMode" "DepsGroupMode" NOT NULL DEFAULT 'SEPARATE_MAJORS',
    "rangeStrategy" "DepsRangeStrategy" NOT NULL DEFAULT 'BUMP',
    "maxOpenPrs" INTEGER NOT NULL DEFAULT 5,
    "scanIntervalHours" INTEGER NOT NULL DEFAULT 24,
    "notificationLevel" "NotificationLevel" NOT NULL DEFAULT 'MINOR_AND_UP',
    "ignoreRules" JSONB NOT NULL DEFAULT '[]',
    "manifestPaths" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "commitPrefix" TEXT NOT NULL DEFAULT 'chore(deps):',
    "notifyOnFirstScan" BOOLEAN NOT NULL DEFAULT false,
    "lastScannedAt" TIMESTAMPTZ(3),
    "lastScannedSha" TEXT,
    "nextScanAt" TIMESTAMPTZ(3),
    "scanStatus" "DepsScanStatus" NOT NULL DEFAULT 'IDLE',
    "scanError" TEXT,
    "errorCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "DependencyProject_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DependencyBranchWriteIntent" (
    "projectId" TEXT NOT NULL,
    "groupKey" TEXT NOT NULL,
    "commitSha" TEXT NOT NULL,
    "previousHeadSha" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DependencyBranchWriteIntent_pkey" PRIMARY KEY ("projectId","groupKey")
);

-- CreateTable
CREATE TABLE "DependencyManifest" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "ecosystem" "DependencyEcosystem" NOT NULL,
    "packageManager" "PackageManager" NOT NULL,
    "lockfilePath" TEXT,
    "workspaceRoot" TEXT,
    "blobSha" TEXT NOT NULL,
    "dependencyCount" INTEGER NOT NULL DEFAULT 0,
    "warnings" TEXT[] DEFAULT ARRAY[]::TEXT[],

    CONSTRAINT "DependencyManifest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DependencyUpdate" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "manifestId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "DependencyKind" NOT NULL,
    "group" TEXT NOT NULL DEFAULT '',
    "declared" TEXT NOT NULL,
    "currentVersion" TEXT,
    "wantedVersion" TEXT,
    "targetVersion" TEXT,
    "latestVersion" TEXT,
    "level" "SemverType",
    "status" "DependencyUpdateStatus" NOT NULL,
    "targetReleasedAt" TIMESTAMPTZ(3),
    "sourceRepoUrl" TEXT,
    "firstSeenAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notifiedAt" TIMESTAMPTZ(3),

    CONSTRAINT "DependencyUpdate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DependencyPullRequest" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "groupKey" TEXT NOT NULL,
    "branch" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "htmlUrl" TEXT NOT NULL,
    "state" "DepsPrState" NOT NULL DEFAULT 'OPEN',
    "headSha" TEXT NOT NULL,
    "targets" TEXT[],
    "openedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "closedAt" TIMESTAMPTZ(3),

    CONSTRAINT "DependencyPullRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DependencyPrOwner" (
    "githubRepoId" BIGINT NOT NULL,
    "projectId" TEXT NOT NULL,

    CONSTRAINT "DependencyPrOwner_pkey" PRIMARY KEY ("githubRepoId")
);

-- CreateTable
CREATE TABLE "DependencyNotificationOutbox" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DependencyNotificationOutbox_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "User_githubId_key" ON "User"("githubId");

-- CreateIndex
CREATE UNIQUE INDEX "Session_token_key" ON "Session"("token");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE INDEX "Session_expiresAt_idx" ON "Session"("expiresAt");

-- CreateIndex
CREATE INDEX "Account_userId_idx" ON "Account"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Account_providerId_accountId_key" ON "Account"("providerId", "accountId");

-- CreateIndex
CREATE INDEX "Verification_identifier_idx" ON "Verification"("identifier");

-- CreateIndex
CREATE INDEX "Verification_expiresAt_idx" ON "Verification"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "Invite_tokenHash_key" ON "Invite"("tokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "Invite_usedById_key" ON "Invite"("usedById");

-- CreateIndex
CREATE INDEX "Invite_createdAt_idx" ON "Invite"("createdAt" DESC);

-- CreateIndex
CREATE INDEX "Invite_createdById_idx" ON "Invite"("createdById");

-- CreateIndex
CREATE UNIQUE INDEX "Repository_githubRepoId_key" ON "Repository"("githubRepoId");

-- CreateIndex
CREATE UNIQUE INDEX "Repository_fullName_key" ON "Repository"("fullName");

-- CreateIndex
CREATE INDEX "Repository_fullName_idx" ON "Repository" USING GIN ("fullName" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "Release_repositoryId_source_publishedAt_id_idx" ON "Release"("repositoryId", "source", "publishedAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "Release_tagName_idx" ON "Release" USING GIN ("tagName" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "Release_title_idx" ON "Release" USING GIN ("title" gin_trgm_ops);

-- CreateIndex
CREATE UNIQUE INDEX "Release_repositoryId_githubReleaseId_key" ON "Release"("repositoryId", "githubReleaseId");

-- CreateIndex
CREATE UNIQUE INDEX "Release_repositoryId_source_tagName_key" ON "Release"("repositoryId", "source", "tagName");

-- CreateIndex
CREATE INDEX "UserSubscription_repositoryId_idx" ON "UserSubscription"("repositoryId");

-- CreateIndex
CREATE UNIQUE INDEX "UserSubscription_userId_repositoryId_key" ON "UserSubscription"("userId", "repositoryId");

-- CreateIndex
CREATE UNIQUE INDEX "Tag_userId_slug_key" ON "Tag"("userId", "slug");

-- CreateIndex
CREATE INDEX "SubscriptionTag_tagId_idx" ON "SubscriptionTag"("tagId");

-- CreateIndex
CREATE INDEX "UserReleaseState_releaseId_idx" ON "UserReleaseState"("releaseId");

-- CreateIndex
CREATE INDEX "NotificationRule_userId_enabled_idx" ON "NotificationRule"("userId", "enabled");

-- CreateIndex
CREATE INDEX "NotificationRule_tagId_idx" ON "NotificationRule"("tagId");

-- CreateIndex
CREATE INDEX "DependencyProject_githubRepoId_idx" ON "DependencyProject"("githubRepoId");

-- CreateIndex
CREATE INDEX "DependencyProject_repositoryId_idx" ON "DependencyProject"("repositoryId");

-- CreateIndex
CREATE UNIQUE INDEX "DependencyProject_userId_githubRepoId_key" ON "DependencyProject"("userId", "githubRepoId");

-- CreateIndex
CREATE INDEX "DependencyBranchWriteIntent_createdAt_idx" ON "DependencyBranchWriteIntent"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "DependencyManifest_projectId_path_key" ON "DependencyManifest"("projectId", "path");

-- CreateIndex
CREATE INDEX "DependencyUpdate_projectId_status_level_idx" ON "DependencyUpdate"("projectId", "status", "level");

-- CreateIndex
CREATE UNIQUE INDEX "DependencyUpdate_manifestId_name_kind_group_key" ON "DependencyUpdate"("manifestId", "name", "kind", "group");

-- CreateIndex
CREATE UNIQUE INDEX "DependencyPullRequest_projectId_groupKey_key" ON "DependencyPullRequest"("projectId", "groupKey");

-- CreateIndex
CREATE UNIQUE INDEX "DependencyPrOwner_projectId_key" ON "DependencyPrOwner"("projectId");

-- CreateIndex
CREATE INDEX "DependencyNotificationOutbox_createdAt_id_idx" ON "DependencyNotificationOutbox"("createdAt", "id");

-- CreateIndex
CREATE INDEX "DependencyNotificationOutbox_projectId_idx" ON "DependencyNotificationOutbox"("projectId");

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Account" ADD CONSTRAINT "Account_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invite" ADD CONSTRAINT "Invite_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invite" ADD CONSTRAINT "Invite_usedById_fkey" FOREIGN KEY ("usedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Release" ADD CONSTRAINT "Release_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "Repository"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserSubscription" ADD CONSTRAINT "UserSubscription_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserSubscription" ADD CONSTRAINT "UserSubscription_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "Repository"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Tag" ADD CONSTRAINT "Tag_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubscriptionTag" ADD CONSTRAINT "SubscriptionTag_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "UserSubscription"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubscriptionTag" ADD CONSTRAINT "SubscriptionTag_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "Tag"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserReleaseState" ADD CONSTRAINT "UserReleaseState_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserReleaseState" ADD CONSTRAINT "UserReleaseState_releaseId_fkey" FOREIGN KEY ("releaseId") REFERENCES "Release"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationRule" ADD CONSTRAINT "NotificationRule_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationRule" ADD CONSTRAINT "NotificationRule_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "Tag"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DependencyProject" ADD CONSTRAINT "DependencyProject_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DependencyProject" ADD CONSTRAINT "DependencyProject_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "Repository"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DependencyBranchWriteIntent" ADD CONSTRAINT "DependencyBranchWriteIntent_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "DependencyProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DependencyManifest" ADD CONSTRAINT "DependencyManifest_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "DependencyProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DependencyUpdate" ADD CONSTRAINT "DependencyUpdate_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "DependencyProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DependencyUpdate" ADD CONSTRAINT "DependencyUpdate_manifestId_fkey" FOREIGN KEY ("manifestId") REFERENCES "DependencyManifest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DependencyPullRequest" ADD CONSTRAINT "DependencyPullRequest_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "DependencyProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DependencyPrOwner" ADD CONSTRAINT "DependencyPrOwner_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "DependencyProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DependencyNotificationOutbox" ADD CONSTRAINT "DependencyNotificationOutbox_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "DependencyProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Custom partial, covering, GIN, and worker indexes (raw-SQL-managed)
CREATE INDEX "UserReleaseState_userId_unread_releaseId_idx"
  ON "UserReleaseState" ("userId", "releaseId")
  WHERE "isRead" = false;

CREATE INDEX "Release_visible_publishedAt_id_idx"
  ON "Release" ("publishedAt" DESC, "id" DESC)
  INCLUDE ("repositoryId", "source", "isPrerelease", "semverType")
  WHERE "isDraft" = false;

CREATE INDEX "Release_visible_repo_publishedAt_id_idx"
  ON "Release" ("repositoryId", "publishedAt" DESC, "id" DESC)
  INCLUDE ("source", "isPrerelease", "semverType")
  WHERE "isDraft" = false;

CREATE INDEX "Release_searchVector_idx"
  ON "Release" USING GIN ("searchVector");

CREATE INDEX "Repository_pollStatus_lastPolledAt_idx"
  ON "Repository" ("pollStatus", "lastPolledAt" ASC NULLS FIRST);

CREATE INDEX "Repository_polling_updatedAt_idx"
  ON "Repository" ("updatedAt" ASC)
  WHERE "pollStatus" = 'POLLING';

CREATE INDEX "Repository_backfill_pending_idx"
  ON "Repository" ("backfillStatus", "createdAt")
  WHERE "backfillStatus" IN ('NONE', 'QUEUED', 'RUNNING');

CREATE INDEX "DependencyProject_due_nextScanAt_id_idx"
  ON "DependencyProject" ("nextScanAt" ASC NULLS FIRST, "id" ASC)
  WHERE "scanStatus" <> 'SCANNING';

CREATE INDEX "DependencyProject_scanning_updatedAt_idx"
  ON "DependencyProject" ("updatedAt" ASC)
  WHERE "scanStatus" = 'SCANNING';

CREATE INDEX "DependencyPullRequest_open_projectId_idx"
  ON "DependencyPullRequest" ("projectId")
  WHERE "state" = 'OPEN';

CREATE INDEX "Invite_pending_expiresAt_idx"
  ON "Invite" ("expiresAt")
  WHERE "usedAt" IS NULL;

-- Extended statistics
CREATE STATISTICS IF NOT EXISTS "Release_visibility_stats" (dependencies, ndistinct, mcv)
  ON "repositoryId", "source", "isPrerelease", "isDraft"
  FROM "Release";

-- HOT & autovacuum storage parameters
ALTER TABLE "Repository" SET (fillfactor = 80);
ALTER TABLE "DependencyProject" SET (fillfactor = 80);
ALTER TABLE "Release" SET (fillfactor = 90);
ALTER TABLE "DependencyNotificationOutbox" SET (autovacuum_vacuum_scale_factor = 0.05, autovacuum_vacuum_threshold = 50);

-- Domain CHECK constraints
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

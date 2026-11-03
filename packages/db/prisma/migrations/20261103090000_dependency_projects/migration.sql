-- Slice 08 Part A: the Dependencies module. Per-user dependency projects (independent of subscriptions), their
-- manifests, outdated dependencies, update pull requests and the instance-wide PR owner per GitHub repository.
-- Also: NotificationRule.events (existing rules keep RELEASES), User.githubLogin and InstanceSettings.depsEnabled.

-- CreateEnum
CREATE TYPE "NotificationEvent" AS ENUM ('RELEASES', 'DEPENDENCY_UPDATES', 'DEPENDENCY_PULL_REQUESTS');

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

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "githubLogin" TEXT;

-- AlterTable
ALTER TABLE "InstanceSettings" ADD COLUMN     "depsEnabled" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "NotificationRule" ADD COLUMN     "events" "NotificationEvent"[] DEFAULT ARRAY['RELEASES']::"NotificationEvent"[];

-- CreateTable
CREATE TABLE "DependencyProject" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "githubRepoId" INTEGER NOT NULL,
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
    "lastScannedAt" TIMESTAMP(3),
    "lastScannedSha" TEXT,
    "nextScanAt" TIMESTAMP(3),
    "scanStatus" "DepsScanStatus" NOT NULL DEFAULT 'IDLE',
    "scanError" TEXT,
    "errorCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DependencyProject_pkey" PRIMARY KEY ("id")
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
    "targetReleasedAt" TIMESTAMP(3),
    "sourceRepoUrl" TEXT,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notifiedAt" TIMESTAMP(3),

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
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "closedAt" TIMESTAMP(3),

    CONSTRAINT "DependencyPullRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DependencyPrOwner" (
    "githubRepoId" INTEGER NOT NULL,
    "projectId" TEXT NOT NULL,

    CONSTRAINT "DependencyPrOwner_pkey" PRIMARY KEY ("githubRepoId")
);

-- CreateIndex
CREATE INDEX "DependencyProject_nextScanAt_scanStatus_idx" ON "DependencyProject"("nextScanAt", "scanStatus");

-- CreateIndex
CREATE INDEX "DependencyProject_githubRepoId_idx" ON "DependencyProject"("githubRepoId");

-- CreateIndex
CREATE UNIQUE INDEX "DependencyProject_userId_githubRepoId_key" ON "DependencyProject"("userId", "githubRepoId");

-- CreateIndex
CREATE UNIQUE INDEX "DependencyManifest_projectId_path_key" ON "DependencyManifest"("projectId", "path");

-- CreateIndex
CREATE INDEX "DependencyUpdate_projectId_status_idx" ON "DependencyUpdate"("projectId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "DependencyUpdate_manifestId_name_kind_group_key" ON "DependencyUpdate"("manifestId", "name", "kind", "group");

-- CreateIndex
CREATE UNIQUE INDEX "DependencyPullRequest_projectId_groupKey_key" ON "DependencyPullRequest"("projectId", "groupKey");

-- CreateIndex
CREATE UNIQUE INDEX "DependencyPrOwner_projectId_key" ON "DependencyPrOwner"("projectId");

-- AddForeignKey
ALTER TABLE "DependencyProject" ADD CONSTRAINT "DependencyProject_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DependencyProject" ADD CONSTRAINT "DependencyProject_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "Repository"("id") ON DELETE SET NULL ON UPDATE CASCADE;

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


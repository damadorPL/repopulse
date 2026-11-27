-- Add query and FK/cascade indexes identified in the database audit (M-09)
-- and widen DependencyUpdate(projectId, status) to include level.

-- DropIndex
DROP INDEX "DependencyUpdate_projectId_status_idx";

-- CreateIndex
CREATE INDEX "Invite_createdById_idx" ON "Invite"("createdById");

-- CreateIndex
CREATE INDEX "Release_publishedAt_id_idx" ON "Release"("publishedAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "Release_repositoryId_source_publishedAt_idx" ON "Release"("repositoryId", "source", "publishedAt" DESC);

-- CreateIndex
CREATE INDEX "UserSubscription_repositoryId_idx" ON "UserSubscription"("repositoryId");

-- CreateIndex
CREATE INDEX "SubscriptionTag_tagId_idx" ON "SubscriptionTag"("tagId");

-- CreateIndex
CREATE INDEX "UserReleaseState_releaseId_idx" ON "UserReleaseState"("releaseId");

-- CreateIndex
CREATE INDEX "NotificationRule_userId_enabled_idx" ON "NotificationRule"("userId", "enabled");

-- CreateIndex
CREATE INDEX "NotificationRule_tagId_idx" ON "NotificationRule"("tagId");

-- CreateIndex
CREATE INDEX "DependencyProject_repositoryId_idx" ON "DependencyProject"("repositoryId");

-- CreateIndex
CREATE INDEX "DependencyUpdate_projectId_status_level_idx" ON "DependencyUpdate"("projectId", "status", "level");

-- CreateIndex
CREATE INDEX "DependencyNotificationOutbox_projectId_idx" ON "DependencyNotificationOutbox"("projectId");

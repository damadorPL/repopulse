-- Enable trigram similarity/ILIKE acceleration and add case-insensitive/partial performance indexes.
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- CreateIndex
CREATE INDEX "Repository_fullName_idx" ON "Repository" USING GIN ("fullName" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "Release_tagName_idx" ON "Release" USING GIN ("tagName" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "Release_title_idx" ON "Release" USING GIN ("title" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "Release_bodyMarkdown_idx" ON "Release" USING GIN ("bodyMarkdown" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "Tag_name_idx" ON "Tag" USING GIN ("name" gin_trgm_ops);

-- Case-insensitive lookup expression indexes
CREATE INDEX "Repository_fullName_lower_idx" ON "Repository" (LOWER("fullName"));
CREATE INDEX "DependencyProject_userId_fullName_lower_idx" ON "DependencyProject" ("userId", LOWER("fullName"));

-- Partial covering index for unread release lookups
CREATE INDEX "UserReleaseState_userId_unread_releaseId_idx" ON "UserReleaseState" ("userId", "releaseId") WHERE "isRead" = false;

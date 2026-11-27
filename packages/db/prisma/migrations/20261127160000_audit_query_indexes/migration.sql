-- Align outbox sweep ORDER BY ("createdAt" ASC, "id" ASC) LIMIT 100
DROP INDEX IF EXISTS "DependencyNotificationOutbox_createdAt_idx";
CREATE INDEX "DependencyNotificationOutbox_createdAt_id_idx"
  ON "DependencyNotificationOutbox" ("createdAt", "id");

-- Expired session & verification cleanup indexes
CREATE INDEX "Session_expiresAt_idx" ON "Session" ("expiresAt");
CREATE INDEX "Verification_expiresAt_idx" ON "Verification" ("expiresAt");

-- Partial indexes for hot worker/admin queries
CREATE INDEX "DependencyPullRequest_open_projectId_idx"
  ON "DependencyPullRequest" ("projectId")
  WHERE "state" = 'OPEN';

CREATE INDEX "Repository_backfill_pending_idx"
  ON "Repository" ("backfillStatus", "createdAt")
  WHERE "backfillStatus" IN ('NONE', 'QUEUED', 'RUNNING');

CREATE INDEX "Invite_pending_expiresAt_idx"
  ON "Invite" ("expiresAt")
  WHERE "usedAt" IS NULL;

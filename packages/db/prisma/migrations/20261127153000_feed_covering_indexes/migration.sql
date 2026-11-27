-- Covering partial indexes for release feed ordering/filtering (Index-Only Scan without touching TOASTed bodyMarkdown).
CREATE INDEX "Release_visible_publishedAt_id_idx"
  ON "Release" ("publishedAt" DESC, "id" DESC)
  INCLUDE ("repositoryId", "source", "isPrerelease", "semverType")
  WHERE "isDraft" = false;

CREATE INDEX "Release_visible_repo_publishedAt_id_idx"
  ON "Release" ("repositoryId", "publishedAt" DESC, "id" DESC)
  INCLUDE ("source", "isPrerelease", "semverType")
  WHERE "isDraft" = false;

-- Partial index for dashboard sidebar outdated-project count.
CREATE INDEX "DependencyUpdate_projectId_outdated_idx"
  ON "DependencyUpdate" ("projectId")
  WHERE "status" = 'OUTDATED';

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const MIGRATIONS_DIR = fileURLToPath(new URL("../prisma/migrations", import.meta.url));

function stripSqlComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n\r]*/g, "");
}

function replayMigrationObjects(): { activeIndexes: Set<string>; activeStatistics: Set<string> } {
  const dirs = readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  const activeIndexes = new Set<string>();
  const activeStatistics = new Set<string>();

  const statementRe =
    /(CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?"([^"]+)"|DROP\s+INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+EXISTS\s+)?"([^"]+)"|CREATE\s+STATISTICS\s+(?:IF\s+NOT\s+EXISTS\s+)?"([^"]+)"|DROP\s+STATISTICS\s+(?:IF\s+EXISTS\s+)?"([^"]+)")/gi;

  for (const dir of dirs) {
    const sql = stripSqlComments(readFileSync(join(MIGRATIONS_DIR, dir, "migration.sql"), "utf8"));
    for (const match of sql.matchAll(statementRe)) {
      const [, full, createIdx, dropIdx, createStats, dropStats] = match;
      if (!full) continue;
      if (createIdx) activeIndexes.add(createIdx);
      else if (dropIdx) activeIndexes.delete(dropIdx);
      else if (createStats) activeStatistics.add(createStats);
      else if (dropStats) activeStatistics.delete(dropStats);
    }
  }

  return { activeIndexes, activeStatistics };
}

describe("PostgreSQL migration drift guard", () => {
  const { activeIndexes, activeStatistics } = replayMigrationObjects();

  it("keeps all expected custom partial, covering, GIN, and worker indexes plus extended statistics active", () => {
    const expectedIndexes = [
      "UserReleaseState_userId_unread_releaseId_idx",
      "Release_visible_publishedAt_id_idx",
      "Release_visible_repo_publishedAt_id_idx",
      "Release_searchVector_idx",
      "Release_repositoryId_source_publishedAt_id_idx",
      "Repository_pollStatus_lastPolledAt_idx",
      "Repository_polling_updatedAt_idx",
      "DependencyProject_due_nextScanAt_id_idx",
      "DependencyProject_scanning_updatedAt_idx",
      "DependencyPullRequest_open_projectId_idx",
      "Repository_backfill_pending_idx",
      "Invite_pending_expiresAt_idx",
      "DependencyBranchWriteIntent_createdAt_idx",
    ];
    for (const name of expectedIndexes) {
      expect(activeIndexes.has(name), `Expected active index "${name}"`).toBe(true);
    }
    expect(activeStatistics.has("Release_visibility_stats")).toBe(true);
  });

  it("ensures dropped dead and redundant indexes are not active", () => {
    const droppedIndexes = [
      "Repository_fullName_lower_idx",
      "DependencyProject_userId_fullName_lower_idx",
      "Release_bodyMarkdown_idx",
      "Tag_name_idx",
      "Release_repositoryId_publishedAt_idx",
      "Release_publishedAt_id_idx",
      "UserReleaseState_userId_isRead_idx",
      "Repository_backfillStatus_idx",
      "DependencyUpdate_projectId_outdated_idx",
      "Repository_lastPolledAt_pollStatus_idx",
      "DependencyProject_nextScanAt_scanStatus_idx",
      "Release_repositoryId_source_publishedAt_idx",
    ];
    for (const name of droppedIndexes) {
      expect(activeIndexes.has(name), `Expected dropped index "${name}" to be inactive`).toBe(false);
    }
  });
});

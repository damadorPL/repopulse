import { describe, expect, it, vi } from "vitest";

import {
  BRANCH_WRITE_INTENT_RETENTION_DAYS,
  INVITE_RETENTION_DAYS,
  MAINTENANCE_BATCH_SIZE,
  MAINTENANCE_MAX_BATCHES,
  processMaintenanceTick,
  READ_STATE_RETENTION_DAYS,
} from "./maintenance.processor.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-10-31T03:17:00Z");

describe("processMaintenanceTick", () => {
  it("runs bounded ctid batch deletes for all 5 tables with exact cutoffs and excludes COMMIT rows", async () => {
    const queries: Array<{ sql: string; values: unknown[] }> = [];
    const executeRaw = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      queries.push({ sql: strings.join("?"), values });
      return 12;
    });

    const result = await processMaintenanceTick({
      prisma: { $executeRaw: executeRaw as never },
      now: () => NOW,
    });

    expect(result).toEqual({
      sessions: 12,
      verifications: 12,
      invites: 12,
      branchWriteIntents: 12,
      releaseStates: 12,
    });
    expect(queries).toHaveLength(5);

    expect(queries[0]!.sql).toContain('DELETE FROM "Session"');
    expect(queries[0]!.sql).toContain('WHERE "expiresAt" < ?');
    expect(queries[0]!.values).toEqual([NOW, MAINTENANCE_BATCH_SIZE]);

    expect(queries[1]!.sql).toContain('DELETE FROM "Verification"');
    expect(queries[1]!.sql).toContain('WHERE "expiresAt" < ?');
    expect(queries[1]!.values).toEqual([NOW, MAINTENANCE_BATCH_SIZE]);

    expect(queries[2]!.sql).toContain('DELETE FROM "Invite"');
    expect(queries[2]!.sql).toContain('"usedAt" IS NULL AND "expiresAt" < ?');
    expect(queries[2]!.values).toEqual([
      new Date(NOW.getTime() - INVITE_RETENTION_DAYS * DAY_MS),
      MAINTENANCE_BATCH_SIZE,
    ]);

    expect(queries[3]!.sql).toContain('DELETE FROM "DependencyBranchWriteIntent"');
    expect(queries[3]!.sql).toContain('"createdAt" < ?');
    expect(queries[3]!.values).toEqual([
      new Date(NOW.getTime() - BRANCH_WRITE_INTENT_RETENTION_DAYS * DAY_MS),
      MAINTENANCE_BATCH_SIZE,
    ]);

    expect(queries[4]!.sql).toContain('DELETE FROM "UserReleaseState"');
    expect(queries[4]!.sql).toContain('JOIN "Release" r ON r."id" = urs."releaseId"');
    expect(queries[4]!.sql).toContain('urs."isRead" = true');
    expect(queries[4]!.sql).toContain('urs."readAt" < ?');
    expect(queries[4]!.sql).toContain(`r."source" <> 'COMMIT'::"ReleaseSource"`);
    expect(queries[4]!.values).toEqual([
      new Date(NOW.getTime() - READ_STATE_RETENTION_DAYS * DAY_MS),
      MAINTENANCE_BATCH_SIZE,
    ]);
  });

  it("loops batches while full pages are deleted and stops early when a partial batch is returned", async () => {
    let sessionCalls = 0;
    const executeRaw = vi.fn(async (strings: TemplateStringsArray) => {
      const sql = strings.join("?");
      if (sql.includes('"Session"')) {
        sessionCalls += 1;
        return sessionCalls < 3 ? MAINTENANCE_BATCH_SIZE : 42;
      }
      return 0;
    });

    const result = await processMaintenanceTick({
      prisma: { $executeRaw: executeRaw as never },
      now: () => NOW,
    });

    expect(sessionCalls).toBe(3);
    expect(result.sessions).toBe(MAINTENANCE_BATCH_SIZE * 2 + 42);
    expect(result.verifications).toBe(0);
    expect(executeRaw).toHaveBeenCalledTimes(3 + 4);
  });

  it("caps per-table cleanup at MAINTENANCE_MAX_BATCHES even when every batch is full", async () => {
    const callsByTable: Record<string, number> = {};
    const executeRaw = vi.fn(async (strings: TemplateStringsArray) => {
      const sql = strings.join("?");
      const match = sql.match(/DELETE FROM "([^"]+)"/);
      const table = match![1]!;
      callsByTable[table] = (callsByTable[table] ?? 0) + 1;
      return table === "UserReleaseState" ? MAINTENANCE_BATCH_SIZE : 0;
    });

    const result = await processMaintenanceTick({
      prisma: { $executeRaw: executeRaw as never },
      now: () => NOW,
    });

    expect(callsByTable).toEqual({
      Session: 1,
      Verification: 1,
      Invite: 1,
      DependencyBranchWriteIntent: 1,
      UserReleaseState: MAINTENANCE_MAX_BATCHES,
    });
    expect(result.releaseStates).toBe(MAINTENANCE_BATCH_SIZE * MAINTENANCE_MAX_BATCHES);
  });
});

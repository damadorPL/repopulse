import { afterEach, describe, expect, it, vi } from "vitest";

import { bootstrapAppRole, type BootstrapSqlRunner, type BootstrapSqlTx } from "./bootstrap-app-role.js";

function createMockRunner(
  options: {
    currentUser?: string;
    currentDb?: string;
    failPgStatStatements?: boolean;
  } = {},
) {
  const calls: Array<{ kind: "query" | "exec" | "txExec"; sql: string; values: unknown[] }> = [];
  const tx: BootstrapSqlTx = {
    executeRawUnsafe: vi.fn(async (sql: string, ...values: unknown[]) => {
      calls.push({ kind: "txExec", sql, values });
      return 0;
    }),
  };
  const queryRawUnsafe = vi.fn(async (sql: string, ...values: unknown[]) => {
    calls.push({ kind: "query", sql, values });
    return [
      {
        current_user: options.currentUser ?? "postgres",
        current_db: options.currentDb ?? "repopulse",
      },
    ];
  });
  const executeRawUnsafe = vi.fn(async (sql: string, ...values: unknown[]) => {
    calls.push({ kind: "exec", sql, values });
    if (options.failPgStatStatements && sql.includes("pg_stat_statements")) {
      throw new Error("pg_stat_statements must be loaded via shared_preload_libraries");
    }
    return 0;
  });
  const transaction = vi.fn(async <T>(fn: (innerTx: BootstrapSqlTx) => Promise<T>): Promise<T> => fn(tx));
  const runner: BootstrapSqlRunner = {
    queryRawUnsafe: queryRawUnsafe as unknown as BootstrapSqlRunner["queryRawUnsafe"],
    executeRawUnsafe,
    transaction: transaction as unknown as BootstrapSqlRunner["transaction"],
  };
  return { runner, calls };
}

describe("bootstrapAppRole", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("skips cleanly without querying DB when POSTGRES_APP_PASSWORD is unset", async () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const { runner } = createMockRunner();

    const result = await bootstrapAppRole(runner, {});

    expect(result).toEqual({ status: "skipped-no-password" });
    expect(runner.queryRawUnsafe).not.toHaveBeenCalled();
    expect(runner.transaction).not.toHaveBeenCalled();
    expect(infoSpy).toHaveBeenCalledWith("[db-bootstrap] POSTGRES_APP_PASSWORD not set; skipping runtime role setup");
  });

  it("rejects invalid POSTGRES_APP_USER identifiers", async () => {
    const { runner } = createMockRunner();

    await expect(
      bootstrapAppRole(runner, {
        POSTGRES_APP_USER: "bad-user; DROP TABLE",
        POSTGRES_APP_PASSWORD: "secret",
      }),
    ).rejects.toThrow(/Invalid POSTGRES_APP_USER/);
    await expect(
      bootstrapAppRole(runner, {
        POSTGRES_APP_USER: "UpperCase",
        POSTGRES_APP_PASSWORD: "secret",
      }),
    ).rejects.toThrow(/Invalid POSTGRES_APP_USER/);
    expect(runner.queryRawUnsafe).not.toHaveBeenCalled();
  });

  it("skips when current_user equals POSTGRES_APP_USER to avoid locking out the migrator", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { runner } = createMockRunner({ currentUser: "repopulse_app" });

    const result = await bootstrapAppRole(runner, {
      POSTGRES_APP_PASSWORD: "secret",
    });

    expect(result).toEqual({ status: "skipped-same-user", appUser: "repopulse_app" });
    expect(runner.transaction).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      "[db-bootstrap] current_user matches repopulse_app; skipping runtime role setup",
    );
  });

  it("configures the least-privilege role via parameterized set_config + DO block and enables pg_stat_statements", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const { runner, calls } = createMockRunner({ currentUser: "postgres", currentDb: "prod_db" });

    const result = await bootstrapAppRole(runner, {
      POSTGRES_APP_USER: "rp_runtime",
      POSTGRES_APP_PASSWORD: "p'ass\"word$123",
    });

    expect(result).toEqual({
      status: "configured",
      appUser: "rp_runtime",
      database: "prod_db",
      pgStatStatements: true,
    });
    expect(calls[0]).toEqual({
      kind: "query",
      sql: "SELECT current_user AS current_user, current_database() AS current_db",
      values: [],
    });
    expect(calls[1]).toEqual({
      kind: "txExec",
      sql: "SELECT set_config('repopulse.app_user', $1, true), set_config('repopulse.app_password', $2, true)",
      values: ["rp_runtime", "p'ass\"word$123"],
    });
    expect(calls[2]?.kind).toBe("txExec");
    expect(calls[2]?.sql).toContain("NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS");
    expect(calls[2]?.sql).toContain("GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public");
    expect(calls[2]?.sql).toContain("statement_timeout");
    expect(calls[2]?.sql).toContain("lock_timeout");
    expect(calls[2]?.sql).toContain("idle_in_transaction_session_timeout");
    expect(calls[2]?.values).toEqual([]);
    expect(calls[3]).toEqual({
      kind: "exec",
      sql: 'CREATE EXTENSION IF NOT EXISTS "pg_stat_statements";',
      values: [],
    });
  });

  it("does not throw if pg_stat_statements installation fails", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { runner } = createMockRunner({ failPgStatStatements: true });

    const result = await bootstrapAppRole(runner, {
      POSTGRES_APP_PASSWORD: "secret",
    });

    expect(result).toEqual({
      status: "configured",
      appUser: "repopulse_app",
      database: "repopulse",
      pgStatStatements: false,
    });
    expect(warnSpy).toHaveBeenCalledWith(
      "[db-bootstrap] Could not enable pg_stat_statements (continuing):",
      "pg_stat_statements must be loaded via shared_preload_libraries",
    );
  });
});

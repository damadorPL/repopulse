import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "./generated/prisma/client.js";

const DEFAULT_APP_USER = "repopulse_app";
const VALID_PG_IDENTIFIER_RE = /^[a-z_][a-z0-9_]{0,62}$/;

const ROLE_SETUP_DO_SQL = `
DO $do$
DECLARE
  v_user text := current_setting('repopulse.app_user');
  v_pass text := current_setting('repopulse.app_password');
  v_db   text := current_database();
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v_user) THEN
    EXECUTE format(
      'ALTER ROLE %I WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD %L',
      v_user,
      v_pass
    );
  ELSE
    EXECUTE format(
      'CREATE ROLE %I WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD %L',
      v_user,
      v_pass
    );
  END IF;

  EXECUTE format('GRANT CONNECT ON DATABASE %I TO %I', v_db, v_user);
  EXECUTE format('GRANT USAGE ON SCHEMA public TO %I', v_user);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO %I', v_user);
  EXECUTE format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO %I', v_user);
  EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO %I', v_user);
  EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO %I', v_user);
  EXECUTE format('ALTER ROLE %I SET statement_timeout = %L', v_user, '30s');
  EXECUTE format('ALTER ROLE %I SET lock_timeout = %L', v_user, '10s');
  EXECUTE format('ALTER ROLE %I SET idle_in_transaction_session_timeout = %L', v_user, '60s');
END
$do$;
`.trim();

export interface BootstrapSqlTx {
  executeRawUnsafe(sql: string, ...values: unknown[]): Promise<unknown>;
}

export interface BootstrapSqlRunner extends BootstrapSqlTx {
  queryRawUnsafe<T = unknown>(sql: string, ...values: unknown[]): Promise<T>;
  transaction<T>(fn: (tx: BootstrapSqlTx) => Promise<T>): Promise<T>;
}

export type BootstrapAppRoleResult =
  | { status: "skipped-no-password" }
  | { status: "skipped-same-user"; appUser: string }
  | { status: "configured"; appUser: string; database: string; pgStatStatements: boolean };

/**
 * Creates or updates a least-privilege PostgreSQL runtime role (`NOSUPERUSER`, `NOCREATEDB`,
 * `NOCREATEROLE`, `NOBYPASSRLS`) with DML grants on `public` and safe statement/lock timeouts.
 * Also attempts best-effort installation of `pg_stat_statements`.
 */
export async function bootstrapAppRole(
  runner: BootstrapSqlRunner,
  env: Record<string, string | undefined> = process.env,
): Promise<BootstrapAppRoleResult> {
  const appPassword = env.POSTGRES_APP_PASSWORD;
  if (!appPassword) {
    console.info("[db-bootstrap] POSTGRES_APP_PASSWORD not set; skipping runtime role setup");
    return { status: "skipped-no-password" };
  }

  const appUser = env.POSTGRES_APP_USER?.trim() || DEFAULT_APP_USER;
  if (!VALID_PG_IDENTIFIER_RE.test(appUser)) {
    throw new Error(
      `[db-bootstrap] Invalid POSTGRES_APP_USER "${appUser}": must match ${VALID_PG_IDENTIFIER_RE.source}`,
    );
  }

  const rows = await runner.queryRawUnsafe<Array<{ current_user: string; current_db: string }>>(
    "SELECT current_user AS current_user, current_database() AS current_db",
  );
  const session = rows[0];
  if (!session) {
    throw new Error("[db-bootstrap] Failed to read current PostgreSQL session user/database");
  }

  if (session.current_user === appUser) {
    console.warn(`[db-bootstrap] current_user matches ${appUser}; skipping runtime role setup`);
    return { status: "skipped-same-user", appUser };
  }

  await runner.transaction(async (tx) => {
    await tx.executeRawUnsafe(
      "SELECT set_config('repopulse.app_user', $1, true), set_config('repopulse.app_password', $2, true)",
      appUser,
      appPassword,
    );
    await tx.executeRawUnsafe(ROLE_SETUP_DO_SQL);
  });

  let pgStatStatements = true;
  try {
    await runner.executeRawUnsafe('CREATE EXTENSION IF NOT EXISTS "pg_stat_statements";');
  } catch (error) {
    pgStatStatements = false;
    console.warn(
      "[db-bootstrap] Could not enable pg_stat_statements (continuing):",
      error instanceof Error ? error.message : error,
    );
  }

  console.info(`[db-bootstrap] Runtime role "${appUser}" configured on database "${session.current_db}"`);
  return {
    status: "configured",
    appUser,
    database: session.current_db,
    pgStatStatements,
  };
}

function createPrismaBootstrapRunner(connectionString: string): {
  runner: BootstrapSqlRunner;
  disconnect: () => Promise<void>;
} {
  const adapter = new PrismaPg({
    connectionString,
    max: 1,
    connectionTimeoutMillis: 10_000,
    application_name: "repopulse-db-bootstrap",
  });
  const client = new PrismaClient({ adapter });
  const runner: BootstrapSqlRunner = {
    queryRawUnsafe: (sql, ...values) => client.$queryRawUnsafe(sql, ...values),
    executeRawUnsafe: (sql, ...values) => client.$executeRawUnsafe(sql, ...values),
    transaction: (fn) =>
      client.$transaction((tx) =>
        fn({
          executeRawUnsafe: (sql, ...values) => tx.$executeRawUnsafe(sql, ...values),
        }),
      ),
  };
  return {
    runner,
    disconnect: () => client.$disconnect(),
  };
}

async function main(): Promise<void> {
  if (!process.env.POSTGRES_APP_PASSWORD) {
    console.info("[db-bootstrap] POSTGRES_APP_PASSWORD not set; skipping runtime role setup");
    return;
  }
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("[db-bootstrap] DATABASE_URL is required when POSTGRES_APP_PASSWORD is set");
  }
  const { runner, disconnect } = createPrismaBootstrapRunner(connectionString);
  try {
    await bootstrapAppRole(runner, process.env);
  } finally {
    await disconnect();
  }
}

const isEntrypoint =
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  typeof process.argv[1] === "string" &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isEntrypoint) {
  main().catch((error: unknown) => {
    console.error("[db-bootstrap] Fatal error:", error);
    process.exitCode = 1;
  });
}

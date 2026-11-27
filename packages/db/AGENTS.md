# AGENTS.md — `@repopulse/db` (`packages/db`)

Guidance for coding agents working in the Prisma 7 PostgreSQL schema, migrations, singleton client, and token cryptography (`packages/db`).

> **References:** [`docs/packages/db.md`](../../docs/packages/db.md) · [`docs/CODING_STANDARDS.md`](../../docs/CODING_STANDARDS.md) · [`docs/guides/recipes.md`](../../docs/guides/recipes.md#add-a-database-column-or-model)

## 1. Non-Negotiable Invariants

- **Immutable Migrations:** Every schema change requires a new `prisma/migrations/<YYYYMMDDHHMMSS>_<snake_name>/migration.sql`. Never edit or delete a shipped migration. Use `RENAME COLUMN` for renames.
- **Raw-SQL-Managed DB Objects:** Partial/covering/GIN indexes, `Release.searchVector`, `Release_visibility_stats`, `fillfactor`/autovacuum settings, and `CHECK` constraints are managed in raw SQL migrations (and guarded by `src/migrations.test.ts`). Always review `prisma migrate diff` output so custom indexes/stats/constraints are never accidentally dropped.
- **Secrets & `GLOBAL_OMIT`:** Keep `GLOBAL_OMIT` excluding encrypted columns (`githubAccessTokenEncrypted`, `smtpPasswordEncrypted`, `githubAppPrivateKeyEncrypted`, `githubAppWebhookSecretEncrypted`). Use `encryptToken`/`decryptToken` with `TOKEN_ENCRYPTION_KEY`.
- **Singleton & `InstanceSettings`:** Export and reuse the singleton `prisma` (`@prisma/adapter-pg`, `statementNameGenerator` omitted for PgBouncer + partial-index custom plans), touch `InstanceSettings` via `INSTANCE_SETTINGS_ID` (`1`) with `upsert`, and keep `dist/` built (`pnpm --filter "./packages/*" build`) so apps see changes.
- **ESM Imports:** Use `.js` extensions on relative imports in `src/` (`moduleFormat = "esm"`).

## 2. Commands

```sh
pnpm --filter @repopulse/db db:generate
pnpm --filter @repopulse/db build
pnpm --filter @repopulse/db typecheck
pnpm --filter @repopulse/db lint
pnpm --filter @repopulse/db test
```

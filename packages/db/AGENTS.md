# AGENTS.md — `@repopulse/db` (`packages/db`)

Guidance for coding agents working in the Prisma 7 PostgreSQL schema, migrations, singleton client, and token cryptography (`packages/db`).

> **References:** [`docs/packages/db.md`](../../docs/packages/db.md) · [`docs/CODING_STANDARDS.md`](../../docs/CODING_STANDARDS.md) · [`docs/guides/recipes.md`](../../docs/guides/recipes.md#add-a-database-column-or-model)

## 1. Non-Negotiable Invariants

- **Immutable Migrations:** Every schema change requires a new `prisma/migrations/<YYYYMMDDHHMMSS>_<snake_name>/migration.sql`. Never edit or delete a shipped migration. Verify an empty `prisma migrate diff` and use `RENAME COLUMN` for renames.
- **Secrets & `GLOBAL_OMIT`:** Keep `GLOBAL_OMIT` excluding encrypted columns (`githubAccessTokenEncrypted`, `smtpPasswordEncrypted`, `githubAppPrivateKeyEncrypted`, `githubAppWebhookSecretEncrypted`). Use `encryptToken`/`decryptToken` with `TOKEN_ENCRYPTION_KEY`.
- **Singleton & `InstanceSettings`:** Export and reuse the singleton `prisma` (`@prisma/adapter-pg`), touch `InstanceSettings` via `INSTANCE_SETTINGS_ID` (`1`) with `upsert`, and keep `dist/` built (`pnpm --filter "./packages/*" build`) so apps see changes.
- **ESM Imports:** Use `.js` extensions on relative imports in `src/` (`moduleFormat = "esm"`).

## 2. Commands

```sh
pnpm --filter @repopulse/db db:generate
pnpm --filter @repopulse/db build
pnpm --filter @repopulse/db typecheck
pnpm --filter @repopulse/db lint
pnpm --filter @repopulse/db test
```

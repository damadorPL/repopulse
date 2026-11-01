# Configuration

> **Summary:** one root `.env` (git-ignored) for local development, created by `pnpm env:setup` and kept current by
> `pnpm env:sync`. In production, Coolify passes variables to the services listed in `docker-compose.coolify.yml`.
> SMTP is **not** configured here: the super admin sets it in Settings → Email.

## Rules

- **MUST** add every new variable to: `.env.example`, the template in `scripts/setup-env.mjs`, an `ADDITIONS` entry
  in `scripts/sync-env.mjs` (so existing `.env` files get it), the `environment:` of each service that reads it in
  `docker-compose.coolify.yml`, this file, and `CHANGELOG.md`.
- **MUST** add removed variables to `OBSOLETE` in `scripts/sync-env.mjs`. It reports them and never deletes them.
- **MUST NOT** commit `.env`. Agents must not stage `.env*` files at all: the user commits `.env.example` themselves.
- Prefer a UI setting on `InstanceSettings` over a new env var for anything an operator changes at runtime
  ([recipes.md](./recipes.md#add-an-instance-setting-super-admin)).

## Variables

| Variable | Used by | Default | Notes |
| --- | --- | --- | --- |
| `DATABASE_URL` | web, worker, migrator, Prisma CLI | — | Compose builds it from `POSTGRES_*` |
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` | compose | `repopulse` / — / `repopulse` | |
| `REDIS_URL` | web, worker | — | Compose: `redis://:${REDIS_PASSWORD}@redis:6379`. Without it, web sync and SSE return `UNAVAILABLE` / 503 and the worker refuses to start |
| `REDIS_PASSWORD` | compose | — | |
| `AUTH_SECRET` | web | — | `openssl rand -hex 32` |
| `AUTH_GITHUB_ID` / `AUTH_GITHUB_SECRET` | web | — | GitHub OAuth App; callback `<origin>/api/auth/callback/github` |
| `SERVICE_URL_WEB` | compose → `NEXTAUTH_URL`, `APP_BASE_URL` | — | Public URL **with the scheme**, set by Coolify. Set it by hand for local compose. Replaces `SERVICE_FQDN_WEB` (a bare host) |
| `NEXTAUTH_URL` / `AUTH_URL` | web | — | Auth.js base URL. Compose sets `NEXTAUTH_URL` |
| `TOKEN_ENCRYPTION_KEY` | web, worker | — | 64 hex chars. Encrypts GitHub tokens and the SMTP password. **Changing it makes them unreadable** |
| `POLL_INTERVAL_CRON` | worker | `*/30 * * * *` | The scheduler cron |
| `REPO_POLL_CONCURRENCY` | worker | `5` | |
| `NOTIFICATION_CONCURRENCY` | worker | `10` | |
| `RELEASE_BACKFILL_DEFAULT_TARGET` | worker | `100` | Releases kept per repository after the automatic backfill |
| `RELEASE_BACKFILL_MAX_AGE_DAYS` | worker | `365` | `0` = no age limit. Only applies to the automatic backfill |
| `RELEASE_BACKFILL_HARD_CAP` | worker **and** web | `1000` | Must match: web uses it for "Load older releases" |
| `RELEASE_BACKFILL_MIN_QUOTA` | worker | `500` | The backfill pauses below this many remaining GitHub requests |
| `ALLOW_INTERNAL_WEBHOOK_HOSTS` | web, worker | unset (= none) | `true`, or a comma list of hostnames allowed to resolve to private addresses |
| `APP_BASE_URL` | web, worker | `AUTH_URL` → `NEXTAUTH_URL` → `http://localhost:3000` | Links in notifications. A bare host gets `https://` |
| `HEALTH_PORT` | worker | `3001` | |
| `NODE_ENV` | all | | `production` disables loading the root `.env` |

**Removed in 0.5.0:** `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_SECURE`, `SMTP_FROM` (now Settings →
Email) and `SERVICE_FQDN_WEB` (now `SERVICE_URL_WEB`).

## How `.env` is loaded outside production

| Consumer | Mechanism |
| --- | --- |
| Next.js (`apps/web`) | `next.config.ts` calls `process.loadEnvFile(<root>/.env)` |
| Prisma CLI | `packages/db/prisma.config.ts` walks up to `pnpm-workspace.yaml` and loads `.env` |
| Worker dev | `tsx watch --env-file-if-exists=../../.env` |
| Tests | Turborepo passes `TOKEN_ENCRYPTION_KEY` to `test`. Tests that encrypt set their own random key |

Variables already set in the shell win over `.env`.

## Scripts

- `pnpm env:setup [--force]`: writes `.env` with generated Postgres and Redis passwords, `AUTH_SECRET` and
  `TOKEN_ENCRYPTION_KEY` (mode 0600). Refuses to overwrite without `--force`.
- `pnpm env:sync [--check] [files…]`: inserts missing keys after their anchor key (commented-out keys count as
  present), and prints `! … no longer used` for obsolete keys. `--check` exits 1 if anything is missing.

# Deployment (Coolify / Docker Compose)

> **Summary:** Coolify's **Docker Compose** build pack deploys `docker-compose.coolify.yml`: `postgres`, `redis`, a
> one-off `migrator`, `web` and `worker`, all built from this repository. Images are multi-stage Node 26 Alpine builds
> that use `turbo prune`.

## Services

| Service | Image / build | Purpose | Health |
| --- | --- | --- | --- |
| `postgres` | `postgres:16-alpine`, volume `postgres_data` | State | `pg_isready` |
| `redis` | `redis:7-alpine`, `--appendonly yes --maxmemory-policy noeviction --requirepass`, volume `redis_data` | BullMQ + Pub/Sub. **`noeviction` is required by BullMQ** | `redis-cli ping` |
| `migrator` | `apps/worker/Dockerfile` target `migrator` | `prisma migrate deploy`, then exits 0 (`restart: "no"`) | — |
| `web` | `apps/web/Dockerfile` (standalone Next output, `node apps/web/server.js`, user `nextjs`, `HOSTNAME="::"`) | UI and SSE on 3000 | `wget localhost:3000/api/health` |
| `worker` | `apps/worker/Dockerfile` target `runner` (`node apps/worker/dist/index.js`) | Jobs, health on 3001. `stop_grace_period: 30s` | `wget localhost:3001/health` |

Startup order: `postgres` and `redis` healthy → `migrator` completed successfully → `web` and `worker`.

## Environment in compose

- `DATABASE_URL` and `REDIS_URL` are built from YAML anchors (`x-database-url`, `x-redis-url`) using
  `POSTGRES_*` / `REDIS_PASSWORD`.
- `web`: `AUTH_*`, `TOKEN_ENCRYPTION_KEY`, `RELEASE_BACKFILL_HARD_CAP`, `ALLOW_INTERNAL_WEBHOOK_HOSTS`,
  `APP_BASE_URL` and `NEXTAUTH_URL` (both `${SERVICE_URL_WEB}`).
- `worker`: `TOKEN_ENCRYPTION_KEY`, `POLL_INTERVAL_CRON`, the concurrency settings, `RELEASE_BACKFILL_*`,
  `ALLOW_INTERNAL_WEBHOOK_HOSTS`, `APP_BASE_URL`.
- No SMTP variables: the super admin sets SMTP in Settings → Email after the first deploy.
- Full list: [configuration.md](./configuration.md).

## Rules

- **MUST** keep `web` and `worker` on the same `TOKEN_ENCRYPTION_KEY` and `RELEASE_BACKFILL_HARD_CAP`.
- **MUST** pass a new variable explicitly in each service's `environment:`. Compose does not forward variables
  implicitly.
- **MUST** use `SERVICE_URL_WEB` (with the scheme) for URLs. `SERVICE_FQDN_WEB` is a bare host in Coolify 4.5.
- Migrations run automatically on every deploy. A failing migration blocks `web` and `worker` from starting, so test
  it locally first ([data-model.md](./data-model.md#migrations)).

## Docker images (how they build)

1. `pruner`: `turbo prune @repopulse/<app> --docker`.
2. `installer`: `pnpm install --frozen-lockfile` (the `allowBuilds` block in `pnpm-workspace.yaml` lets Prisma's
   install scripts run), then `pnpm turbo run build --filter=@repopulse/<app>`. Build depends on `^db:generate`, so the
   Prisma client is generated inside the image.
3. `runner`: a minimal runtime. The web image copies `.next/standalone` and `.next/static`; standalone tracing is
   rooted at the monorepo (`outputFileTracingRoot`).

## Verifying a deployment

- `GET https://<host>/api/health` → 200.
- Worker logs: `repo-scheduler registered with cron "…"` then `ready`. `GET :3001/health` reports `database` and
  `redis`.
- Sign in. The first account is the super admin. Configure **Settings → Email** and click **Send test email**.

## Local full-stack smoke test

```sh
cp .env.example .env     # fill in the secrets; SERVICE_URL_WEB=http://localhost:3000
docker compose -f docker-compose.coolify.yml up --build
```

## Upgrading to 0.5.0

1. Deploy. The migrator applies the 0.5.0 migrations (`isAdmin` → `isSuperAdmin`, SMTP columns, and the earlier 0.5.0
   ones).
2. If email was configured through `SMTP_*`, enter the same values in **Settings → Email**, then remove the old
   variables from Coolify.
3. Make sure `SERVICE_URL_WEB` is available (Coolify provides it) and remove any manual `SERVICE_FQDN_WEB` override.

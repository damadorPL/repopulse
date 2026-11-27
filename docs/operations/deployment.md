# Deployment (Coolify / Docker Compose)

> **Summary:** Coolify's **Docker Compose** build pack deploys `docker-compose.coolify.yml`: `postgres`, `redis`, a one-off `migrator`, `web`, and `worker`, plus the Dependencies services `deps-worker`, `deps-sandbox`, and `deps-egress`. Images build from the repo root via multi-stage `turbo prune` builds (Node 26 Alpine; Debian slim for `deps-sandbox`).
>
> **Related Docs:** [./configuration.md](./configuration.md) · [../apps/deps-sandbox.md](../apps/deps-sandbox.md) · [../packages/db.md](../packages/db.md#migrations)

## Services

| Service | Image / build | Purpose | Health |
| --- | --- | --- | --- |
| `postgres` | `deploy/postgres/Dockerfile` (`postgres:19-alpine3.24` with PG 16 and 18 binaries bundled for in-place upgrade), volume `postgres_data:/var/lib/postgresql` | State | `pg_isready` (`start_period: 60s`) |
| `redis` | `redis:8-alpine`, `--appendonly yes --maxmemory-policy noeviction --requirepass`, volume `redis_data` | BullMQ + Pub/Sub. **`noeviction` is required by BullMQ** | `redis-cli ping` |
| `migrator` | `apps/worker/Dockerfile` target `migrator` | `prisma migrate deploy`, exits 0 (`restart: "no"`) | — |
| `web` | `apps/web/Dockerfile` (standalone Next output, `node apps/web/server.js`, user `nextjs`, `HOSTNAME="::"`) | UI and SSE on 3000 | `wget localhost:3000/api/health` |
| `worker` | `apps/worker/Dockerfile` target `runner` (`node apps/worker/dist/index.js`) | Jobs, health on 3001. `stop_grace_period: 30s` | `wget localhost:3001/health` |
| `deps-worker` | `apps/deps-worker/Dockerfile` target `runner` (`node apps/deps-worker/dist/index.js`, user `node`) | Dependency scans, PRs, notifications; health on 3002. Networks `default` + `deps_sandbox`. `stop_grace_period: 30s` | `wget localhost:3002/health` |
| `deps-sandbox` | `apps/deps-sandbox/Dockerfile` (`node:26-trixie-slim`, Python 3.13, `tini`, uid `10001`) | Lockfile regeneration on 3003. Network `deps_sandbox` only | `fetch 127.0.0.1:3003/health` |
| `deps-egress` | `deploy/deps-egress/Dockerfile`: `ubuntu/squid:6.6-24.04_edge` pinned by digest with `squid.conf` baked in | Sandbox's only outbound route (port 3128). Networks `default` + `deps_sandbox` (alias `deps-egress`) | TCP `:3128` |

Startup order: `postgres` and `redis` healthy → `migrator` completed successfully → `web`, `worker`, and `deps-worker`. `deps-sandbox` and `deps-egress` have no database dependency and start right away.

## Environment in Compose

- `DATABASE_URL` and `REDIS_URL` are built from YAML anchors (`x-database-url`, `x-redis-url`) using `POSTGRES_*` / `REDIS_PASSWORD`.
- `web`: `AUTH_*`, `TOKEN_ENCRYPTION_KEY`, `RELEASE_BACKFILL_*`, `ALLOW_INTERNAL_WEBHOOK_HOSTS`, `APP_BASE_URL`, and `NEXTAUTH_URL` (both `${SERVICE_URL_WEB}`).
- `worker`: `TOKEN_ENCRYPTION_KEY`, `POLL_INTERVAL_CRON`, concurrency settings, `RELEASE_BACKFILL_*`, `ALLOW_INTERNAL_WEBHOOK_HOSTS`, `APP_BASE_URL`.
- `deps-worker`: `DATABASE_URL`, `REDIS_URL`, `TOKEN_ENCRYPTION_KEY`, `ALLOW_INTERNAL_WEBHOOK_HOSTS`, `APP_BASE_URL`, `DEPS_SANDBOX_URL`, `DEPS_SANDBOX_TOKEN`, `DEPS_SCAN_CRON`, `DEPS_SCAN_CONCURRENCY`, `DEPS_UPDATE_CONCURRENCY`, `DEPS_HEALTH_PORT`.
- `deps-sandbox`: **only** `DEPS_SANDBOX_TOKEN` and `DEPS_SANDBOX_TIMEOUT_MS`. No `env_file`, no volumes. Because Coolify injects `env_file: .env` into every generated service, `apps/deps-sandbox/docker-entrypoint.sh` (PID 1) `exec`s `env -i` with an explicit allowlist before `tini` and `node` start (and the healthcheck runs via `env -i` too). Any new sandbox variable must be added to that allowlist.
- Full list: [configuration.md](./configuration.md).

## Rules

- **MUST** keep `web` and `worker` on the same `TOKEN_ENCRYPTION_KEY` and `RELEASE_BACKFILL_*` values (or override release history in Admin → Release history).
- **MUST** pass every new variable explicitly in each service's `environment:`. Compose does not forward variables implicitly.
- **MUST** use `SERVICE_URL_WEB` (with scheme) for URLs; `SERVICE_FQDN_WEB` is a bare host in Coolify 4.5.
- Migrations run automatically on every deploy (`migrator`). A failing migration blocks `web`, `worker`, and `deps-worker`, so test locally first ([../packages/db.md](../packages/db.md#migrations)).
- The sandbox token comes from Coolify's `SERVICE_PASSWORD_64_DEPSSANDBOX`: Coolify generates and stores it on first deploy and passes the same value to `deps-worker` and `deps-sandbox` as `DEPS_SANDBOX_TOKEN`. **MUST NOT** rename it or replace it with `${DEPS_SANDBOX_TOKEN}` (Coolify omits unset variables from runtime `.env`, causing `deps-sandbox` to crash-loop). Outside Coolify, set `SERVICE_PASSWORD_64_DEPSSANDBOX` (`.env.example` reuses `${DEPS_SANDBOX_TOKEN}`).
- **MUST NOT** give `deps-sandbox` extra environment, volumes, `env_file`, or networks, or relax its hardening ([../apps/deps-sandbox.md](../apps/deps-sandbox.md)).
- **MUST** keep `deps_sandbox` `internal: true`, and verify after first deploy (below).
- **MUST NOT** bind-mount repository files (`./deploy/...:/path`) in `docker-compose.coolify.yml`: Coolify keeps only the generated compose file and `.env` on the host, so missing source paths turn into empty directories. Bake config files into images via `build:` (as `deploy/deps-egress/Dockerfile` does for `squid.conf`).
- New containerized apps follow the same `turbo prune @repopulse/<app> --docker` pattern from repo root.

## Docker Images (How They Build)

1. `pruner`: `turbo prune @repopulse/<app> --docker` in each app `Dockerfile`.
2. `installer`: `pnpm install --frozen-lockfile` (`allowBuilds` in `pnpm-workspace.yaml` allows Prisma install scripts) with BuildKit cache mounts, then `pnpm turbo run build --filter=@repopulse/<app>` (runs `^db:generate`).
3. `runner`: minimal runtime. `web` copies `.next/standalone` and `.next/static` (`outputFileTracingRoot` at monorepo root); `worker`, `deps-worker`, and `deps-sandbox` prune devDependencies and strip `src/` and `*.test.ts`. `deps-sandbox` installs pinned tools (SHA-256 verified `uv`, per-platform npm packages for `pnpm`/`Bun` without install scripts), strips Corepack/Yarn, and runs as `sandbox` under `tini`.

## Dependencies services: network and hardening

- Network `deps_sandbox` (`internal: true`): `deps-sandbox` (only here), `deps-egress`, and `deps-worker` (both also on `default`). The proxy permits `CONNECT :443` only to `registry.npmjs.org`, `registry.yarnpkg.com`, `pypi.org`, and `files.pythonhosted.org`, denying everything else including private ranges. Test commands live in `deploy/deps-egress/README.md`.
- `deps-sandbox` hardening: `read_only: true`, `tmpfs: /tmp:size=2g`, `cap_drop: [ALL]`, `security_opt: [no-new-privileges:true]`, `pids_limit: 512`, `mem_limit: 2g`, `cpus: 2`, non-root `sandbox` user.
- **Coolify check:** after deploying, verify `docker network inspect <name>_deps_sandbox` (`"Internal": true`) and `docker inspect <deps-sandbox container> -f '{{json .NetworkSettings.Networks}}'` (only `deps_sandbox`). Confirm the `example.com` test in `deploy/deps-egress/README.md` fails.
- **Fallback if Coolify drops `internal` or attaches another network:** in Docker's `DOCKER-USER` chain, drop forwarded traffic from the sandbox IP outside the `deps_sandbox` subnet (e.g., `iptables -I DOCKER-USER -s <sandbox IP> ! -d <deps_sandbox subnet> -j DROP`) and re-apply after container recreates.
- `deps-worker` polls sandbox `GET /health` every 30 s and publishes it via `deps:worker:heartbeat` to Admin → Dependencies.

## Verifying a Deployment

- `GET https://<host>/api/health` → `200`.
- `worker` logs `repo-scheduler registered with cron "…"` then `ready`; `GET :3001/health` reports `database` and `redis`.
- `deps-worker` logs `deps-scheduler registered with cron "…"` then `ready`; `deps-sandbox` logs `listening on :3003`.
- Sign in (first account = super admin), configure **Admin → Email** and **Send test email**, and optionally enable **Admin → Dependencies** and **Admin → GitHub App** ([../guides/auth-and-access.md](../guides/auth-and-access.md#github-app-dependencies)).

## Local Full-Stack Smoke Test

```sh
cp .env.example .env     # fill in secrets (incl. DEPS_SANDBOX_TOKEN); SERVICE_URL_WEB=http://localhost:3000
docker compose -f docker-compose.coolify.yml up --build
```

## Upgrading PostgreSQL 16/18 → 19 and Redis 7 → 8

- **Redis 7 → 8:** upgrades in-place automatically on deploy.
- **PostgreSQL 16/18 → 19:** `deploy/postgres/Dockerfile` bundles PG 16, 18, and 19 binaries (`alpine3.24`). On first boot with an existing PG 16 or 18 `postgres_data` volume (`/var/lib/postgresql`), `docker-entrypoint-upgrade.sh` moves `/var/lib/postgresql/18/docker` (`18-pre-upgrade`) or legacy `/var/lib/postgresql/PG_VERSION` (`16-pre-upgrade`), runs crash recovery, matches superuser/encoding/locale/checksum settings, and runs `pg_upgrade` in copy mode into `/var/lib/postgresql/19/docker`, preserving `pg_hba.conf`. Once verified, you may reclaim disk space with `rm -rf /var/lib/postgresql/16-pre-upgrade /var/lib/postgresql/18-pre-upgrade` inside the `postgres` container. Subsequent boots hand off directly to `docker-entrypoint.sh`.

## Upgrading from Legacy Releases

- **From pre-Dependencies (< 0.9.0):** deploy runs `20261103090000_dependency_projects` + `20261103100000_github_app` migrations and starts `deps-worker`/`deps-sandbox`/`deps-egress`. Verify `deps_sandbox` internal network check; module stays off until enabled in Admin → Dependencies; existing notification rules retain `[RELEASES]`.
- **From env-based SMTP (< 0.5.0):** deploy runs `isAdmin` → `isSuperAdmin` and SMTP migrations; re-enter SMTP settings in **Admin → Email**, remove old `SMTP_*` env vars, and use `SERVICE_URL_WEB` instead of `SERVICE_FQDN_WEB`.

# Deployment (Coolify / Docker Compose)

> **Summary:** Coolify's **Docker Compose** build pack deploys `docker-compose.coolify.yml`: `postgres`, `redis`, a
> one-off `migrator`, `web` and `worker`, plus the Dependencies services `deps-worker`, `deps-sandbox` and
> `deps-egress`. Images are built from this repository with multi-stage `turbo prune` builds (Node 26 Alpine; the
> sandbox uses Debian slim).

## Services

| Service | Image / build | Purpose | Health |
| --- | --- | --- | --- |
| `postgres` | `postgres:16-alpine`, volume `postgres_data` | State | `pg_isready` |
| `redis` | `redis:7-alpine`, `--appendonly yes --maxmemory-policy noeviction --requirepass`, volume `redis_data` | BullMQ + Pub/Sub. **`noeviction` is required by BullMQ** | `redis-cli ping` |
| `migrator` | `apps/worker/Dockerfile` target `migrator` | `prisma migrate deploy`, then exits 0 (`restart: "no"`) | — |
| `web` | `apps/web/Dockerfile` (standalone Next output, `node apps/web/server.js`, user `nextjs`, `HOSTNAME="::"`) | UI and SSE on 3000 | `wget localhost:3000/api/health` |
| `worker` | `apps/worker/Dockerfile` target `runner` (`node apps/worker/dist/index.js`) | Jobs, health on 3001. `stop_grace_period: 30s` | `wget localhost:3001/health` |
| `deps-worker` | `apps/deps-worker/Dockerfile` target `runner` (`node apps/deps-worker/dist/index.js`, user `node`) | Dependency scans, update PRs, dependency notifications; health on 3002. Networks `default` + `deps_sandbox`. `stop_grace_period: 30s` | `wget localhost:3002/health` |
| `deps-sandbox` | `apps/deps-sandbox/Dockerfile` (`node:26-trixie-slim`, Python 3.13, npm 12.2.1, pnpm 12.14.0, Bun 1.4.3, uv 0.13.1, Poetry 2.5.1, `tini`, uid 10001) | Lockfile regeneration on 3003. Network `deps_sandbox` only. Hardened (below) | `fetch 127.0.0.1:3003/health` |
| `deps-egress` | `deploy/deps-egress/Dockerfile`: `ubuntu/squid:6.6-24.04_edge` pinned by digest with `squid.conf` baked in (Coolify keeps no repository files on the host, so a bind mount would fail) | The sandbox's only way out (port 3128). Networks `default` + `deps_sandbox` (alias `deps-egress`) | — |

Startup order: `postgres` and `redis` healthy → `migrator` completed successfully → `web`, `worker` and `deps-worker`.
`deps-sandbox` and `deps-egress` have no database dependency and start right away.

## Environment in compose

- `DATABASE_URL` and `REDIS_URL` are built from YAML anchors (`x-database-url`, `x-redis-url`) using
  `POSTGRES_*` / `REDIS_PASSWORD`.
- `web`: `AUTH_*`, `TOKEN_ENCRYPTION_KEY`, `RELEASE_BACKFILL_*`, `ALLOW_INTERNAL_WEBHOOK_HOSTS`,
  `APP_BASE_URL` and `NEXTAUTH_URL` (both `${SERVICE_URL_WEB}`).
- `worker`: `TOKEN_ENCRYPTION_KEY`, `POLL_INTERVAL_CRON`, the concurrency settings, `RELEASE_BACKFILL_*`,
  `ALLOW_INTERNAL_WEBHOOK_HOSTS`, `APP_BASE_URL`.
- `deps-worker`: `DATABASE_URL`, `REDIS_URL`, `TOKEN_ENCRYPTION_KEY`, `ALLOW_INTERNAL_WEBHOOK_HOSTS`, `APP_BASE_URL`,
  `DEPS_SANDBOX_URL`, `DEPS_SANDBOX_TOKEN`, `DEPS_SCAN_CRON`, `DEPS_SCAN_CONCURRENCY`, `DEPS_UPDATE_CONCURRENCY`,
  `DEPS_HEALTH_PORT`.
- `deps-sandbox`: **only** `DEPS_SANDBOX_TOKEN` and `DEPS_SANDBOX_TIMEOUT_MS`. No `env_file`, no volumes. Coolify
  still adds `env_file: .env` to every service of the compose file it generates, so the container *config* holds the
  app's whole `.env`. The image's entrypoint (`apps/deps-sandbox/docker-entrypoint.sh`, PID 1) therefore `exec`s
  `env -i` with an allowlist before `tini` and `node` start, and the healthcheck runs through `env -i` too: no
  process inside the container ever has the database, Redis, auth or encryption secrets. A new sandbox variable
  must be added to that allowlist.
- No SMTP or GitHub App variables: the super admin sets SMTP in Admin → Email and the App in Admin → GitHub App.
- Full list: [configuration.md](./configuration.md).

## Rules

- **MUST** keep `web` and `worker` on the same `TOKEN_ENCRYPTION_KEY` and `RELEASE_BACKFILL_*` values (or set the
  release history in Admin → Release history, which overrides both).
- **MUST** pass a new variable explicitly in each service's `environment:`. Compose does not forward variables
  implicitly.
- **MUST** use `SERVICE_URL_WEB` (with the scheme) for URLs. `SERVICE_FQDN_WEB` is a bare host in Coolify 4.5.
- Migrations run automatically on every deploy. A failing migration blocks `web`, `worker` and `deps-worker` from
  starting, so test it locally first ([data-model.md](./data-model.md#migrations)).
- The sandbox token comes from the Coolify magic variable `SERVICE_PASSWORD_64_DEPSSANDBOX`: Coolify generates it on
  the first deploy, stores it, and passes the same value to `deps-worker` and `deps-sandbox` as `DEPS_SANDBOX_TOKEN`.
  Nothing to set by hand. **MUST NOT** rename it (a new name generates a new value) or replace it with a plain
  `${DEPS_SANDBOX_TOKEN}`: Coolify does not write unset variables to the runtime `.env`, and without a token
  `deps-sandbox` restarts in a loop (`DEPS_SANDBOX_TOKEN must be set (at least 16 characters)`) and Admin →
  Dependencies shows "Sandbox unreachable". Outside Coolify, set `SERVICE_PASSWORD_64_DEPSSANDBOX` yourself
  (`.env.example` reuses `${DEPS_SANDBOX_TOKEN}`).
- **MUST NOT** give `deps-sandbox` more environment, volumes, `env_file` or networks, or relax its hardening. It runs
  third-party package managers on untrusted repository files ([dependencies.md](./dependencies.md#rules)).
- **MUST** keep `deps_sandbox` `internal: true`, and check after the first deploy that Coolify kept it (below).
- **MUST NOT** bind-mount repository files (`./deploy/...:/path`) in `docker-compose.coolify.yml`. Coolify keeps only
  the generated compose file and `.env` on the host, so the missing source becomes an empty directory and the
  container fails to start ("Are you trying to mount a directory onto a file"). Bake files into an image with a
  `build:` (as `deploy/deps-egress/Dockerfile` does for `squid.conf`).
- A new app with a Dockerfile follows the same `turbo prune @repopulse/<app> --docker` pattern; Coolify builds each
  service's image from the repository root.

## Docker images (how they build)

1. `pruner`: `turbo prune @repopulse/<app> --docker`, in each of `apps/web/Dockerfile`, `apps/worker/Dockerfile`,
   `apps/deps-worker/Dockerfile` and `apps/deps-sandbox/Dockerfile`.
2. `installer`: `pnpm install --frozen-lockfile` (the `allowBuilds` block in `pnpm-workspace.yaml` lets Prisma's
   install scripts run), then `pnpm turbo run build --filter=@repopulse/<app>`. Build depends on `^db:generate`, so the
   Prisma client is generated inside the image.
3. `runner`: a minimal runtime. The web image copies `.next/standalone` and `.next/static`; standalone tracing is
   rooted at the monorepo (`outputFileTracingRoot`). `deps-worker` and `deps-sandbox` copy a `pnpm prune --prod`
   tree. The sandbox runner installs the pinned tools (uv checked by SHA-256, pnpm / Bun from their per-platform npm
   packages without install scripts), removes Corepack and Yarn, and runs as the `sandbox` user under `tini`.

## Dependencies services: network and hardening

- Network `deps_sandbox` (`internal: true`): `deps-sandbox` (only there), `deps-egress` and `deps-worker` (both also on
  `default`). The sandbox can reach only its caller and the proxy; the proxy allows `CONNECT` on 443 to
  `registry.npmjs.org`, `registry.yarnpkg.com`, `pypi.org` and `files.pythonhosted.org` and denies everything else,
  private ranges included. Test it with the commands in `deploy/deps-egress/README.md`.
- `deps-sandbox` hardening: `read_only: true`, `tmpfs: /tmp:size=2g` (job dirs and caches), `cap_drop: [ALL]`,
  `security_opt: [no-new-privileges:true]`, `pids_limit: 512`, `mem_limit: 2g`, `cpus: 2`, non-root user.
- **Coolify check**: after deploying, run `docker network inspect <name>_deps_sandbox` (`"Internal": true`) and
  `docker inspect <deps-sandbox container> -f '{{json .NetworkSettings.Networks}}'` (only the `deps_sandbox` network).
  Then the `example.com` test from the README must fail.
- **Fallback when Coolify drops `internal` or attaches the sandbox to another network**: block the sandbox at the host
  firewall. In Docker's `DOCKER-USER` chain, drop forwarded traffic from the sandbox's addresses to anything outside
  the `deps_sandbox` subnet (the proxy is inside it), for example
  `iptables -I DOCKER-USER -s <sandbox IP> ! -d <deps_sandbox subnet> -j DROP` for each address the sandbox has.
  Container addresses change when the container is recreated, so re-apply the rule after deploys (or pin the
  sandbox's addresses with `ipv4_address`), and re-run the `example.com` test.
- `deps-worker` reads the sandbox's `GET /health` every 30 s and stores it in its Redis heartbeat: Admin →
  Dependencies shows whether the worker runs and which tool versions the sandbox reports.

## Verifying a deployment

- `GET https://<host>/api/health` → 200.
- Worker logs: `repo-scheduler registered with cron "…"` then `ready`. `GET :3001/health` reports `database` and
  `redis`.
- `deps-worker` logs: `deps-scheduler registered with cron "…"` then `ready` (a `DEPS_SANDBOX_TOKEN is not set`
  warning means lockfile PRs are off). `deps-sandbox` logs `listening on :3003 (npm …, pnpm …; proxy on)`.
- Admin → Dependencies: turn the module on, check "worker running" and the sandbox tool versions. Admin → GitHub App:
  create the App if you want private repositories or update PRs ([auth-and-access.md](./auth-and-access.md#github-app-dependencies)).
- Sign in. The first account is the super admin. Configure **Admin → Email** and click **Send test email**.

## Local full-stack smoke test

```sh
cp .env.example .env     # fill in the secrets (incl. DEPS_SANDBOX_TOKEN); SERVICE_URL_WEB=http://localhost:3000
docker compose -f docker-compose.coolify.yml up --build
```

## Upgrading to the Dependencies release (0.9.0)

1. Nothing to set for the sandbox token: since 0.9.3 Coolify generates it (`SERVICE_PASSWORD_64_DEPSSANDBOX`).
2. Deploy. The migrator applies `20261103090000_dependency_projects` and `20261103100000_github_app`; the three new
   services and the `deps_sandbox` network are created. Run the Coolify network check above.
3. The module stays **off** until the super admin enables it in Admin → Dependencies. Existing notification rules keep
   sending releases only (`events = [RELEASES]`).

## Upgrading to 0.5.0

1. Deploy. The migrator applies the 0.5.0 migrations (`isAdmin` → `isSuperAdmin`, SMTP columns, and the earlier 0.5.0
   ones).
2. If email was configured through `SMTP_*`, enter the same values in **Admin → Email**, then remove the old
   variables from Coolify.
3. Make sure `SERVICE_URL_WEB` is available (Coolify provides it) and remove any manual `SERVICE_FQDN_WEB` override.

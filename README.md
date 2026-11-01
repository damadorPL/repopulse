# RepoPulse

Self-hostable GitHub release & changelog tracker — Turborepo + pnpm monorepo deployed on Coolify.

| Workspace | Description |
| --- | --- |
| `apps/web` | Next.js (App Router) UI + API, GitHub sign-in (Auth.js v5), `GET /api/health` |
| `apps/worker` | BullMQ worker: cron scheduler, ETag-aware repository poller (releases + optional Git tags), release-history backfill, notification hand-off, `GET :3001/health` |
| `packages/db` | Prisma schema, migrations, singleton client, AES-256-GCM token crypto |
| `packages/github` | Octokit wrapper, repo-input parser, SemVer classifier, ETag-aware release polling, GraphQL tag reader + commit compare |
| `packages/queue` | Shared BullMQ queue names, job payloads, Redis connection factory and the SSE event contract |
| `packages/tsconfig` | Shared TypeScript configs |

## Local development

Requires Node.js 24+ (Docker images use Node 26 LTS) and pnpm (version pinned in `package.json#packageManager`).

```sh
pnpm install
pnpm env:setup            # once: writes a git-ignored .env with generated secrets
                          # then fill in AUTH_GITHUB_ID / AUTH_GITHUB_SECRET (see below)
pnpm services:up          # Postgres + Redis on localhost (docker-compose.dev.yml)
pnpm db:migrate:deploy    # apply migrations
pnpm dev                  # http://localhost:3000
pnpm typecheck && pnpm test && pnpm build
```

After pulling a slice that introduces new settings, run `pnpm env:sync`. It adds any missing keys to `.env.example`
and `.env` and leaves existing values untouched (`pnpm env:sync --check` only reports what's missing).

The single root `.env` is loaded automatically in non-production runs by `apps/web/next.config.ts`,
`packages/db/prisma.config.ts` and the worker's `dev` script. Variables already set in the shell
take precedence. `pnpm services:down` stops the dev services (`docker compose -f docker-compose.dev.yml down -v`
also wipes their data).

The database layer uses **Prisma 7**: the client is generated into `packages/db/src/generated`
(git-ignored; `pnpm db:generate` recreates it) and connects through the `@prisma/adapter-pg`
driver adapter. CLI settings live in `packages/db/prisma.config.ts`.

### GitHub sign-in

Create a GitHub **OAuth App** (Settings → Developer settings → OAuth Apps) with the callback URL
`<your-origin>/api/auth/callback/github` (locally: `http://localhost:3000/api/auth/callback/github`),
then set `AUTH_GITHUB_ID`, `AUTH_GITHUB_SECRET`, `AUTH_SECRET` and `TOKEN_ENCRYPTION_KEY`. The app
requests `read:user user:email`; the OAuth token is stored AES-256-GCM encrypted on the `User` row
and never placed in the session cookie.

## Production (Coolify)

Use the **Docker Compose** build pack with `docker-compose.coolify.yml`. Set the variables
listed in `.env.example` (generate `TOKEN_ENCRYPTION_KEY` and `AUTH_SECRET` with
`openssl rand -hex 32`).

Startup order: `postgres` + `redis` healthy → `migrator` runs `prisma migrate deploy` and exits 0 →
`web` and `worker` start.

Local smoke test of the full stack:

```sh
cp .env.example .env      # fill in secrets
docker compose -f docker-compose.coolify.yml up --build
```

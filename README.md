# RepoPulse

Self-hostable GitHub release & changelog tracker — Turborepo + pnpm monorepo deployed on Coolify.

| Workspace | Description |
| --- | --- |
| `apps/web` | Next.js (App Router) UI + API, GitHub sign-in (Auth.js v5), `GET /api/health` |
| `apps/worker` | Long-running Node worker (BullMQ in a later slice), `GET :3001/health` |
| `packages/db` | Prisma schema, migrations, singleton client, AES-256-GCM token crypto |
| `packages/github` | Octokit wrapper, repo-input parser, SemVer classifier, ETag-aware release polling |
| `packages/tsconfig` | Shared TypeScript configs |

## Local development

Requires Node.js 24+ (Docker images use Node 26 LTS) and pnpm (version pinned in `package.json#packageManager`).

```sh
pnpm install
pnpm db:generate          # prisma generate
pnpm typecheck
pnpm test                 # crypto round-trip / tamper tests
pnpm build
```

The database layer uses **Prisma 7**: the client is generated into `packages/db/src/generated`
(git-ignored; `pnpm db:generate` recreates it) and connects through the `@prisma/adapter-pg`
driver adapter. CLI settings live in `packages/db/prisma.config.ts`. Prisma 7 does **not** load
`.env` files, so export `DATABASE_URL` in your shell before running migrations, e.g.
`DATABASE_URL=postgresql://… pnpm --filter @repopulse/db db:migrate:dev`.

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

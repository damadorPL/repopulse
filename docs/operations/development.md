# Development

> **Summary:** pnpm + Turborepo monorepo. Local PostgreSQL 19 and Redis 8 run in Docker (`docker-compose.dev.yml`); apps run on the host with `pnpm dev`. Before finishing any change, verify with `pnpm docs:check && pnpm --filter "./packages/*" build && pnpm typecheck && pnpm lint && pnpm format:check && pnpm test` (plus `pnpm --filter @repopulse/web build` for web changes).
>
> **Related Docs:** [../CODING_STANDARDS.md](../CODING_STANDARDS.md) · [./configuration.md](./configuration.md) · [./deployment.md](./deployment.md)

## First Run

```sh
pnpm install
pnpm env:setup             # writes .env with generated secrets; then fill AUTH_GITHUB_ID / AUTH_GITHUB_SECRET
pnpm services:up           # Postgres 19 + Redis 8 on 127.0.0.1 (5432 / 6379)
pnpm db:migrate:deploy     # apply migrations
pnpm dev                   # web :3000, worker :3001, deps-worker :3002, deps-sandbox :3003
```

The first GitHub account to sign in becomes the super admin. After pulling changes that add env vars, run `pnpm env:sync`.

## Commands

| Command | Does |
| --- | --- |
| `pnpm dev` | All `dev` tasks (`web` `:3000`, `worker` `:3001`, `deps-worker` `:3002`, `deps-sandbox` `:3003`) |
| `pnpm build` | Build every package and app (`db:generate` runs first) |
| `pnpm typecheck` | `tsc --noEmit` everywhere (`web` runs `next typegen` first) |
| `pnpm lint` | Oxlint (`--type-aware --deny-warnings`) across all workspaces and scripts |
| `pnpm format` / `pnpm format:check` | Format / verify formatting with Oxfmt (`.oxfmtrc.json`) |
| `pnpm docs:check` | Validate relative links, `#anchors`, `AGENTS.md` line budgets/hygiene, and workspace doc coverage |
| `pnpm test` / `pnpm test:coverage` | Vitest 5 across all workspaces (with V8 coverage for `test:coverage`) |
| `pnpm --filter <pkg> <script>` | Run a script in one workspace (e.g., `pnpm --filter @repopulse/worker test`) |
| `pnpm --filter "./packages/*" build` | Rebuild workspace library `dist/` outputs (required before apps/tests pick up package edits) |
| `pnpm db:generate` | Regenerate Prisma Client into `packages/db/src/generated` |
| `pnpm db:migrate:deploy` | Apply pending migrations to `DATABASE_URL` |
| `cd packages/db && npx prisma migrate dev --create-only --name x` | Scaffold a new Prisma migration |
| `pnpm env:setup` / `pnpm env:sync` | Bootstrap or update root `.env` / `.env.example` |
| `pnpm deps:check` / `pnpm deps:sandbox:check` | Check upstream dependency / sandbox tool updates |
| `pnpm services:up` / `pnpm services:down` | Start or stop dev Postgres & Redis (`down -v` wipes data) |
| `npx vitest run path/to/file.test.ts` (inside workspace) | Run a single test file |

## Tooling, Gotchas & Testing

Engineering rules, workspace boundaries, Next.js 16 / React 19 gotchas, Vitest mocking conventions, and error-redaction standards are consolidated in [../CODING_STANDARDS.md](../CODING_STANDARDS.md).

GitHub Actions CI (`.github/workflows/ci.yml`) runs on `push` to `main` and `pull_request` (Node 26): `pnpm install --frozen-lockfile` → `pnpm db:generate` → `pnpm --filter "./packages/*" build` → `pnpm typecheck` → `pnpm lint` → `pnpm format:check` → `pnpm docs:check` → `pnpm test` → `pnpm --filter @repopulse/web build`.

## Git & Release Workflow

- Conventional Commits: `feat: …`, `fix(web): …`, `fix(deploy): …`, `docs: …`.
- Work happens on `main`. To publish, commit on `main`, merge `origin/main` if it moved (`git pull --no-rebase origin main`), then push. No feature branches or PRs.
- Bumping `version` in `apps/web/package.json` (with matching notes in `CHANGELOG.md`) on `main` triggers [`.github/workflows/release.yml`](../../.github/workflows/release.yml), creating the `v<version>` tag and GitHub Release automatically.
- Coding agents commit or push **only when asked**, and never stage `.env*` files.

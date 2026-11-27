# Development

> **Summary:** pnpm + Turborepo monorepo. Local PostgreSQL 19 and Redis 8 run in Docker (`docker-compose.dev.yml`); apps run on the host with `pnpm dev`. Before finishing any change, verify with `pnpm verify` (supports `--fix`, `--skip-build`, `--fail-fast`, and `--only <steps>`).
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
| `pnpm verify` | Run all static, build, typecheck, lint, css, knip, format, doctor, test, docs, and web build gates |
| `pnpm dev` | All `dev` tasks (`web` `:3000`, `worker` `:3001`, `deps-worker` `:3002`, `deps-sandbox` `:3003`) |
| `pnpm build` | Build every package and app (`db:generate` runs first) |
| `pnpm typecheck` / `pnpm typecheck:scripts` | `tsc --noEmit` everywhere (`web` runs `next typegen` first) and in `scripts/` |
| `pnpm lint` / `pnpm lint:css` | Oxlint (`typeAware`, `denyWarnings`, `.oxlintrc.json`) and Stylelint (`stylelint.config.mjs`) |
| `pnpm lint:manifests` | Sherif workspace `package.json` manifest hygiene check |
| `pnpm knip` / `pnpm knip:strict` | Knip unused code/exports check and strict production dependency isolation |
| `pnpm doctor` / `pnpm doctor:design` | React Doctor static audit on `apps/web` (`doctor.config.json`) |
| `pnpm check:guardrails` | RepoPulse pinned-deps, SQL/secret safety, migration, and isolation guardrails |
| `pnpm format` / `pnpm format:check` | Format / verify formatting with Oxfmt (`.oxfmtrc.json`) |
| `pnpm docs:check` | Validate relative links, `#anchors`, `AGENTS.md` line budgets/hygiene, and workspace doc coverage |
| `pnpm test` / `pnpm test:scripts` / `pnpm test:coverage` | Vitest 5 across all workspaces and `scripts/tests/` (with V8 coverage for `test:coverage`) |
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

GitHub Actions CI (`.github/workflows/ci.yml` + `.github/workflows/react-doctor.yml`) runs on `push` to `main` and `pull_request`: `ci` (`check:guardrails` → `lint:manifests` → `db:generate` → `packages/* build` → `typecheck` → `lint` → `lint:css` → `knip` → `knip:strict` → `format:check` → `docs:check` → `doctor` → `test` → `@repopulse/web build` → `pnpm audit --audit-level=high`), and React Doctor PR checks. Installing dependencies via `pnpm install` runs `prepare` (`scripts/install-hooks.ts`) to configure `core.hooksPath = .githooks` (running staged guardrails, `docs:check`, and staged `oxfmt --check` / `oxlint` via `scripts/pre-commit-lint.ts` before commits).

## Git & Release Workflow

- Conventional Commits: `feat: …`, `fix(web): …`, `fix(deploy): …`, `docs: …`.
- Work happens on `main`. To publish, commit on `main`, merge `origin/main` if it moved (`git pull --no-rebase origin main`), then push. No feature branches or PRs.
- Bumping `version` in `apps/web/package.json` (with matching notes in `CHANGELOG.md`) on `main` triggers [`.github/workflows/release.yml`](../../.github/workflows/release.yml), creating the `v<version>` tag and GitHub Release automatically.
- Coding agents commit or push **only when asked**, and never stage `.env*` files.

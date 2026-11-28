# Development

> **Summary:** pnpm 12 (`pnpm@12.23.0`) + Turborepo monorepo on Node >= 26. Local PostgreSQL 19 and Redis 8 run in Docker (`docker-compose.dev.yml`); apps run on the host with `pnpm dev`. Before finishing any change, verify with `pnpm verify` (supports `--fix`, `--skip-build`, `--fail-fast`, and `--only <steps>`).
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
| `pnpm knip` / `pnpm knip:production` / `pnpm knip:strict` | Knip unused code/exports check, production-only check, and strict production dependency isolation |
| `pnpm doctor` / `pnpm doctor:design` | React Doctor static audit on `apps/web` (`doctor.config.json`) |
| `pnpm check:guardrails` | RepoPulse pinned-deps, SQL/secret safety, migration, and isolation guardrails |
| `pnpm format` / `pnpm format:check` | Format / verify formatting with Oxfmt (`.oxfmtrc.json`) |
| `pnpm docs:check` | Validate relative links/anchors (including `CHANGELOG.md`), `AGENTS.md` hygiene, workspace doc coverage, and no `PRD/` folder |
| `pnpm test` / `pnpm test:scripts` / `pnpm test:coverage` | Vitest 5 across all workspaces and `scripts/tests/` (with V8 coverage for `test:coverage`) |
| `pnpm --filter <pkg> <script>` | Run a script in one workspace (e.g., `pnpm --filter @repopulse/worker test`) |
| `pnpm --filter "./packages/*" build` | Rebuild workspace library `dist/` outputs (required before apps/tests pick up package edits) |
| `pnpm db:generate` | Regenerate Prisma Client into `packages/db/src/generated/prisma` |
| `pnpm db:migrate:deploy` | Apply pending migrations to `DATABASE_URL` |
| `cd packages/db && npx prisma migrate dev --create-only --name x` | Scaffold a new Prisma migration |
| `pnpm env:setup` / `pnpm env:sync` | Bootstrap or update root `.env` / `.env.example` |
| `pnpm deps:check` / `pnpm deps:sandbox:check` | Check upstream dependency / sandbox tool updates |
| `pnpm services:up` / `pnpm services:down` | Start or stop dev Postgres & Redis (`down -v` wipes data) |
| `npx vitest run path/to/file.test.ts` (inside workspace) | Run a single test file |

## Tooling, Gotchas & Testing

Engineering rules, workspace boundaries, Next.js 16 / React 19 gotchas, Vitest mocking conventions, and error-redaction standards are consolidated in [../CODING_STANDARDS.md](../CODING_STANDARDS.md).

GitHub Actions CI (`.github/workflows/ci.yml` + `.github/workflows/react-doctor.yml`) runs on `push` to `main` and `pull_request`: `ci` (`check:guardrails` → `lint:manifests` → `db:generate` → `packages/* build` → `typecheck` → `lint` → `lint:css` → `knip` → `knip:strict` → `format:check` → `docs:check` → `doctor` → `test` → `@repopulse/web build` → `pnpm audit --audit-level=high`), and React Doctor checks (runs on both `pull_request` and `push` to `main`). Installing dependencies via `pnpm install` runs `prepare` (`scripts/install-hooks.ts`) to configure `core.hooksPath = .githooks` and `commit.template = .gitmessage`. Before commits, `.githooks/pre-commit` runs staged guardrails, `docs:check`, and staged `oxfmt --check` / `oxlint` (`scripts/pre-commit-lint.ts`; set `SKIP_PRECOMMIT_HOOK=1` to bypass), and `.githooks/commit-msg` validates commit messages (`scripts/commit-msg-lint.ts`).

## Git & Release Workflow

- **Conventional Commits (`<= 100` chars subject):** `feat(web): …`, `fix(worker): …`, `fix(deploy): …`, `docs: …`, `chore: …`.
- **Descriptive commit bodies:** Required whenever `>= 2` files are staged or on release commits (`chore: release …`). Separate subject and body with a blank line and cover:
  - **Why / Context:** 1–2 sentences on motivation or root cause.
  - **Grouped changes:** concise bullets by workspace or area (`web`, `worker`, `deps-worker`, `db`, `docs`, `ci`, etc.).
  - **Operational impact (when applicable):** `Migration:`, `Env:`, `Deploy:`, or `BREAKING CHANGE:`.
  - Example:
    ```text
    feat(worker): add jitter to scheduled repo polling

    Avoid synchronized GitHub API bursts when many repositories become due together.

    - worker: add bounded random delay in repo-scheduler before enqueuing poll jobs
    - docs: document scheduler jitter behavior in apps/worker.md
    ```
- **Commit-msg hook:** `.githooks/commit-msg` enforces these rules automatically (`Merge`, `Revert "`, `fixup!`, `squash!`, and `amend!` commits are exempt; set `SKIP_COMMIT_MSG_HOOK=1` to bypass).
- Work happens on `main`. To publish, commit on `main`, merge `origin/main` if it moved (`git pull --no-rebase origin main`), then push. No feature branches or PRs.
- Bumping `version` in `apps/web/package.json` (with matching notes in `CHANGELOG.md`) on `main` triggers [`.github/workflows/release.yml`](../../.github/workflows/release.yml), creating an annotated `v<version>` tag (embedding the release title and `CHANGELOG.md` notes) and GitHub Release automatically.
- Coding agents commit or push **only when asked**, and never stage `.env*` files.

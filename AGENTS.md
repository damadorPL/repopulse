# AGENTS.md

Root guidance and reference router for coding agents working in **RepoPulse** (self-hosted GitHub release & dependency tracker, deployed on Coolify).

> **Subpackages:** [`apps/web`](./apps/web/AGENTS.md) · [`apps/worker`](./apps/worker/AGENTS.md) · [`apps/deps-worker`](./apps/deps-worker/AGENTS.md) · [`apps/deps-sandbox`](./apps/deps-sandbox/AGENTS.md) · [`packages/db`](./packages/db/AGENTS.md) · [`packages/deps`](./packages/deps/AGENTS.md) · [`packages/github`](./packages/github/AGENTS.md) · [`packages/notifications`](./packages/notifications/AGENTS.md) · [`packages/queue`](./packages/queue/AGENTS.md)
> **Core Docs:** [`docs/README.md`](./docs/README.md) · [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) · [`docs/CONTRACTS.md`](./docs/CONTRACTS.md) · [`docs/CODING_STANDARDS.md`](./docs/CODING_STANDARDS.md)
> **App & Package Guides:** [`web`](./docs/apps/web.md) · [`worker`](./docs/apps/worker.md) · [`deps-worker`](./docs/apps/deps-worker.md) · [`deps-sandbox`](./docs/apps/deps-sandbox.md) · [`db`](./docs/packages/db.md) · [`deps`](./docs/packages/deps.md) · [`github`](./docs/packages/github.md) · [`notifications`](./docs/packages/notifications.md) · [`queue`](./docs/packages/queue.md)
> **Guides & Ops:** [`auth-and-access`](./docs/guides/auth-and-access.md) · [`dependencies`](./docs/guides/dependencies.md) · [`recipes`](./docs/guides/recipes.md) · [`configuration`](./docs/operations/configuration.md) · [`deployment`](./docs/operations/deployment.md) · [`development`](./docs/operations/development.md)

## 1. Architecture & Toolchain

- **Monorepo DAG:** Turborepo + pnpm monorepo (`Node >= 26`). `apps/*` depend on `packages/*`; packages never import apps. `packages/notifications` and `packages/deps` do not depend on `packages/db`. `apps/worker` and `apps/deps-worker` never import each other.
- **Built `dist/` Consumption:** Apps and worker/web tests consume `@repopulse/*` packages through `dist/`. Always rebuild packages after editing them.
- **Native ESM & Pinned Versions:** Packages and Node apps use `"type": "module"` and `.js` extensions on relative imports. Pin exact dependency versions (no `^`/`~`; use `pnpm add -E` or `catalog:`).

## 2. Common Commands

```sh
pnpm verify                        # Run full static, build, lint, test, doctor, and docs gates
pnpm docs:check                    # Validate markdown links, anchors, AGENTS.md hygiene & workspace coverage
pnpm check:guardrails              # Run RepoPulse architectural, security, and migration guardrails
pnpm --filter "./packages/*" build # Rebuild workspace packages' dist/ outputs
pnpm typecheck                     # tsc --noEmit across all workspaces and scripts/
pnpm lint                          # oxlint --type-aware --deny-warnings (.oxlintrc.json)
pnpm lint:css                      # Stylelint CSS & Tailwind v4 check
pnpm lint:manifests                # Sherif workspace package.json hygiene check
pnpm knip                          # Dead code, unused exports, and dependency check (knip:strict for prod deps)
pnpm run doctor                    # React Doctor static analysis on apps/web (verbose; blocks on errors & warnings)
pnpm format:check                  # Verify Oxfmt formatting (run `pnpm format` to fix)
pnpm test                          # Vitest across all workspaces and scripts/
pnpm --filter @repopulse/web build # Production Next.js build (required for web changes)
pnpm db:generate                   # Regenerate Prisma Client
pnpm db:migrate:deploy             # Apply migrations to local DATABASE_URL
pnpm env:sync                      # Sync missing keys between .env.example and .env
```

## 3. Non-Negotiable Invariants

- **Auth & Scoping:** Filter every user-scoped query by the signed-in user (`getCurrentUserOrThrow()` / `requireUser()`). Guard instance settings with `getSuperAdminOrThrow()` / `requireSuperAdmin()`.
- **Server Actions:** Return `ActionResult<T>` (`toActionError`), validate with Zod, and keep Zod schemas in server-only `*-schema.ts` modules away from client bundles.
- **Feed & Read State:** Route every feed/unread query through `visibleReleasesWhere()`. Missing `UserReleaseState` means "read" (except `COMMIT` rows, which are visible only via a state row). History backfill creates no unread rows.
- **Secrets & SSRF:** Encrypt tokens, SMTP passwords, and GitHub App secrets (`encryptToken`, Prisma `GLOBAL_OMIT`), never return raw secrets or webhook URLs (`maskDestination`), and pass webhook URLs through the two-layer SSRF guard.
- **Migrations:** Every schema change needs a new migration in `packages/db/prisma/migrations/`. Never edit a shipped migration.
- **Sandbox & GitHub App Isolation:** Never run package managers or repo scripts outside `deps-sandbox` (`deps_sandbox` internal network + `deps-egress` proxy). Repository writes go through the per-repo GitHub App, never user OAuth tokens.

## 4. Workflow, Docs & Commit Rules

- **Keep `AGENTS.md` Timeless & Lean:** Enforce `<= 120` lines root and `<= 60` lines per subpackage; never add changelogs, history sections, slice labels, version banners, or commit hashes.
- **Docs & Changelog:** [`docs/`](./docs/README.md) is the sole source of truth for current repository architecture and guides (no `PRD/` directory). Update affected `docs/` files when behavior changes, and record user-visible changes, migrations, and env vars in `CHANGELOG.md` under `## [Unreleased]`.
- **Commit Messages:** Follow Conventional Commits (`type(scope?): summary`, `<= 100` chars). Commits touching `>= 2` files or releasing a version must include a blank line and body explaining why/context, grouped changes by workspace/area, and operational impact (`Migration:`, `Env:`, `Deploy:`, `BREAKING CHANGE:`) when applicable (`.gitmessage`, `.githooks/commit-msg`).
- **Verification & Git:** Verify changes with `pnpm verify` (runs guardrails, manifests, packages build, typecheck, oxlint, stylelint, knip, knip:strict, format:check, react-doctor, tests, docs:check, and `@repopulse/web` build). Always inspect the full `pnpm run doctor` / React Doctor output (never skip truncated logs) and resolve every reported error and warning (`0 issues`). Work on `main`; commit or push only when asked; never stage `.env*` files.

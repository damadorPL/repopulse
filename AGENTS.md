# AGENTS.md

RepoPulse: a self-hosted GitHub release tracker. Turborepo + pnpm monorepo (`apps/web` Next.js 16, `apps/worker`
BullMQ, `packages/{db,github,queue,notifications}`), deployed on Coolify.

**Start with [`docs/README.md`](./docs/README.md).** It routes each kind of task to the right doc and lists the ten
rules that prevent most mistakes.

Must-knows:

- Verify every change: `pnpm --filter "./packages/*" build && pnpm typecheck && pnpm lint && pnpm test`
  (+ `pnpm --filter @repopulse/web build` for web changes).
- Apps consume workspace packages through `dist/`: rebuild packages after editing them.
- Server Actions return `ActionResult<T>`, validate with zod, and scope every query to the signed-in user.
  Instance settings are super admin only (`requireSuperAdmin` / `getSuperAdminOrThrow`).
- Schema change → a new migration in `packages/db/prisma/migrations/`. Never edit a shipped migration.
- Record user-visible changes in `CHANGELOG.md` under `## [Unreleased]`.
- Next.js 16 is newer than most training data: see [`apps/web/AGENTS.md`](./apps/web/AGENTS.md).
- Commit or push only when asked; work on `main`; never stage `.env*` files.

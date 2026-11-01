# Development

> **Summary:** pnpm + Turborepo. Local Postgres and Redis run in Docker (`docker-compose.dev.yml`); the apps run on
> the host with `pnpm dev`. Before finishing any change: `pnpm typecheck && pnpm lint && pnpm test`, and
> `pnpm --filter @repopulse/web build` for web changes.

## First run

```sh
pnpm install
pnpm env:setup             # writes .env with generated secrets; then fill AUTH_GITHUB_ID / AUTH_GITHUB_SECRET
pnpm services:up           # Postgres 16 + Redis 7 on 127.0.0.1 (5432 / 6379)
pnpm db:migrate:deploy     # apply migrations
pnpm dev                   # web http://localhost:3000 + worker (tsx watch); builds packages first (^build)
```

The first GitHub account to sign in becomes the super admin. After pulling changes that add settings, run
`pnpm env:sync`.

## Commands

| Command | Does |
| --- | --- |
| `pnpm dev` | All `dev` tasks (web on :3000, worker with health on :3001) |
| `pnpm build` | Every package and app (`db:generate` first) |
| `pnpm typecheck` | `tsc --noEmit` everywhere (web runs `next typegen` first) |
| `pnpm lint` | Lint tasks |
| `pnpm test` | Vitest in every workspace |
| `pnpm --filter <pkg> <script>` | One workspace, e.g. `pnpm --filter @repopulse/worker test` |
| `pnpm --filter "./packages/*" build` | Rebuild the libraries' `dist/` (needed before app tests or runs pick up package changes) |
| `pnpm db:generate` | Regenerate the Prisma client |
| `pnpm db:migrate:deploy` | Apply migrations to `DATABASE_URL` |
| `cd packages/db && npx prisma migrate dev --create-only --name x` | Scaffold a migration |
| `pnpm services:up` / `services:down` | Dev Postgres and Redis (`down -v` also wipes their data) |
| `npx vitest run path/to/file.test.ts` (inside a workspace) | A single test file |

## Testing conventions

- Vitest 5, `environment: "node"`, files next to the code: `src/**/*.test.ts(x)`.
- Keep decision logic pure and test it directly: `fan-out.ts`, `backfill-plan.ts`, `lib/*`, `formatters.test.ts`,
  `ssrf-guard.test.ts`.
- Inject I/O: processors take `deps`, and `dispatchNotification` takes `sendWebhook`, `sendMail`, `resolveAll`,
  `policy` and `smtp`.
- Mock `@repopulse/db` with `vi.mock("@repopulse/db", () => ({ prisma, INSTANCE_SETTINGS_ID: 1 }))`, including every
  export the module reads. Vitest throws on missing mock exports.
- Encryption tests set `process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("hex")` and restore it.
- Never call real GitHub, SMTP or webhooks in tests. For manual end-to-end checks, use a local SMTP or HTTP sink in a
  scratch script (and `ALLOW_INTERNAL_WEBHOOK_HOSTS=localhost` for webhooks).

## Gotchas

1. **Stale `dist/`.** Apps and their tests import `@repopulse/*` through `dist/`. Symptoms: `X is not a function`, or
   `Right-hand side of 'instanceof' is not an object` for a new export. Fix: `pnpm --filter "./packages/*" build`.
2. **Prisma client out of date** after a schema edit: `pnpm db:generate` (Turborepo runs it before build, typecheck
   and test).
3. **Next.js 16**: `params` and `searchParams` are Promises, and `cookies()` is async. Read
   `node_modules/next/dist/docs/` when unsure. `next dev` rewrites `apps/web/AGENTS.md`; commit it as-is.
4. **`"use server"` files export only async functions.** Exporting a constant or type value breaks the build.
5. **Client components must not import `@repopulse/db`**, `server/*` (except types) or Node modules. Use
   `@repopulse/queue/events` and `@repopulse/notifications/channels` for shared browser-safe code.
6. **BullMQ in Next** is loaded as an external package (`serverExternalPackages: ["bullmq", "ioredis"]`).
7. **Windows shells**: the repo is developed on Windows too. Keep scripts cross-platform (Node scripts in `scripts/`,
   not bash), and write files with LF line endings.
8. **Dependency versions are pinned exactly.** Add new ones the same way (`pnpm add -E`).

## Code style

- TypeScript strict and ESM. Use `import type` for types. Prefer small pure functions plus a thin I/O shell.
- Comments explain *why* (constraints, invariants), not what. JSDoc on exported functions and on non-obvious fields.
- User-facing copy: short sentences, no exclamation marks, and say what to do next ("Save the SMTP settings first.").
- Error messages that reach users must not contain secrets (mask URLs; SMTP errors keep the first line only, capped at
  200 characters).

## Changelog and docs

- Add every user-visible change to `## [Unreleased]` in [`CHANGELOG.md`](../CHANGELOG.md) under Added, Changed,
  Removed, Fixed or Security, and name migrations and env changes explicitly.
- When behavior described in `docs/` changes, update the relevant doc in the same change.

## Git workflow

- Conventional Commits: `feat: …`, `fix(web): …`, `fix(deploy): …`, `docs: …`.
- Work happens on `main`. To publish, commit on `main`, merge `origin/main` if it moved (`git pull --no-rebase
  origin main`), then push. No feature branches or PRs.
- Agents commit or push **only when asked**, and never stage `.env*` files.

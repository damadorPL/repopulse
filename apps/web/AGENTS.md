# AGENTS.md — `@repopulse/web` (`apps/web`)

Guidance for coding agents working in the Next.js App Router UI, Server Actions, Better Auth, SSE relay, and webhook routes (`apps/web`).

> **References:** [`docs/apps/web.md`](../../docs/apps/web.md) · [`docs/CONTRACTS.md`](../../docs/CONTRACTS.md) · [`docs/CODING_STANDARDS.md`](../../docs/CODING_STANDARDS.md) · [`docs/guides/auth-and-access.md`](../../docs/guides/auth-and-access.md)

## 1. Non-Negotiable Invariants & Pitfalls

- **Auth & Scoping:** Every page must call `requireUser()` or `requireSuperAdmin()` itself (layouts and pages render in parallel). Actions use `getCurrentUserOrThrow()` / `getSuperAdminOrThrow()` and scope queries by `userId`.
- **Server Actions (`server/actions/*.ts`):** `"use server"` files export only async functions. Validate inputs with Zod from server-only `lib/*-schema.ts` modules, wrap Redis calls in `withRedisTimeout()`, return `ActionResult<T>` via `toActionError`, and call `revalidatePath`.
- **Client Bundle Isolation:** Client components and shared `lib/*` modules must never import `@repopulse/db`, `server/*` (except type-only imports), or `*-schema.ts`. Use browser-safe subpaths (`@repopulse/queue/events`, `@repopulse/notifications/channels`, `@repopulse/github/watched-paths`, `@repopulse/deps/limits`).
- **Feed, CSP & Sanitization:** Route feed/unread queries through `visibleReleasesWhere()`. Render release notes only via server-side `ChangelogMarkdown` (`rehype-sanitize`). Preserve `src/proxy.ts` CSP nonces and semantic dark/light theme tokens.
- **Next.js & React Rules:** `params`, `searchParams`, and `cookies()` are async Promises. Respect `reactCompiler` and `typedRoutes`. Rebuild `packages/*` before running web tests/builds after package edits.

## 2. Commands

```sh
pnpm --filter @repopulse/web build
pnpm --filter @repopulse/web typecheck
pnpm --filter @repopulse/web lint
pnpm --filter @repopulse/web test
```

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

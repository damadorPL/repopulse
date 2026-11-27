# Coding Standards & Non-Negotiable Rules

> **Summary:** repository-wide invariants, TypeScript 7 / ESM conventions, workspace import boundaries, Next.js 16 / React 19 rules, testing patterns, and documentation hygiene.
>
> **Related Docs:** [ARCHITECTURE.md](./ARCHITECTURE.md) · [CONTRACTS.md](./CONTRACTS.md) · [operations/development.md](./operations/development.md)

## Ten Core Rules

1. **Every user-scoped query filters by the signed-in user.** Obtain the user with `getCurrentUserOrThrow()` (actions/routes) or `requireUser()` (pages). Never trust an id from the client without checking ownership (`userId: user.id`).
2. **Instance settings are super admin only.** Use `getSuperAdminOrThrow()` in actions and `requireSuperAdmin()` in pages ([guides/auth-and-access.md](./guides/auth-and-access.md)).
3. **Server Actions return `ActionResult<T>` and never throw to the client.** End them with `catch (error) { return toActionError(error, "<name>"); }` ([CONTRACTS.md](./CONTRACTS.md#server-action-contract)).
4. **Every feed or unread query goes through `visibleReleasesWhere()`**, so the feed, reader, activity grid, and unread counters agree.
5. **A missing `UserReleaseState` row means "read".** Exception: commit rows (`source = COMMIT`, "Files / folders") are visible only *through* a state row recording that the commit matched the user's watched paths. Only genuinely new releases get unread rows; history backfill creates none.
6. **Secrets stay encrypted and server-side.** GitHub tokens, SMTP passwords, and GitHub App private keys / webhook secrets use `encryptToken`/`decryptToken` and are omitted by default in Prisma (`GLOBAL_OMIT`). Never return raw secrets or webhook URLs to the browser (use `maskDestination`).
7. **Webhook URLs pass the two-layer SSRF guard:** `validateWebhookUrl` at rule creation, and `createGuardedLookup` at delivery ([packages/notifications.md](./packages/notifications.md#ssrf-guard)).
8. **Schema changes need a new migration** in `packages/db/prisma/migrations/<YYYYMMDDHHMMSS>_<snake_name>/migration.sql`. Never edit or delete a shipped migration ([packages/db.md](./packages/db.md#migrations)).
9. **Workspace packages are consumed through `dist/`** at runtime and in app tests. After editing `packages/*`, run `pnpm --filter "./packages/*" build`.
10. **Pin exact dependency versions** (no `^` or `~`; use `pnpm add -E` or `catalog:` in `pnpm-workspace.yaml`).

## TypeScript, ESM & Workspace Boundaries

- **TypeScript 7 & Native ESM:** All 5 code packages (`db`, `deps`, `github`, `notifications`, `queue`) and Node apps (`worker`, `deps-worker`, `deps-sandbox`) use `"type": "module"` and require explicit `.js` extensions on relative imports (`verbatimModuleSyntax`, `erasableSyntaxOnly`, `noUncheckedSideEffectImports`, `noFallthroughCasesInSwitch`, `noImplicitOverride`, `noImplicitReturns`). Always use `import type` for type-only imports.
- **Strict Oxlint (`.oxlintrc.json`, `typeAware`, `denyWarnings`, `reportUnusedDisableDirectives: "error"`):**
  - Enforces `typescript/consistent-type-imports`, `consistent-type-exports`, `no-import-type-side-effects`, `no-explicit-any`, `no-unsafe-*`, `no-deprecated`, `no-unnecessary-condition`, `no-unnecessary-type-conversion`, `use-unknown-in-catch-callback-variable`, `prefer-promise-reject-errors`, `switch-exhaustiveness-check`, `only-throw-error`, `return-await`, `no-floating-promises`, `no-misused-promises`, `await-thenable`, `import/*` (`no-cycle`, `no-duplicates`, `no-named-as-default-member`, `no-commonjs`), `promise/*`, `node/*`, `eslint/preserve-caught-error`, `eslint/no-shadow`, `no-console` (`error` in workers/sandbox, `warn`/`error` elsewhere, `info` allowed in `bootstrap-app-role.ts`), `oxc/*` (`no-accumulating-spread`, `no-map-spread`, `branches-sharing-code`), `unicorn/*` (`prefer-node-protocol`, `no-array-sort`, `no-array-reverse`, `consistent-function-scoping` in prod, `prefer-at`), `react/*` (React 19 Compiler/hooks/security), `jsx-a11y/*`, `nextjs/*`, `eslint-plugin-better-tailwindcss` (Tailwind v4 canonical classes & safety), `vitest/*` in tests (`require-to-throw-message`, `prefer-to-be`, `prefer-to-have-length`), and `no-unused-vars` (`_` prefix allowed).
  - Use `oxlint-disable-next-line` (with `-- <reason>`) for intentional suppressions. `apps/web` lint (`pnpm --filter @repopulse/web lint`) runs from repo root so `better-tailwindcss` resolves `apps/web/src/app/globals.css`.
  - `apps/web/src/components/**/*.{ts,tsx}` **MUST NOT** import `@repopulse/db`, `zod`, or `*-schema` modules. Pass plain serialized data from Server Components or call Server Actions.
  - `packages/notifications/src/**/*.ts` **MUST NOT** import `@repopulse/db` (keep inputs structural).
  - `@repopulse/deps` **MUST NOT** depend on `@repopulse/db` or `@octokit/*`.
  - `apps/worker` and `apps/deps-worker` **MUST NOT** import each other.
  - Browser-safe subpaths (`@repopulse/queue/events`, `@repopulse/notifications/channels`, `@repopulse/github/watched-paths`, `@repopulse/deps/limits`, `@repopulse/deps/sandbox-contract`) **MUST NOT** import `node:*`, `ioredis`, `bullmq`, `nodemailer`, or `@repopulse/db`.
- **Static Quality Suite (`pnpm verify`):**
  - **Stylelint (`stylelint.config.mjs`):** `pnpm lint:css` validates CSS and Tailwind v4 rules across `apps/**/*.css` and `packages/**/*.css`.
  - **Sherif (`pnpm lint:manifests`):** validates workspace `package.json` hygiene and `workspace:*` protocols.
  - **Knip (`knip.ts`):** `pnpm knip` (unused files/exports/types/deps with `treatConfigHintsAsErrors: true`) and `pnpm knip:strict` (strict production dependency isolation).
  - **React Doctor (`doctor.config.json`):** `pnpm doctor` audits `apps/web` (`blocking: "error"`, promoting `server-sequential-independent-await`, `js-index-maps`, and `no-non-null-assertion-on-maybe-undefined-result` to `error`). Intentional overrides in `doctor.config.json` are limited to `webhook/route.ts` (HMAC verification in `handleGitHubAppWebhook`), `global-error.tsx` (intentional root error full-page reload link), `email-settings.ts` / `notifications.ts` (bounded 10 s in-memory test-send cooldowns), and `commit-states.ts` (sequential queries inside a single Prisma transaction).
  - **Guardrails (`scripts/guardrails.ts`):** `pnpm check:guardrails` (and `.githooks/pre-commit`, installed via `pnpm prepare`) enforces pinned versions (`deps/pinned-versions`), no unsafe raw SQL (`security/no-raw-sql-unsafe`), no hardcoded PEM private keys (`security/no-hardcoded-secrets`), migration folder naming and immutability (`migrations/folder-naming`, `migrations/no-shipped-migration-edits`), and workspace isolation (`arch/workspace-dep-isolation`), followed by `docs:check` and staged `oxfmt --check` / `oxlint` (`scripts/pre-commit-lint.ts`).
- **Client-bundle Zod isolation (`apps/web`):** Keep Zod schemas in server-only `src/lib/*-schema.ts` modules (never imported by client components) so client chunks do not bundle Zod runtime code.
- **Formatting:** Oxfmt (`.oxfmtrc.json` — double quotes, semicolons, trailing commas, `printWidth: 120`, `sortImports`, and `sortTailwindcss` for `globals.css` + `cn`/`cva`/`clsx`). Run `pnpm format` and verify with `pnpm format:check`.

## Next.js 16 & React 19 Rules

- `params`, `searchParams`, and `cookies()` are async Promises — always `await` them.
- `reactCompiler: true` and `typedRoutes: true` are enabled in `apps/web/next.config.ts`. Avoid `setState`-in-`useEffect` on mount and impure `Date.now()` in render (use `useSyncExternalStore` / client mount state where appropriate).
- `"use server"` files export **only async functions** (no constants, schemas, or non-async helpers).
- Read bundled Next.js docs in `apps/web/node_modules/next/dist/docs/` before using an unfamiliar Next API. Do not remove the `<!-- BEGIN:nextjs-agent-rules -->` block in `apps/web/AGENTS.md`.
- Security headers & per-request CSP nonces are applied by `apps/web/src/proxy.ts`. Never use `dangerouslySetInnerHTML` for release notes (use server-rendered `ChangelogMarkdown` with `rehype-sanitize`).

## Testing Conventions

- Vitest 5 runs via root `vitest.config.ts` (`test.projects`, `unstubEnvs: true`, `restoreMocks: true`, `environment: "node"`). Co-locate tests as `src/**/*.test.ts(x)`.
- Keep decision logic pure and test it directly (`fan-out.ts`, `backfill-plan.ts`, `lib/*`, `formatters.test.ts`, `ssrf-guard.test.ts`, `packages/deps`).
- Inject I/O via `deps` objects (processors take `deps`; `dispatchNotification` takes `sendWebhook`, `sendMail`, `resolveAll`, `policy`, `smtp`).
- Mock `@repopulse/db` with `vi.mock("@repopulse/db", () => ({ prisma, INSTANCE_SETTINGS_ID: 1, ... }))`, including **every** export read by the module under test. When a test pulls in `@/lib/auth`, mock both `UnauthorizedError` and `ForbiddenError`.
- Encryption tests generate an ephemeral key with `randomBytes(32).toString("hex")` in `TOKEN_ENCRYPTION_KEY`.
- Never call live GitHub, SMTP, npm/PyPI, or external webhooks in tests.

## Code Style, Copy & Redaction

- Prefer small pure functions plus a thin I/O shell. Comments explain *why* (constraints, invariants), not *what*. Add concise JSDoc on exported functions and non-obvious fields.
- User-facing copy: short, plain sentences, no exclamation marks, and state what to do next ("Save the SMTP settings first.").
- Error redaction: never leak secrets, private keys, installation tokens, or raw webhook URLs to the browser or logs. Mask URLs, cap SMTP errors to the first line (≤ 200 chars), and keep `deps-sandbox` stderr tails out of PRs, SSE events, and notifications (BullMQ job logs only).
- Cross-platform scripts: write scripts in Node.js (`.ts` checked via `scripts/tsconfig.json` / `pnpm typecheck:scripts` and tested via `pnpm test:scripts`, or `.mjs` in `scripts/`), never bash-only scripts, and use LF line endings.

## Documentation & `AGENTS.md` Hygiene

- **Keep `AGENTS.md` timeless & lean:** enforced by `pnpm docs:check` (`scripts/check-docs.mjs`):
  - Root `AGENTS.md` ≤ 120 lines; every subpackage `AGENTS.md` ≤ 60 lines.
  - Zero changelog/history headings, slice numbers (`Slice 08`), version banners, or backticked git commit hashes in `AGENTS.md`.
  - Every code workspace (`apps/*`, `packages/*` with `src/`) must have `<workspace>/AGENTS.md` and `docs/<workspace>.md`, linked from root `AGENTS.md` and `docs/README.md`.
- **Update docs & `CHANGELOG.md`:** update affected `docs/` files in the same change when behavior changes, and record every user-visible change, migration, and env var under `## [Unreleased]` in `CHANGELOG.md`.

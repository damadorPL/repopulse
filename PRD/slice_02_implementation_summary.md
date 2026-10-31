# Slice 02 — Implementation Summary

**Spec:** [`slice_02_auth_github_ingestion_package.md`](./slice_02_auth_github_ingestion_package.md)
**Status:** Implemented. Unit tests, typecheck and production build pass. The DB acceptance criteria need a live OAuth App and Postgres (see §5).
**Date:** 2026-10-31

---

## 1. Files

```text
packages/github/                       (new)
├── package.json                       ESM ("type": "module"); exports types from src, runtime from dist
├── tsconfig.json / tsconfig.build.json
├── vitest.config.ts
└── src/
    ├── index.ts                       public API barrel
    ├── client.ts                      createOctokit(), getRateLimitInfo(), isGitHubHttpError()
    ├── parser.ts                      parseRepoInput(), classifySemver(), InvalidRepositoryInputError
    ├── poller.ts                      validateAndFetchRepo(), pollRepoReleases(), mapRelease(), typed errors
    ├── parser.test.ts                 37 tests
    └── poller.test.ts                 5 tests (mocked fetch: 200 / 304 / 404 / rate limit)

apps/web/
├── package.json                       + @repopulse/github, next-auth@5.0.0-beta.32, zod@4.6.7
└── src/
    ├── lib/auth.ts                    Auth.js config, encrypted token persistence, getCurrentUserOrThrow()
    ├── app/api/auth/[...nextauth]/route.ts
    ├── app/login/page.tsx             "Sign in with GitHub" + error messages
    ├── app/page.tsx                   temporary signed-in shell (add / list / remove repos, sign out)
    └── server/actions/repositories.ts addRepositoryAction(), removeSubscriptionAction()

turbo.json                             dev now depends on ^build
README.md                              workspace table + GitHub OAuth App setup
```

## 2. Dependency versions (latest at implementation time)

| Package | Version | Note |
| --- | --- | --- |
| `@octokit/rest` | 22.0.1 | ESM-only, hence `@repopulse/github` is ESM |
| `semver` / `@types/semver` | 7.8.5 / 7.8.0 | |
| `next-auth` | 5.0.0-beta.32 | Auth.js v5 is only published as a beta; the latest stable release is v4 (4.24.15) |
| `zod` | 4.6.7 | validates Server Action input |

## 3. Design notes

### `@repopulse/github`
- **No Prisma dependency.** `SemverType` is a local string union that matches the Prisma enum. `MappedRelease` / `FetchedRepository`
  match the Prisma model columns (`githubReleaseId` is a `bigint`), so they can be passed straight to `createMany` / `upsert`.
- **ETag reuse.** `validateAndFetchRepo()` and `pollRepoReleases()` both request `per_page=20` (`RELEASES_PAGE_SIZE`)
  and the initial fetch keeps the newest 10 (`INITIAL_RELEASES_LIMIT`). GitHub ETags differ per URL, so the PRD's
  `per_page: 10` / `per_page: 20` split would make the first conditional poll always miss. The `ETag` header is kept
  exactly as received (including any `W/` prefix).
- **304 handling.** Octokit throws a `RequestError` with `status === 304`, which is detected by duck-typing, not
  `instanceof`, so the check doesn't depend on `@octokit/request-error` instances. The result returns the previous ETag and
  `rateLimitRemaining` from the error response headers.
- **Drafts are filtered out** in both functions. Repositories and releases are shared by all subscribers, and drafts are only
  visible to tokens with push access.
- **Logging.** Octokit's request-log plugin calls `log.error` on every non-2xx (every 304 poll). `error`/`info`/`debug`
  are silenced and `warn` is kept. Errors are always re-thrown for the caller to log.
- **Testability.** Both functions accept an optional injected `octokit`; `createOctokit({ fetch })` lets tests mock HTTP.
- **Typing.** `GitHubRelease` is a small structural interface. `octokit.request()` and `octokit.rest.*` resolve
  different `@octokit/openapi-types` versions whose release types are not mutually assignable.

### SemVer classification
- `semver.clean(tag, { loose })` first, then `semver.coerce(tag, { includePrerelease: true })` for prefixed tags
  (`release-1.4.0`, `coolify@4.2.7`).
- Deviation: `0.0.0` → `OTHER` (the PRD's rules would label it `MAJOR`).

### Auth (`apps/web/src/lib/auth.ts`)
- JWT sessions, `trustHost: true` (runs behind Coolify's proxy), `pages.signIn` / `pages.error` → `/login`.
- Env read automatically by Auth.js: `AUTH_SECRET`, `AUTH_GITHUB_ID`, `AUTH_GITHUB_SECRET`, `AUTH_URL` or `NEXTAUTH_URL`.
- In the `jwt` callback on sign-in, the access token is encrypted and the `User` row is created or updated by `githubId: String(profile.id)`.
  If GitHub returns no email, Auth.js looks it up via `/user/emails`. As a last resort the GitHub noreply address is used,
  because `User.email` is required.
- The JWT carries only `userId`. `session.user.id` is set from it.
- `getCurrentUserOrThrow()` is wrapped in React `cache()`. If the cookie is valid but the user row is missing, it throws `UnauthorizedError`.

### Server Actions (`apps/web/src/server/actions/repositories.ts`)
- **`addRepositoryAction`:** auth → zod validation → `parseRepoInput` → look up the repo by `fullName`, ignoring case. If the repo is missing or has
  0 releases, `validateAndFetchRepo` runs with the decrypted token. The GitHub call happens before the transaction so no DB
  connection is held during network I/O. Inside one `$transaction`:
  1. create or update `Repository` by `githubRepoId` (also sets `lastEtag`, `lastPolledAt`);
  2. `release.createMany({ skipDuplicates })`;
  3. create or update `UserSubscription` (`includePrereleases`);
  4. attach `SubscriptionTag`s, only for tags the user owns;
  5. seed unread `UserReleaseState`s for the latest 10 non-draft releases, skipping pre-releases when
     `includePrereleases` is false (the same rule the Slice 04 worker uses).
- **`removeSubscriptionAction`:** deletes the user's read states for that repo and the subscription (tag links
  cascade). The shared `Repository` / `Release` rows are kept.
- If the token can't be decrypted (for example, the key was rotated), the action falls back to unauthenticated GitHub access and logs a warning.
  The next sign-in re-encrypts the token.
- Both actions return `{ ok: true, data } | { ok: false, error: { code, message } }`, because thrown errors are redacted in
  production.

## 4. Verification performed

| Check | Result |
| --- | --- |
| `pnpm --filter @repopulse/github test` | ✅ 42/42 (parser incl. `v2.0.0`→MAJOR, `v2.1.0`→MINOR, `v2.1.3`→PATCH, `v2.0.0-rc.1`→PRERELEASE) |
| `pnpm --filter @repopulse/db test` | ✅ 8/8 |
| `typecheck` (db, github, web) | ✅ |
| `next build` (standalone) | ✅ Routes `/`, `/login`, `/api/auth/[...nextauth]`, `/api/health`. Turbopack bundles Octokit and next-auth into the server chunks, so no extra tracing is needed |

## 5. Acceptance criteria

- [x] Unit tests for `parseRepoInput` (URLs, trailing slashes, `owner/repo`) and `classifySemver`.
- [ ] Sign-in creates a `User` row with a non-plaintext `githubAccessTokenEncrypted`. Implemented; needs a manual run.
- [ ] `addRepositoryAction("coollabsio/coolify")` → 1 `Repository`, ≤ 10 `Release`, 1 `UserSubscription`, `lastEtag` stored.
  Implemented; needs a manual run.

**Manual check:**
1. Create a GitHub OAuth App with callback `http://localhost:3000/api/auth/callback/github`.
2. Export `DATABASE_URL`, `AUTH_SECRET`, `AUTH_GITHUB_ID`, `AUTH_GITHUB_SECRET`, `TOKEN_ENCRYPTION_KEY` and run
   `pnpm --filter @repopulse/db db:migrate:deploy`, then `pnpm dev`.
3. Sign in at `/login`, add `coollabsio/coolify` on `/`, then inspect the `User`, `Repository`, `Release`,
   `UserSubscription` and `UserReleaseState` tables.

## 6. Notes for later slices

- **Slice 03:** replace the temporary `app/page.tsx` shell. Consume the `ActionResult` shape from the actions.
- **Slice 04:** call `pollRepoReleases({ owner, name, lastEtag, accessToken })`. Releases are already draft-free and
  classified. `githubReleaseId` is a `bigint`, so convert it before `JSON.stringify` for Redis pub/sub. The worker is CommonJS
  and `@repopulse/github` is ESM; that works on Node ≥ 22.12 via `require(esm)`, or the worker can switch to `"type": "module"`.
- Rate-limit headers are exposed via `rateLimitRemaining` and `getRateLimitInfo()` for back-off scheduling.

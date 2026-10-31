# Agent Implementation Slice 02: GitHub OAuth & Shared GitHub Ingestion Package

## 1. Objective & Scope
Implement the shared `@repopulse/github` package (Octokit wrapper, SemVer parser, ETag conditional fetching, and initial release ingestion) and wire up GitHub OAuth authentication in `apps/web` so authenticated users have their GitHub OAuth token encrypted and stored in PostgreSQL.

* **Prerequisites:** Slice 01 completed (`@repopulse/db` available).
* **Out of Scope:** Background cron queues (Slice 04) and external notifications (Slice 05).

---

## 2. Target Files to Create / Modify
```text
repopulse/
├── packages/
│   └── github/
│       ├── package.json
│       ├── tsconfig.json
│       └── src/
│           ├── index.ts
│           ├── client.ts          # Octokit factory & rate-limit inspector
│           ├── parser.ts          # Repo URL parser & SemVer classifier
│           └── poller.ts          # validateAndFetchRepo() & pollRepoReleases()
└── apps/
    └── web/
        └── src/
            ├── lib/
            │   └── auth.ts        # Auth.js / NextAuth GitHub provider config
            ├── app/
            │   ├── api/auth/[...nextauth]/route.ts
            │   └── login/page.tsx
            └── server/
                └── actions/
                    └── repositories.ts  # addRepositoryAction, removeSubscriptionAction
```

---

## 3. Step-by-Step Agent Instructions

### Step 3.1: Repository Input & SemVer Parser (`packages/github/src/parser.ts`)
1. **`parseRepoInput(input: string): { owner: string; name: string }`**:
   * Accept full URLs (`https://github.com/facebook/react`, `github.com/facebook/react.git`) or shorthand (`facebook/react`).
   * Strip trailing slashes or `.git` suffixes and validate with regex `^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$`. Throw a descriptive `InvalidRepositoryInputError` if invalid.
2. **`classifySemver(tagName: string, isPrereleaseFlag: boolean): SemverType`**:
   * Use the `semver` npm package (`semver.clean(tagName)` or `semver.coerce(tagName)`).
   * If `isPrereleaseFlag` is true or `semver.prerelease(version)` is non-empty, return `'PRERELEASE'`.
   * If `minor === 0 && patch === 0`, return `'MAJOR'`.
   * If `patch === 0`, return `'MINOR'`.
   * If `patch > 0`, return `'PATCH'`.
   * Otherwise return `'OTHER'`.

### Step 3.2: Octokit Wrapper & Conditional Polling (`packages/github/src/poller.ts`)
1. **`validateAndFetchRepo(owner: string, name: string, accessToken?: string)`**:
   * Instantiate `@octokit/rest` with `auth: accessToken` (if provided) and a custom `userAgent: 'RepoPulse-Coolify/2.0'`.
   * Call `octokit.rest.repos.get({ owner, repo: name })` to fetch immutable `id` (`githubRepoId`), `full_name`, `description`, `stargazers_count`, `html_url`, and `owner.avatar_url`.
   * Call `octokit.rest.repos.listReleases({ owner, repo: name, per_page: 10 })`.
   * Capture the response `headers.etag` (strip `W/` weak prefix only if needed, or preserve exact header string for `If-None-Match`).
   * Map releases to match the `Release` Prisma model (`githubReleaseId`, `tagName`, `title`, `bodyMarkdown`, `htmlUrl`, `isPrerelease`, `isDraft`, `semverType`, `publishedAt`).
2. **`pollRepoReleases(params: { owner: string; name: string; lastEtag?: string | null; accessToken?: string })`**:
   * Send `octokit.request('GET /repos/{owner}/{repo}/releases', { owner, repo: name, per_page: 20, headers: lastEtag ? { 'If-None-Match': lastEtag } : {} })`.
   * Catch HTTP `304 Not Modified` error from Octokit and return:
     `{ status: 'NOT_MODIFIED', etag: lastEtag, releases: [], rateLimitRemaining }`.
   * On HTTP `200 OK`, return:
     `{ status: 'UPDATED', etag: response.headers.etag ?? null, releases: mappedReleases, rateLimitRemaining }`.

### Step 3.3: GitHub OAuth with Encrypted Token Persistence (`apps/web/src/lib/auth.ts`)
1. Configure NextAuth / Auth.js v5 with `GitHubProvider`:
   * Request scope: `read:user user:email`.
2. In the `signIn` / `jwt` callback:
   * When `account?.access_token` and `profile?.id` are returned from GitHub, encrypt `account.access_token` using `encryptToken()` from `@repopulse/db`.
   * Upsert the `User` record in PostgreSQL by `githubId: String(profile.id)` storing `email`, `name`, `avatarUrl`, and `githubAccessTokenEncrypted`.
3. Expose `getCurrentUserOrThrow()` helper for Server Actions and Route Handlers.

### Step 3.4: Server Action to Add & Subscribe to a Repository (`apps/web/src/server/actions/repositories.ts`)
1. Implement `addRepositoryAction(input: { repoUrlOrSlug: string; includePrereleases: boolean; tagIds: string[] })`:
   * Authenticate user via `getCurrentUserOrThrow()`.
   * Decrypt user's `githubAccessTokenEncrypted` via `decryptToken()`.
   * Parse `owner/name` via `parseRepoInput()`.
   * Check if `Repository` already exists in DB; if not (or if it has 0 releases), call `validateAndFetchRepo()` and upsert the `Repository` (keyed by `githubRepoId`) and its initial 10 `Release` records inside a `prisma.$transaction`.
   * Upsert `UserSubscription` linking `userId` and `repository.id`, attach any `SubscriptionTag` records for `tagIds`, and create initial `UserReleaseState` records for the latest releases.

---

## 4. Verification & Acceptance Criteria
- [ ] Unit tests in `packages/github` verify `parseRepoInput` handles URLs, trailing slashes, and `owner/repo` strings, and `classifySemver` accurately categorizes `v2.0.0`, `v2.1.0`, `v2.1.3`, and `v2.0.0-rc.1`.
- [ ] Signing in via GitHub creates a `User` row in PostgreSQL with a non-plaintext `githubAccessTokenEncrypted` value.
- [ ] Calling `addRepositoryAction` for `coollabsio/coolify` creates 1 `Repository` row, up to 10 `Release` rows, 1 `UserSubscription` row, and stores the `lastEtag`.
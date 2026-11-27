# Web App (`apps/web`)

> **Summary:** Next.js 16 App Router (`reactCompiler: true`, `typedRoutes: true`, `standalone` output) with React Server Components and Server Actions. There is no REST API besides Better Auth, SSE, health, and the GitHub App routes (manifest callback, webhook). Pages read through `server/queries/*`, and mutations are `"use server"` functions in `server/actions/*` returning `ActionResult<T>`. UI uses Tailwind CSS 4 with shadcn/ui primitives in `components/ui`.
>
> **Related Docs:** [../CONTRACTS.md](../CONTRACTS.md) · [../CODING_STANDARDS.md](../CODING_STANDARDS.md) · [../guides/auth-and-access.md](../guides/auth-and-access.md)

> ⚠️ Next.js 16 differs from older versions (`params` and `searchParams` are Promises, `cookies()` is async, `next typegen`). Read `node_modules/next/dist/docs/` before using an unfamiliar API ([`apps/web/AGENTS.md`](../../apps/web/AGENTS.md)).

## Directory map (`apps/web/src`)

| Path | Contents | May import |
| --- | --- | --- |
| `proxy.ts` | Per-request cryptographic nonce and strict `Content-Security-Policy` headers | `next/server` |
| `app/(dashboard)/` | Signed-in pages sharing `layout.tsx` (sidebar, top bar, `SseListener`) plus `error.tsx`, `loading.tsx`, `not-found.tsx`, `global-error.tsx` | anything server-side |
| `app/login`, `app/invite/[token]` | Public pages | |
| `app/api/auth/[...all]`, `app/api/events/stream`, `app/api/health`, `app/api/github-app/{manifest/callback,webhook}` | Route handlers | |
| `server/actions/*.ts` | `"use server"` mutations, one file per area | `server/*`, `lib/*`, packages |
| `server/queries/*.ts` | Read queries and view types for pages | `server/*`, `lib/*`, packages |
| `server/*.ts` | Server-only helpers, **not** `"use server"`, so they are not callable from the browser and can be unit-tested | packages |
| `lib/*.ts` | Code shared by client and server (constants, pure helpers). Server-only Zod schemas live in `lib/*-schema.ts`. `lib/auth.ts` is server-only (Better Auth) | no `@repopulse/db`, no `server/*` |
| `components/<area>/` | Client and server components by feature: `access`, `admin`, `dependencies`, `email`, `feed`, `layout`, `modals`, `notifications`, `reader`, `realtime`, `repositories`, `theme` | `lib/*`, `server/actions/*`, **type-only** imports from `server/*`, no `@repopulse/db` |
| `components/ui/` | shadcn/ui primitives (`badge`, `button`, `checkbox`, `dialog`, `input`, `label`, `popover`, `select`, `sheet`, `skeleton`, `sonner`, `switch`, all on `radix-ui`) | |

Path alias: `@/*` → `apps/web/src/*` (`tsconfig.json` and `vitest.config.ts`).

## Routes

| Route | File | Access |
| --- | --- | --- |
| `/` | `app/(dashboard)/page.tsx` | user. Release feed; the URL holds all filter state (`lib/feed-filters.ts` `PARAM`); `?release=<id>` opens the changelog drawer |
| `/repositories` | `app/(dashboard)/repositories/page.tsx` | user. Subscription cards (tags, read-only tracking summary, history status, pin, sync, remove) with search / sort / quick filters in the URL (`lib/repo-list-filters.ts`) |
| `/repositories/[owner]/[name]` | `app/(dashboard)/repositories/[owner]/[name]/page.tsx` (+ `not-found.tsx`) | user. Settings of the user's own subscription: header, activity grid + stats, tracking, tags, notifications & feed, history, danger zone. Case-insensitive slug, redirected to canonical casing; untracked repository renders a "Not tracked" page with a prefilled Add button. `?from=` carries the list's query string for the back link |
| `/dependencies` | `app/(dashboard)/dependencies/page.tsx` | user. Dependency projects: package managers, outdated counts by level, open PRs, mode, last check, "Create PR" / "Update PR" (and multi-group PR chooser for PR-mode projects), "Check now", "Tracked" badge; search / sort in URL (`lib/dependency-list-filters.ts`: `q`, `sort` = `name` / `outdated` / `checked`); Add dialog (from tracked repositories, or by URL). `?installed=1` shows the "App installed" notice. With the module off: "Dependency checks are turned off by the administrator" |
| `/dependencies/[owner]/[name]` | `app/(dashboard)/dependencies/[owner]/[name]/page.tsx` (+ `not-found.tsx`) | user, own project only. Header + App status banner, outdated table (filters, ignore actions, changelog links, "Track releases"), pull requests (planned groups with "Create PR" / "Update PR" or disabled reason, history), settings form, manifests, danger zone. Canonical-casing redirect |
| `/settings/notifications` | `app/(dashboard)/settings/notifications/page.tsx` | user. Notification rules (with event checkboxes and an events edit dialog) |
| `/admin` | `app/(dashboard)/admin/page.tsx` (+ `admin/layout.tsx`: guard and tabs) | **super admin**. Admin panel overview: counts and a card per section |
| `/admin/access` | `app/(dashboard)/admin/access/page.tsx` | **super admin**. Registration toggle, invite links (`/settings/access` redirects here via `next.config.ts`) |
| `/admin/email` | `app/(dashboard)/admin/email/page.tsx` | **super admin**. SMTP settings, test email (`/settings/email` redirects here via `next.config.ts`) |
| `/admin/history` | `app/(dashboard)/admin/history/page.tsx` | **super admin**. Release history import settings, re-run automatic import for existing repositories |
| `/admin/github-app` | `app/(dashboard)/admin/github-app/page.tsx` | **super admin**. Create the GitHub App (manifest flow) or enter it manually, remove it, enable webhooks; `?created=1` / `?error=<code>` after callback |
| `/admin/dependencies` | `app/(dashboard)/admin/dependencies/page.tsx` | **super admin**. Module switch, `deps-worker` heartbeat, sandbox tools, App state, counts |
| `/login` | `app/login/page.tsx` | public. GitHub sign-in, error messages (`?error=InviteRequired`, `InviteInvalid`, …) |
| `/invite/[token]` | `app/invite/[token]/page.tsx` | public. Accepts an invite: sets the cookie, then GitHub sign-in |
| `GET /api/events/stream` | `app/api/events/stream/route.ts` | user. SSE relay of `user:{id}:events` via multiplexed Redis subscriber |
| `GET /api/health` | `app/api/health/route.ts` | public. Container healthcheck |
| `/api/auth/*` | `app/api/auth/[...all]/route.ts` | Better Auth handlers |
| `GET /api/github-app/manifest/callback` | `app/api/github-app/manifest/callback/route.ts` | **super admin** (404 otherwise). Manifest code exchange, checks state cookie |
| `POST /api/github-app/webhook` | `app/api/github-app/webhook/route.ts` | public, `X-Hub-Signature-256` only. Enqueues `deps-scan`; no database writes ([../CONTRACTS.md](../CONTRACTS.md#github-app-webhook-contract)) |

**Every page calls `requireUser()` or `requireSuperAdmin()` itself.** Layouts and pages render in parallel, so a layout's guard does not protect the page.

## Server Actions

File → exported actions:

| File | Actions |
| --- | --- |
| `repositories.ts` | `addRepositoryAction`, `updateTrackModeAction`, `updateSubscriptionSettingsAction` (include pre-releases, pin, note, notification level, snooze, "my version"; schema `subscriptionSettingsInput` in `lib/subscription-settings-schema.ts`), `removeSubscriptionAction`, `listRepositoryPathsAction` (read-only: default branch's files and folders for the path picker) |
| `sync.ts` | `triggerManualRepoSyncAction` (→ `QUEUED` / `COOLDOWN`) |
| `backfill.ts` | `requestDeepBackfillAction` ("Load older releases"; step, cooldown, and hard cap from `getBackfillConfig()`) |
| `backfill-settings.ts` | `saveBackfillSettingsAction`, `reapplyBackfillSettingsAction` (super admin; helpers in `server/backfill-settings.ts`) |
| `feed.ts` | `loadMoreReleasesAction`, `getReleaseDrawerAction` |
| `release-state.ts` | `toggleReleaseReadAction`, `markAllReadAction` |
| `tags.ts` | `createTagAction`, `updateTagAction`, `deleteTagAction`, `assignTagsAction` |
| `notifications.ts` | `createNotificationRuleAction` (with `events`), `toggleNotificationRuleAction`, `updateNotificationRuleEventsAction`, `deleteNotificationRuleAction`, `sendTestNotificationAction` |
| `dependencies.ts` | `addDependencyProjectsAction` (1–20 sources: subscription ids or `owner/name` / URLs; `updateMode`, `notifyOnFirstScan`), `removeDependencyProjectAction`, `updateDependencyProjectSettingsAction` (claims / releases PR ownership, `CONFLICT` naming the owner), `triggerDependencyScanAction` (→ `QUEUED` / `COOLDOWN`, 5 min), `createDependencyPullRequestAction`, `createProjectDependencyPullRequestsAction` (queues all eligible groups), `ignoreDependencyAction` (matching rows become `IGNORED` at once; range rule also queues re-check), `removeIgnoreRuleAction` (queues re-check bypassing cooldown). Actions that queue work return `UNAVAILABLE` while the module is off. Schemas in `lib/dependency-settings-schema.ts` |
| `github-app.ts` | `startGitHubAppManifestAction`, `saveGitHubAppSettingsAction`, `removeGitHubAppSettingsAction`, `enableGitHubAppWebhooksAction` (super admin; helpers in `server/github-app.ts`, schemas in `lib/github-app-schema.ts`) |
| `dependencies-admin.ts` | `setDepsEnabledAction` (super admin) |
| `access.ts` | `setPublicRegistrationAction`, `createInviteAction`, `deleteInviteAction` (super admin) |
| `email-settings.ts` | `saveSmtpSettingsAction`, `removeSmtpSettingsAction`, `sendSmtpTestEmailAction` (super admin) |
| `auth.ts` | `signOutAction` |

### Action template and rules

See [../CONTRACTS.md](../CONTRACTS.md#server-action-contract) for `ActionResult<T>` and error codes.

```ts
"use server";
const input = z.object({ ruleId: z.string().min(1).max(64) });

export async function doThingAction(raw: { ruleId: string }): Promise<ActionResult<{ ruleId: string }>> {
  try {
    const user = await getCurrentUserOrThrow();        // or getSuperAdminOrThrow() for instance settings
    const parsed = input.safeParse(raw);
    if (!parsed.success) return invalidInput(parsed.error);
    const { count } = await prisma.notificationRule.updateMany({
      where: { id: parsed.data.ruleId, userId: user.id },
      data: {},
    });
    if (count === 0) return fail("NOT_FOUND", "Notification rule not found.");
    revalidatePath("/settings/notifications");
    return ok({ ruleId: parsed.data.ruleId });
  } catch (error) {
    return toActionError(error, "doThingAction");
  }
}
```

- **MUST** validate input with Zod 4 (`z.email()`, `z.enum([...])`, messages as second argument) kept in server-only `*-schema.ts` files when `lib/` is also imported by client components.
- **MUST** scope reads and writes to `user.id` (`updateMany` / `deleteMany` with `userId`, then check `count`).
- **MUST NOT** return secrets: decrypted tokens, SMTP passwords, or raw webhook URLs (use `maskDestination`).
- A `"use server"` file may export **only async functions**. Put shared constants in `lib/` and server-only helpers in `server/`.
- Revalidate paths whose server-rendered data changed (`revalidatePath`). Repository actions revalidate the dashboard layout.
- Actions hitting Redis use `withRedisTimeout()` and map `RealtimeUnavailableError` → `UNAVAILABLE`.
- Abuse-prone actions keep an in-memory cooldown (Send Test: 10 s per rule; test email: 10 s).

Client usage pattern: call the action in `startTransition`, show `toast` from `sonner`, `router.push("/login")` on `UNAUTHORIZED`, and show `error.message` inline (`role="alert"`). Use `useOptimistic` for toggles and `useFormStatus` for form pending states.

## Server helpers (`server/`)

| File | Purpose |
| --- | --- |
| `session.ts` | `requireUser()` (redirects to `/login`), `requireSuperAdmin()` (404 for non-admins), `getSuperAdminOrThrow()` (throws `ForbiddenError`) |
| `action-result.ts` | `ok`, `fail`, `invalidInput`, `toActionError`, `isUniqueConstraintError`, `getGitHubToken(user)` (decrypts, `undefined` on failure) |
| `queries/feed.ts` | `visibleReleasesWhere`, `visibleReleasesWhereForSubscriptions`, `buildFeedWhere`, `buildFeedWhereForSubscriptions`, `getUserFeedContext`, `getReleaseFeed` (keyset; flat join-free mode via `repoContextById`; unread-first index path), `countUnread`, `getReleaseDetail`, `getDashboardData` (sidebar, unread counts), `getTrackedRepositories` / `loadTrackedRepositories` / `toTrackedRepository` |
| `queries/repository-settings.ts` | `getRepositorySettings(userId, owner, name)` (`null` unless subscribed), `getRepositoryActivity(userId, repositoryId)` (newest 5,000 of last 371 days through `visibleReleasesWhere`) |
| `queries/notifications.ts` | `getNotificationRules` (masked), `MAX_NOTIFICATION_RULES = 25` |
| `queries/access.ts` | `getInvites` (newest 100), `getMemberCount` |
| `queries/dependencies.ts` | `getDependencyProjects`, `getDependenciesListData`, `getAddableSubscriptions`, `getDependencyProject(userId, owner, name)` (`null` unless user's), `getDependencyProjectForRepository`, `getAppRepoStatus` (≤ 2 GitHub calls per render), `checkRepoAccess(user, repo, "read" \| "write")`, `loadAppCredentials`, `planPullRequests`, `planListPullRequests` |
| `queries/github-app.ts` | `getGitHubAppView` (never key or secret), `isGitHubAppConfigured` |
| `deps-status.ts`, `deps-enabled-cache.ts` | `isDepsEnabled` (15 s in-memory TTL cache + invalidation on toggle), `getDepsSidebarInfo`, `readDepsWorkerStatus` (Redis heartbeat), `getDepsAdminView` |
| `github-app.ts`, `github-app-webhook.ts`, `deps-webhook-queue.ts` | Manifest state cookie and callback; webhook verification and routing; webhook `deps-scan` producer |
| `realtime.ts` | Redis connection (`maxRetriesPerRequest: 1`, `enableOfflineQueue: false`), `getRepoPollQueue`, `getReleaseBackfillQueue`, `publishToUser`, multiplexed `subscribeUserEvents`, `withRedisTimeout`, `isRealtimeConfigured` |
| `backfill-queue.ts`, `repo-poll-queue.ts` | `enqueueReleaseBackfill`, `queueRepoImport` (priority poll for tag or path import) |
| `commit-states.ts` | `syncCommitStates` / `planCommitStates` (prune and seed commit states for `trackPaths`), `needsPathImport` |
| `notification-destination.ts` | `normalizeDestination(channel, raw, { smtpConfigured })`: SSRF-checked URL or optional email |
| `smtp-settings.ts` | `getSmtpConfig()` (decrypts), `isSmtpConfigured()`, `getSmtpSettingsView()` (no password), security ↔ `smtpSecure` mapping |
| `registration.ts` | `admitNewGitHubUser`, `isPublicRegistrationOpen`, `findUsableInvite` |
| `invite-tokens.ts` | `generateInviteToken`, `hashInviteToken` |

## Auth in the app

`lib/auth.ts` exports `auth`, `getCurrentUserOrThrow()` (cached per request with React `cache`, constructed from Better Auth's session — backed by a 30 s signed `cookieCache` on top of database sessions — without an extra `User` DB query), `UnauthorizedError`, and `ForbiddenError`. Better Auth stores database sessions (carrying `userId`) via Prisma and encrypts GitHub tokens onto `User.githubAccessTokenEncrypted` (loaded lazily only at GitHub call sites). See [../guides/auth-and-access.md](../guides/auth-and-access.md).

## UI conventions

- Pages: `mx-auto max-w-4xl space-y-6`, then `h1` (`text-xl font-semibold tracking-tight`) with muted description. Sections are cards (`rounded-lg border bg-card p-4 sm:p-5`).
- Forms: `Label` + `Input`, hints `text-xs text-muted-foreground`, errors `text-sm text-destructive` (`role="alert"`), spinner `LoaderCircleIcon className="animate-spin"`, `lucide-react` icons.
- No `confirm()` dialogs: destructive actions use an inline second step.
- Light and dark themes come from CSS variables in `app/globals.css`. Use semantic tokens (`text-muted-foreground`, `bg-card`, `outline-hidden`), never hardcoded light-only hex styles, except status tints like `bg-emerald-500/10`.
- Theme preference (System / Light / Dark, `lib/theme.ts`) lives in the `theme` cookie. Root layout renders `<html data-theme="light|dark">` (no attribute for System); `ThemeProvider` / `useTheme()` (`components/theme/`) and `ThemeSwitcher` toggle client-side without a round trip.
- Watched paths ("Files / folders") use `WatchedPathsPicker` (`components/repositories/`), loading the tree via `listRepositoryPathsAction` (5-min browser cache) and ranking with `lib/repo-paths.ts`. Manual path entry keeps working if the tree fails or truncates; forms submit `[...paths, draft]`, and dialogs handle `onEscapeKeyDown` with `isExpandedCombobox`.
- Per-subscription settings live on `/repositories/[owner]/[name]`, not on `/repositories` cards.
- `/repositories` search params (`lib/repo-list-filters.ts`): `q` (≤ 200 chars), `sort` (`name` default, `-name`, `added`, `-added`, `updated`, `synced`, `unread`, `stars`; pinned first), `tag` (slug), `status` (`unread`, `error`, `paths`, `pinned`), filtered on the server (`applyRepoListFilters`).
- Activity grid (`ActivityGrid`, `ActivityStats`, `lib/activity-grid.ts`) buckets timestamps by local browser day after mount using `--activity-1..4`.
- "My version" (`lib/version-compare.ts`): compares visible `RELEASE` / `TAG` rows published after the matching `tagName`, falling back to SemVer comparison.
- Release notes render server-side via `ChangelogMarkdown` (`rehype-sanitize`). Clicking a feed item fetches sanitized drawer content via `getReleaseDrawerAction` with client-side caching and shallow `window.history.pushState` URL sync (keeping SSR for direct `?release=<id>` loads), split list/drawer reader contexts + memoized `ReleaseCard`, `prefetch={false}` on dynamic dashboard links, and `UnreadProvider` updating unread counts optimistically. Never use `dangerouslySetInnerHTML` with release content.
- Instance-admin navigation (`components/layout/app-sidebar.tsx` **Instance** group and `top-navbar.tsx`) is gated by `isSuperAdmin`.
- Dependencies: sidebar shows **Dependencies** (with outdated-projects count) only when the module is on. `SseListener` handles `DEPS_SCAN_COMPLETED`, `DEPS_SCAN_FAILED`, and `DEPS_PULL_REQUEST_UPDATED` (toast + 400 ms debounced `router.refresh()`).

## Tests

Vitest (`apps/web/vitest.config.ts`, `src/**/*.test.{ts,tsx}`, node environment). Unit-test pure logic in `lib/` and non-`"use server"` modules in `server/`. Mock `@repopulse/db` with `vi.mock` including every read export (`INSTANCE_SETTINGS_ID`, etc.). When a test pulls in `@/lib/auth`, mock both `UnauthorizedError` and `ForbiddenError`.

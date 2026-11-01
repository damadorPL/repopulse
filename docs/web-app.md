# Web app (`apps/web`)

> **Summary:** Next.js 16 App Router with React Server Components and Server Actions. There is no REST API
> besides auth, SSE and health. Pages read through `server/queries/*`, and mutations are `"use server"` functions in
> `server/actions/*` that return `ActionResult<T>`. UI uses Tailwind CSS 4 with shadcn/ui primitives in
> `components/ui`.

> ⚠️ Next.js 16 differs from older versions (`params` is a Promise, `next typegen`, and more). Check
> `node_modules/next/dist/docs/` before using an unfamiliar API ([`apps/web/AGENTS.md`](../apps/web/AGENTS.md)).

## Directory map (`apps/web/src`)

| Path | Contents | May import |
| --- | --- | --- |
| `app/(dashboard)/` | Signed-in pages sharing `layout.tsx` (sidebar, top bar, `SseListener`) | anything server-side |
| `app/login`, `app/invite/[token]` | Public pages | |
| `app/api/auth/[...nextauth]`, `app/api/events/stream`, `app/api/health` | Route handlers | |
| `server/actions/*.ts` | `"use server"` mutations, one file per area | `server/*`, `lib/*`, packages |
| `server/queries/*.ts` | Read queries and view types for pages | `server/*`, `lib/*`, packages |
| `server/*.ts` | Server-only helpers, **not** `"use server"`, so they are not callable from the browser and can be unit-tested | packages |
| `lib/*.ts` | Code shared by client and server (constants, zod schemas, pure helpers). `lib/auth.ts` is server-only (Auth.js) | no `@repopulse/db`, no `server/*` |
| `components/<area>/` | Client and server components by feature: `access`, `email`, `feed`, `layout`, `modals`, `notifications`, `reader`, `realtime`, `repositories` | `lib/*`, `server/actions/*`, **type-only** imports from `server/*` |
| `components/ui/` | shadcn/ui primitives (badge, button, checkbox, dialog, input, label, popover, select, sheet, skeleton, sonner, switch, all on `radix-ui`) | |

Path alias: `@/*` → `apps/web/src/*` (tsconfig and `vitest.config.ts`).

## Routes

| Route | File | Access |
| --- | --- | --- |
| `/` | `app/(dashboard)/page.tsx` | user. Release feed; the URL holds all filter state (`lib/feed-filters.ts` `PARAM`); `?release=<id>` opens the changelog drawer |
| `/repositories` | `app/(dashboard)/repositories/page.tsx` | user. Subscriptions, tags, track mode, history status, sync, remove |
| `/settings/notifications` | `app/(dashboard)/settings/notifications/page.tsx` | user. Notification rules |
| `/settings/access` | `app/(dashboard)/settings/access/page.tsx` | **super admin**. Registration toggle, invite links |
| `/settings/email` | `app/(dashboard)/settings/email/page.tsx` | **super admin**. SMTP settings, test email |
| `/login` | `app/login/page.tsx` | public. GitHub sign-in, error messages (`?error=InviteRequired`, `InviteInvalid`, …) |
| `/invite/[token]` | `app/invite/[token]/page.tsx` | public. Accepts an invite: sets the cookie, then GitHub sign-in |
| `GET /api/events/stream` | `app/api/events/stream/route.ts` | user. SSE relay of `user:{id}:events` (`runtime = "nodejs"`, `dynamic = "force-dynamic"`) |
| `GET /api/health` | `app/api/health/route.ts` | public. Container healthcheck |
| `/api/auth/*` | `app/api/auth/[...nextauth]/route.ts` | Auth.js handlers |

**Every page calls `requireUser()` or `requireSuperAdmin()` itself.** Layouts and pages render in parallel, so the
layout's check does not protect the page.

## Server Actions

File → exported actions:

| File | Actions |
| --- | --- |
| `repositories.ts` | `addRepositoryAction`, `updateTrackModeAction`, `removeSubscriptionAction` |
| `sync.ts` | `triggerManualRepoSyncAction` (→ `QUEUED` / `COOLDOWN`) |
| `backfill.ts` | `requestDeepBackfillAction` ("Load older releases") |
| `feed.ts` | `loadMoreReleasesAction` |
| `release-state.ts` | `toggleReleaseReadAction`, `markAllReadAction` |
| `tags.ts` | `createTagAction`, `updateTagAction`, `deleteTagAction`, `assignTagsAction` |
| `notifications.ts` | `createNotificationRuleAction`, `toggleNotificationRuleAction`, `deleteNotificationRuleAction`, `sendTestNotificationAction` |
| `access.ts` | `setPublicRegistrationAction`, `createInviteAction`, `deleteInviteAction` (super admin) |
| `email-settings.ts` | `saveSmtpSettingsAction`, `removeSmtpSettingsAction`, `sendSmtpTestEmailAction` (super admin) |
| `auth.ts` | `signOutAction` |

### The action contract (`server/action-result.ts`)

```ts
type ActionResult<T> = { ok: true; data: T } | { ok: false; error: { code: ActionErrorCode; message: string } };
// codes: UNAUTHORIZED | FORBIDDEN | INVALID_INPUT | NOT_FOUND | CONFLICT | RATE_LIMITED | UNAVAILABLE | DELIVERY_FAILED | INTERNAL
```

Template. Follow it for every new action:

```ts
"use server";
const input = z.object({ ruleId: z.string().min(1).max(64) });

export async function doThingAction(raw: { ruleId: string }): Promise<ActionResult<{ ruleId: string }>> {
  try {
    const user = await getCurrentUserOrThrow();        // or getSuperAdminOrThrow() for instance settings
    const parsed = input.safeParse(raw);
    if (!parsed.success) return invalidInput(parsed.error);
    // Scope every query to the user: where: { id, userId: user.id }
    const { count } = await prisma.notificationRule.updateMany({ where: { id: parsed.data.ruleId, userId: user.id }, data: {} });
    if (count === 0) return fail("NOT_FOUND", "Notification rule not found.");
    revalidatePath("/settings/notifications");
    return ok({ ruleId: parsed.data.ruleId });
  } catch (error) {
    return toActionError(error, "doThingAction");       // maps Unauthorized/Forbidden/GitHub errors, logs and hides the rest
  }
}
```

Rules:
- **MUST** validate input with zod (`z` from `zod` v4: `z.email()`, `z.enum([...])`, messages as the second argument).
- **MUST** scope reads and writes to `user.id` (`updateMany` / `deleteMany` with `userId`, then check `count`).
- **MUST NOT** return secrets: decrypted tokens, SMTP passwords, raw webhook URLs (use `maskDestination`).
- A `"use server"` file may export **only async functions**. Put shared constants and schemas in `lib/` and
  server-only helpers in `server/`.
- Revalidate the paths whose server-rendered data changed (`revalidatePath`). Repository actions revalidate the
  dashboard layout.
- Actions that hit Redis use `withRedisTimeout()` and map `RealtimeUnavailableError` → `UNAVAILABLE`.
- Abuse-prone actions keep an in-memory cooldown (Send Test: 10 s per rule; test email: 10 s).

Client usage pattern: call the action in `startTransition`, show `toast` from `sonner`, `router.push("/login")` on
`UNAUTHORIZED`, and show `error.message` inline (`role="alert"`). Use `useOptimistic` for toggles.

## Server helpers (`server/`)

| File | Purpose |
| --- | --- |
| `session.ts` | `requireUser()` (redirects to `/login`), `requireSuperAdmin()` (404 for non-admins), `getSuperAdminOrThrow()` (throws `ForbiddenError`) |
| `action-result.ts` | `ok`, `fail`, `invalidInput`, `toActionError`, `isUniqueConstraintError`, `getGitHubToken(user)` (decrypts, undefined on failure) |
| `queries/feed.ts` | `visibleReleasesWhere`, `buildFeedWhere`, `getReleaseFeed` (keyset), `countUnread`, `getReleaseDetail`, `getDashboardData` (sidebar, unread counts) |
| `queries/notifications.ts` | `getNotificationRules` (masked), `MAX_NOTIFICATION_RULES = 25` |
| `queries/access.ts` | `getInvites` (newest 100), `getMemberCount` |
| `realtime.ts` | Redis connection (fail-fast, `maxRetriesPerRequest: 1`), `getRepoPollQueue`, `getReleaseBackfillQueue`, `publishToUser`, `createSubscriber`, `withRedisTimeout`, `isRealtimeConfigured` |
| `backfill-queue.ts`, `repo-poll-queue.ts` | `enqueueReleaseBackfill`, `queueRepoImport` (priority poll for a tag or path import) |
| `commit-states.ts` | `syncCommitStates` / `planCommitStates` (prune and seed a `PATHS` user's commit states), `needsPathImport` |
| `notification-destination.ts` | `normalizeDestination(channel, raw, { smtpConfigured })`: SSRF-checked URL or optional email |
| `smtp-settings.ts` | `getSmtpConfig()` (decrypts), `isSmtpConfigured()`, `getSmtpSettingsView()` (no password), security ↔ `smtpSecure` mapping |
| `registration.ts` | `admitGitHubUser`, `isPublicRegistrationOpen`, `findUsableInvite` |
| `invite-tokens.ts` | `generateInviteToken`, `hashInviteToken` |

## Auth in the app

`lib/auth.ts` exports `auth`, `signIn`, `signOut`, `handlers`, `getCurrentUserOrThrow()` (cached per request with
React `cache`), `UnauthorizedError` and `ForbiddenError`. The JWT session carries only `userId`. See
[auth-and-access.md](./auth-and-access.md).

## UI conventions

- Pages: `mx-auto max-w-4xl space-y-6`, then an `h1` (`text-xl font-semibold tracking-tight`) with a muted description.
  Sections are cards (`rounded-lg border bg-card p-4 sm:p-5`).
- Forms: `Label` + `Input`, hints `text-xs text-muted-foreground`, errors `text-sm text-destructive` with
  `role="alert"`, a loading spinner `LoaderCircleIcon className="animate-spin"`, `lucide-react` icons.
- No `confirm()` dialogs: destructive actions use an inline second step (see "Turn off email").
- Light and dark themes come from CSS variables in `app/globals.css`. Use tokens (`text-muted-foreground`,
  `bg-card`), not raw colors, except for status tints such as `bg-emerald-500/10`.
- Release notes are rendered with `ChangelogMarkdown` (server, sanitized). Never use `dangerouslySetInnerHTML` with
  release content.
- Instance-admin navigation lives in `components/layout/app-sidebar.tsx` (the **Instance** group) and the account menu
  in `top-navbar.tsx`. Both are gated by `isSuperAdmin`.

## Tests

Vitest (`apps/web/vitest.config.ts`, `src/**/*.test.{ts,tsx}`, node environment). Unit-test pure logic in `lib/` and
non-`"use server"` modules in `server/`. Mock `@repopulse/db` with `vi.mock` and provide every export the module under
test reads (for example `INSTANCE_SETTINGS_ID`). When a test imports something that pulls in `@/lib/auth`, mock it
with both `UnauthorizedError` and `ForbiddenError`.

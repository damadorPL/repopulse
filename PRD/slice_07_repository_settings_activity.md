# Agent Implementation Slice 07: Repository Settings Page, Activity Grid & Repository List Search / Sort

## 1. Objective & Scope
Today every per-subscription control lives inline on the `/repositories` cards (release mode select, "Files / folders"
popover, tag popover), "Include pre-releases" can only be chosen once in the Add modal, and the list is a fixed
alphabetical grid with no way to find a repository among dozens. This slice:

* **Part A: Repository settings page.** Each tracked repository gets its own page, `/repositories/[owner]/[name]`, that
  gathers every setting of the user's subscription (tracking mode, "Files / folders" + watched paths, include
  pre-releases, tags) plus a **GitHub-style activity grid** of the repository's updates over the last year.
* **Part B: Search and sort on `/repositories`.** A search box and a sort select (name, date added, latest update, last
  synced, unread, stars), plus quick filters, all kept in the URL.
* **Part C: New per-subscription settings.** A set of proposed settings (pin, note, notification level, snooze, "my
  version", tag-name filters, ignore bot commits) stored on `UserSubscription` and edited on the settings page. Each
  sub-step in §3.7 is independent and may be shipped or dropped on its own.

* **Prerequisites:** Slices 01–06 and the 0.7.x combined tracking (`TrackMode.NONE` + `UserSubscription.trackPaths`).
* **Out of Scope:**
  * Tracking non-default branches for "Files / folders" (worker change; candidate for a later slice).
  * Per-repository email digest frequency (`EMAIL_DIGEST` still has no sender).
  * An activity grid built from GitHub's own commit activity API (`/stats/commit_activity`); the grid uses stored rows only.
  * Multi-year navigation of the activity grid (rolling 53 weeks only).
  * Sharing settings between users of the same repository (all settings stay per-user).

### Design constraints
* **Per-user, never per-repository.** Every new setting lives on `UserSubscription` (or is derived from rows the user
  can see). `Repository` / `Release` rows stay shared and unchanged by this slice.
* **The activity grid shows what the user's feed shows.** Its counts come from `visibleReleasesWhere(userId, { repositoryId })`
  so the grid, the feed and the unread counters agree (rule 4). Commit rows count only when the user has a state row.
* **Day bucketing happens in the browser.** The server returns timestamps, the client buckets them by the viewer's local
  day, so a release at 23:30 local time lands on the right square regardless of the server's UTC clock.
* **The list stays server-rendered.** Search, sort and filters are URL search params parsed on the server, like the feed
  filters in `lib/feed-filters.ts`; the list is small (hundreds at most), so filtering and sorting run in memory on the
  `getTrackedRepositories` result, not in SQL.
* **The page URL addresses the user's own subscription.** `/repositories/[owner]/[name]` resolves the `Repository` by
  `fullName` (case-insensitive) and then the `UserSubscription` by `{ userId, repositoryId }`; anything not subscribed
  by the signed-in user is `notFound()`. Ids from the client are never trusted (rule 1).

---

## 2. Target Files to Create / Modify
```text
packages/db/prisma/schema.prisma                         Part C fields on UserSubscription (+ NotificationLevel enum)
packages/db/prisma/migrations/<ts>_subscription_settings/ migration.sql (Part C only)

apps/web/src/app/(dashboard)/repositories/page.tsx        search / sort / filter bar, cards link to the settings page
apps/web/src/app/(dashboard)/repositories/[owner]/[name]/page.tsx       NEW settings page
apps/web/src/app/(dashboard)/repositories/[owner]/[name]/not-found.tsx  NEW "Not tracked" state with an Add button
apps/web/src/lib/repo-list-filters.ts (+ .test.ts)        NEW parse / serialize / apply search, sort and filters
apps/web/src/lib/activity-grid.ts (+ .test.ts)            NEW bucket timestamps by local day, build 53×7 weeks, level thresholds
apps/web/src/server/queries/repository-settings.ts (+ .test.ts)  NEW getRepositorySettings(userId, owner, name), getRepositoryActivity()
apps/web/src/server/queries/feed.ts                       TrackedRepository + latestActivityAt, pinned, note (Part C)
apps/web/src/server/actions/repositories.ts               + updateSubscriptionSettingsAction (pre-releases + Part C fields)
apps/web/src/components/repositories/repo-list-toolbar.tsx         NEW search input, sort select, quick filters
apps/web/src/components/repositories/activity-grid.tsx            NEW client heatmap + legend + tooltips
apps/web/src/components/repositories/activity-stats.tsx           NEW totals, cadence, last update
apps/web/src/components/repositories/subscription-settings-form.tsx NEW Part C fields (+ pre-releases switch)
apps/web/src/components/repositories/tracking-settings.tsx        NEW full-width tracking section (reuses TrackModeToggle logic)
apps/web/src/components/repositories/tag-settings.tsx             NEW inline tag list + assign (reuses AssignTagsPopover)
apps/worker/src/processors/fan-out.ts (+ .test.ts)        honor notificationLevel / snoozedUntil / tag filters (Part C)
apps/worker/src/processors/repo-tags.ts, repo-paths.ts    honor tag-name filters / ignoreBotCommits per subscriber (Part C)
docs/web-app.md, docs/data-model.md                       document the page, the list params and the new fields
CHANGELOG.md                                              ## [Unreleased]
```

---

## 3. Step-by-Step Agent Instructions

### Step 3.1: Settings page route (`/repositories/[owner]/[name]`)
1. Create `apps/web/src/app/(dashboard)/repositories/[owner]/[name]/page.tsx` (Next.js 16: `params` is a `Promise`;
   read `node_modules/next/dist/docs/` for dynamic segments before writing it). `requireUser()`, then
   `getRepositorySettings(user.id, owner, name)`; `notFound()` when it returns `null`.
2. `generateMetadata`: `"<owner>/<name> · RepoPulse"`.
3. Layout, top to bottom (single column, `max-w-5xl` like the list):
   1. **Header:** back link "← Tracked repositories" (preserves the list's search params via `?from=` or `history.back`
      fallback), `RepoAvatar`, `fullName`, GitHub link, description, stars, "Synced <relative>" / "Last sync failed",
      `SyncRepoButton`, "Open in feed" (`feedHref({ repositoryId })`).
   2. **Activity:** `ActivityStats` + `ActivityGrid` (§3.3).
   3. **Tracking:** release mode (`Releases only` / `Releases + tags` / `No releases`), "Files / folders" switch with
      the `WatchedPathsPicker` shown inline (not in a popover), and an **Include pre-releases** switch (hidden when
      `trackMode = NONE`). Saving reuses `updateTrackModeAction`; the pre-release switch uses the new
      `updateSubscriptionSettingsAction` (§3.5).
   4. **Tags:** assigned `TagPill`s with remove buttons and the existing `AssignTagsPopover` (+ "Manage tags" link).
   5. **Notifications & feed** (Part C, §3.7): only the fields that ship.
   6. **History:** `HistoryStatus` ("Load older releases") when releases are tracked.
   7. **Danger zone:** `RemoveSubscriptionButton`, which redirects to `/repositories` after removal.
4. `not-found.tsx`: "You don't track `<owner>/<name>`" with an "Add repository" button that opens `AddRepoModal`
   prefilled with the slug.
5. On `/repositories`, the card title links to the settings page (the external-link icon still goes to GitHub, and a
   new "Open in feed" icon replaces the old title link). Cards keep the tag pills, sync and unread count; the inline
   `TrackModeToggle` row becomes a read-only summary line (`Releases + tags · Files / folders · Includes pre-releases`)
   that links to the settings page.

### Step 3.2: Settings query (`apps/web/src/server/queries/repository-settings.ts`)
1. `getRepositorySettings(userId, owner, name)` returns `null` unless the user subscribes. Shape: the
   `TrackedRepository` fields (reuse the `getTrackedRepositories` mapping: extract a `toTrackedRepository(row)` helper
   instead of duplicating it) plus `allTags`, `hardCap` and the Part C fields.
2. Match `fullName` with `mode: "insensitive"`, so `/repositories/Vercel/Next.js` works; redirect to the canonical
   casing when it differs.

### Step 3.3: Activity grid
1. **Query `getRepositoryActivity(userId, repositoryId)`:** `release.findMany({ where: { AND: [visibleReleasesWhere(userId, { repositoryId }), { publishedAt: { gte: now - 371 days } }] }, select: { publishedAt: true, source: true, semverType: true } })`.
   Return `{ items: Array<{ at: string; source; semverType }>, total, firstStoredAt }`, where `total` and
   `firstStoredAt` cover all visible rows (not only the window), so the stats can say "since …". Cap `items` at 5 000
   newest (a busy "Files / folders" subscription); flag `truncated` when hit.
2. **`lib/activity-grid.ts` (pure, unit-tested):**
   * `bucketByLocalDay(items, timeZone?)` → `Map<"YYYY-MM-DD", { count; bySource: Record<ReleaseSource, number>; hasMajor }>`.
   * `buildWeeks(today, weekStartsOn = 0)` → 53 columns × 7 days, oldest first, future days marked `outOfRange`.
   * `levelFor(count, max)` → 0–4. Thresholds from quartiles of non-zero days (GitHub-style), so a repository with 3
     releases a year and one with 30 commits a week both use the full scale.
   * `monthLabels(weeks)` → column index + short month name for the first week of each month.
3. **`components/repositories/activity-grid.tsx` (client):**
   * Render as CSS grid of `<button>` squares (`size-2.5`, `gap-[3px]`, rounded-[2px]) with weekday labels (Mon /
     Wed / Fri) and month labels; horizontally scrollable on narrow screens, scrolled to the newest week on mount.
   * Colors: 5 steps of the theme's primary hue via CSS variables (`--activity-0..4`), defined for light and dark in
     `globals.css`; level 0 uses `bg-muted`. A small ring marks days with a `MAJOR` release.
   * Tooltip (title + `aria-label`): "3 updates on Mon, 14 Oct 2026 · 1 release, 2 commits".
   * Click a non-empty day → open the newest item of that day in the reader (`feedHref({ repositoryId }, releaseId)`);
     the query returns `id` for this.
   * Legend: "Less ▢▢▢▢▢ More" and a source filter (`All` / `Releases` / `Tags` / `Commits`, only the tracked ones)
     that re-buckets client side.
   * Footer note when the history is shallow: "Based on N stored updates since <date>. Load older releases to fill
     the grid." (links to the History section).
4. **`ActivityStats`:** updates in the last 12 months, last update (relative), median days between releases (releases
   and tags only; "—" with fewer than 3), busiest month, current streak of weeks with an update.

### Step 3.4: Search, sort and filters on `/repositories`
1. **`lib/repo-list-filters.ts`:**
   * Params: `q` (≤ 200 chars), `sort` ∈ `name` (default) · `-name` · `added` · `-added` (newest first is `-added`) ·
     `updated` (latest activity, newest first) · `synced` · `unread` · `stars`; `tag` (slug), `status` ∈ `unread` ·
     `error` · `paths` · `pinned` (Part C).
   * `parseRepoListFilters(params)`, `repoListHref(filters)`, `applyRepoListFilters(rows, filters, unreadByRepo)`.
   * Search matches, case-insensitively, `fullName`, `description`, assigned tag names and watched paths; multiple
     words must all match (AND). Ties in every sort fall back to `fullName`.
   * **Latest update** = `latestActivityAt`: the `publishedAt` of the newest item visible to the user (the same row as
     `latestRelease`, including commits); repositories with none sort last.
2. **`TrackedRepository`:** add `latestActivityAt: Date | null` (from `latest.publishedAt`).
3. **`RepoListToolbar` (client):** search `Input` with a search icon, `/` keyboard shortcut and a clear button,
   debounced 250 ms into `router.replace(repoListHref(...), { scroll: false })`; sort `Select`; tag `Select`; status
   toggle chips. Shows "12 of 48 repositories" and a "Clear filters" link when anything is active.
4. Empty search result state: "No repositories match `<q>`" + "Clear filters". The "No repositories yet" state is
   unchanged.

### Step 3.5: Server Action `updateSubscriptionSettingsAction`
1. Input `{ subscriptionId, includePrereleases?, ...Part C fields? }`, all optional, zod-validated (`.strict()`), at
   least one field present. Load the subscription with `{ id, userId: user.id }`; `NOT_FOUND` otherwise.
2. **Pre-releases:** turning it **on** seeds `UserReleaseState` for already-stored pre-releases the user would now see
   only if they are among the 10 newest visible items (as unread), matching `addRepositoryAction`; turning it **off**
   deletes the user's **unread** state rows for pre-release rows of that repository so the unread counter drops.
3. `revalidatePath("/repositories")`, `revalidatePath("/repositories/[owner]/[name]", "page")` and `"/"`; return
   `ActionResult<SubscriptionSettings>`; end with `toActionError(error, "updateSubscriptionSettingsAction")`.

### Step 3.6: Schema (`packages/db`, Part C only)
Add to `UserSubscription` only the fields of the §3.7 items that ship, in one migration
`<timestamp>_subscription_settings`:
```prisma
enum NotificationLevel { ALL MINOR_AND_UP MAJOR_ONLY NONE }

model UserSubscription {
  // …existing fields
  isPinned           Boolean           @default(false)
  note               String?           @db.Text        // ≤ 2 000 chars, plain text
  notificationLevel  NotificationLevel @default(ALL)
  snoozedUntil       DateTime?
  currentVersion     String?                           // ≤ 100 chars, the version the user runs
  tagIncludePatterns String[]          @default([])    // glob, ≤ 10 entries
  tagExcludePatterns String[]          @default([])    // glob, ≤ 10 entries
  ignoreBotCommits   Boolean           @default(false)
}
```
Rebuild packages after the change (rule 9).

### Step 3.7: Proposed per-subscription settings (Part C)
Ordered by value for effort. Each item lists where it is enforced.

1. **Pin to top (`isPinned`).** Pinned repositories sort first on `/repositories` (within any sort) and in the sidebar
   repository list; a pin icon button on the card and the settings header. *Effort: schema + list sort.*
2. **Personal note (`note`).** Free text ("why we track this", "blocked on v5 because …"), shown on the settings page
   and as a one-line hint on the card; included in the list search. Plain text rendered with `whitespace-pre-wrap`, no
   Markdown. *Effort: schema + form.*
3. **Notification level (`notificationLevel`).** Per-repository override applied **before** the user's notification
   rules in `planFanOut`: `ALL` (rules decide), `MINOR_AND_UP` (skip `PATCH` / `OTHER` / `PRERELEASE`), `MAJOR_ONLY`,
   `NONE` (feed only, no external notifications). In-app unread state and SSE are unaffected. Commits count as
   `OTHER`, so `MINOR_AND_UP` and `MAJOR_ONLY` silence them; the form says so. *Effort: schema + `ruleMatches` input.*
4. **Snooze (`snoozedUntil`).** "Snooze notifications for 1 day / 1 week / 1 month / until …": external notifications
   are skipped while `snoozedUntil > now`; the feed still updates. Card shows a "Snoozed until …" badge. Not retroactive:
   nothing is sent when the snooze ends. *Effort: schema + one check in fan-out.*
5. **My version (`currentVersion`).** The version the user runs (free text, validated loosely as a tag name). The
   settings page and card show "3 releases behind · 1 major" computed against visible `RELEASE`/`TAG` rows newer than
   the matching `tagName` (fallback: semver comparison of normalized versions when no row matches); feed cards of
   releases newer than it get a subtle "Newer than yours" marker. A "Set as my version" action on the reader drawer
   fills it. *Effort: schema + pure comparison helper (unit-tested) + UI; no worker change.*
6. **Tag-name filters (`tagIncludePatterns`, `tagExcludePatterns`).** Useful for monorepos that publish dozens of
   packages (include `@scope/cli@*`) or noisy channels (exclude `*-nightly*`, `*-rc*`). To stay expressible in Prisma
   (and free of ReDoS), a pattern allows `*` **only at the start and/or end**: `v*` → `startsWith`, `*-beta` →
   `endsWith`, `*nightly*` → `contains`, no `*` → `equals`; a `*` elsewhere is rejected by zod. Applied to
   `RELEASE` / `TAG` rows only (never `COMMIT`):
   * `visibleReleasesWhere` adds, for each of the user's subscriptions **that has patterns**, a clause
     `NOT { repositoryId, source in [RELEASE, TAG], <fails include-OR or matches an exclude> }`. Prisma cannot compare
     `Release.tagName` with a column of the subscription, so the clause is built in JS from the loaded patterns:
     `visibleReleasesWhere` takes an optional `tagFilters` argument, and a cached `getTagFilters(userId)` loads them
     once per request. The feed, the counters and the activity grid all pass it, so they agree without new state rows.
   * `planFanOut` gets the patterns on `FanOutSubscriber` and skips non-matching releases (no unread row, no
     notification), via a pure `matchesTagPatterns(tagName, include, exclude)` shared through `@repopulse/github`.
   * The settings page previews which of the last 20 stored tags pass.
   *Effort: the largest Part C item (query + worker + tests).*
7. **Ignore bot commits (`ignoreBotCommits`).** For "Files / folders": skip commits whose author login ends in
   `[bot]` (dependabot, renovate, github-actions) when creating the user's state rows in `pollRepoPaths` and when
   seeding in the actions. Needs the author login on the stored row: add `Release.authorLogin String?` (filled for new
   commit rows; old rows count as human). *Effort: small schema + worker + action change.*

Not proposed, considered: per-repo poll interval (polling is shared per repository, so a per-user interval is
meaningless), custom display name (low value), per-repo notification channel routing (already covered by tag-scoped
rules: tag the repository and add a rule for that tag; the settings page links to `/settings/notifications` with the
hint).

### Step 3.8: Docs & changelog
* `docs/web-app.md`: the new route, the list search params, `updateSubscriptionSettingsAction`.
* `docs/data-model.md`: the new `UserSubscription` fields and how fan-out uses them.
* `CHANGELOG.md` `## [Unreleased]`: Added (settings page, activity grid, list search/sort, each shipped Part C setting),
  Changed (card tracking controls moved to the settings page; pre-releases editable after adding).
* Write `PRD/slice_07_implementation_summary.md` when done.

---

## 4. Verification & Acceptance Criteria
- [ ] `/repositories/<owner>/<name>` shows the header, activity grid, tracking, tags, history and danger zone for a
      tracked repository; casing differences redirect to the canonical URL; an untracked or another user's repository
      returns the "Not tracked" page.
- [ ] Changing release mode, "Files / folders" paths and tags on the settings page behaves exactly as on the old cards
      (same actions, same imports queued); toggling **Include pre-releases** after adding updates the feed and unread
      counter immediately.
- [ ] The activity grid shows 53 weeks ending today, buckets by the browser's local day, matches the number of items
      the feed shows for that repository in the window, marks major-release days, and opens the reader on click.
- [ ] `/repositories?q=next&sort=-added&tag=frontend` filters and sorts on the server, survives reload, and the toolbar
      reflects it; "Latest update" sorts by the newest visible item, nulls last; ties sort by name.
- [ ] Each shipped Part C setting is per-user (a second subscriber of the same repository is unaffected) and enforced
      where §3.7 says (notification level and snooze in fan-out with unit tests; tag filters and bot commits in the
      feed, counters and grid alike).
- [ ] `pnpm --filter "./packages/*" build && pnpm typecheck && pnpm lint && pnpm test && pnpm --filter @repopulse/web build`
      passes, with unit tests for `repo-list-filters`, `activity-grid`, the version comparison helper, the settings
      query scoping and the fan-out checks.

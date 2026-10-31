# Slice 03 — Implementation Summary

**Spec:** [`slice_03_panel_ui_tagging_markdown_reader.md`](./slice_03_panel_ui_tagging_markdown_reader.md)
**Status:** Implemented. Unit tests, typecheck and production build pass. All three acceptance criteria were checked end to end in headless Chrome against the dev database (see §5).
**Date:** 2026-10-31

---

## 1. Files

```text
apps/web/
├── components.json                     shadcn/ui config (new-york, zinc, lucide)
├── postcss.config.mjs                  Tailwind v4 (@tailwindcss/postcss)
├── vitest.config.ts                    58 tests
└── src/
    ├── app/
    │   ├── globals.css                 Tailwind v4 theme tokens (light/dark via prefers-color-scheme), hljs colors
    │   ├── layout.tsx                  + globals.css, sonner <Toaster>
    │   ├── page.tsx                    (deleted — Slice 02 temporary shell)
    │   └── (dashboard)/
    │       ├── layout.tsx              auth gate, sidebar + navbar
    │       ├── page.tsx                unified release feed + changelog drawer
    │       └── repositories/page.tsx   tracked repositories grid, tag assignment, sync, remove
    ├── components/
    │   ├── ui/                         shadcn primitives: button, badge, input, label, checkbox, dialog,
    │   │                               sheet, popover, select, skeleton, sonner
    │   ├── layout/app-sidebar.tsx      All / Unread / Tracked Repositories, tags with color dot + unread count
    │   ├── layout/top-navbar.tsx       debounced search, unread bell (per-repo breakdown), Add Repo, account menu,
    │   │                               mobile sidebar sheet
    │   ├── feed/                       release-card, release-feed-list ("Load more"), feed-filter-bar,
    │   │                               semver-badge, tag-pill, repo-avatar, relative-time
    │   ├── reader/changelog-drawer.tsx slide-over reader (auto mark-read, View on GitHub, Mark unread, Sync now)
    │   ├── reader/changelog-markdown.tsx  server-rendered, sanitized GFM renderer
    │   ├── reader/reader-context.tsx   open-release + optimistic read state
    │   ├── modals/add-repo-modal.tsx
    │   ├── modals/manage-tags-modal.tsx create / rename / recolor / delete tags
    │   └── repositories/               assign-tags-popover, sync-repo-button, remove-subscription-button
    ├── lib/feed-filters.ts             URL <-> filter parsing (shared server/client)
    ├── lib/tags.ts                     slugify / tagSlug, hex validation, color presets
    ├── lib/utils.ts                    cn()
    └── server/
        ├── action-result.ts            ActionResult, fail/ok, toActionError, getGitHubToken (moved out of repositories.ts)
        ├── session.ts                  requireUser() → redirect("/login")
        ├── queries/feed.ts             getReleaseFeed, getReleaseDetail, getDashboardData, getTrackedRepositories,
        │                               countUnread, visibleReleasesWhere, buildFeedWhere, keyset cursor
        └── actions/
            ├── tags.ts                 createTagAction, updateTagAction, deleteTagAction, assignTagsAction
            ├── release-state.ts        toggleReleaseReadAction, markAllReadAction
            ├── sync.ts                 triggerManualRepoSyncAction (inline poll, 5-min cooldown)
            ├── feed.ts                 loadMoreReleasesAction
            ├── auth.ts                 signOutAction
            └── repositories.ts         now revalidates the whole dashboard layout
```

## 2. Dependencies added (`apps/web`)

All versions are pinned exactly, using the newest stable release that was at least 2 weeks old.

| Runtime | Version | | Dev | Version |
| --- | --- | --- | --- | --- |
| `react-markdown` | 10.1.0 | | `tailwindcss` / `@tailwindcss/postcss` | 4.3.3 |
| `remark-gfm` | 4.0.1 | | `@tailwindcss/typography` | 0.5.20 |
| `rehype-raw` | 7.0.0 | | `tw-animate-css` | 1.4.0 |
| `rehype-sanitize` | 6.0.0 | | `postcss` | 8.5.30 |
| `rehype-highlight` | 7.0.2 | | `vitest` | 5.0.5 (same as `@repopulse/db`) |
| `radix-ui` | 1.8.1 | | | |
| `lucide-react` | 1.58.0 | | | |
| `date-fns` | 4.4.0 | | | |
| `sonner` | 2.0.8 | | | |
| `clsx` / `tailwind-merge` / `class-variance-authority` | 2.1.1 / 3.7.0 / 0.7.1 | | | |

## 3. Design notes

### Visibility rule (one definition)
`visibleReleasesWhere(userId)` covers non-draft releases of repositories the user subscribes to. Pre-releases (`isPrerelease`) are excluded unless that subscription has
`includePrereleases`. The feed, the reader, `toggleReleaseReadAction`, `markAllReadAction`, the sidebar per-tag counts and the
navbar total all build on it, so the counters always match the feed.

### Read state
A release is **unread only if a `UserReleaseState` row with `isRead = false` exists**. Releases without a row predate the subscription
(the initial ingest seeds rows for the latest 10) and count as read. That is why `markAllReadAction` only needs an `updateMany`.

### Unread counts
`release.groupBy({ by: repositoryId })` returns unread counts per repository in one query. Per-tag counts are then summed in JS. A repository with
several tags counts towards each of them. `getDashboardData` is wrapped in React `cache()`, so the layout and the page share one call per request.
Views narrowed by SemVer type or search use a separate `countUnread()`.

### URL state
Filters live in the query string: `?tag=<slug>&repo=<id>&unread=1&semver=major&q=…&sort=oldest`. The open release is `?release=<id>`.
- The page renders on the server, so links can be shared and the back button closes the reader.
- `parseFeedFilters` ignores malformed values instead of querying with them.
- While the navigation is in flight, `useOptimistic` opens the drawer immediately using the card's data as a preview.

### Pagination
"Load more" calls `loadMoreReleasesAction` with a **keyset cursor** `<publishedAt ms>.<id>`. The query is `(publishedAt, id) < cursor`, with no `skip: 1`.
Prisma's `cursor` + `skip` drops a row when the cursor release stops matching the filter (e.g. it was just auto-marked read in the Unread view).
That case is covered by an end-to-end check.

### Changelog rendering & XSS
Release bodies are untrusted. `ChangelogMarkdown` is a Server Component, so neither the markdown pipeline nor the raw body is sent to the
browser; only the rendered tree is. The pipeline:
1. `remark-gfm`
2. `rehype-raw`: GitHub notes use `<details>`, `<img>` and `<br>`, which react-markdown would otherwise drop.
3. `rehype-sanitize` with GitHub's own `defaultSchema`. This strips `<script>`, `<iframe>`, `<style>`, `<form>`, `on*=` handlers,
   `javascript:`/`data:` URLs and inline styles, and prefixes ids with `user-content-`.
4. `rehype-highlight`, which runs after sanitizing.

External and protocol-relative links get `target="_blank" rel="noopener noreferrer nofollow ugc"`. Images load lazily with
`referrerPolicy="no-referrer"`.

### Auto mark-as-read
On opening, the drawer marks the release read once per open, optimistically. "Mark as unread" is respected while the drawer stays open;
reopening marks it read again. The actions call `revalidatePath("/", "layout")`, which refreshes the sidebar and navbar counters.

### Tags
- `tagSlug(name)`: `Self-Hosted` → `self-hosted`. Names with no Latin letters or digits (`Фронтенд`, `前端`) fall back to a stable FNV-1a
  hash (`tag-xxxxxx`).
- Duplicate names hit the `(userId, slug)` unique index and return a `CONFLICT` result.
- Colors must match `^#[0-9A-Fa-f]{6}$` and are stored uppercase.
- Renaming a tag re-derives its slug, so old `?tag=` links stop matching.

### Manual sync (`triggerManualRepoSyncAction`)
The spec puts the BullMQ queue in Slice 04. To make "Sync Repo Now" work today, this action polls GitHub inline with `pollRepoReleases` (`If-None-Match`).
- **Cooldown:** a 5-minute cooldown per repository, claimed atomically with `updateMany … where lastPolledAt < now - 5min`, so concurrent clicks poll once.
  A failed poll sets `pollStatus = ERROR` and increments `errorCount`.
- **Fan-out:** new releases are inserted with `createManyAndReturn({ skipDuplicates })`. Only releases **newer than the newest stored one** fan out as unread,
  capped at 10 per subscriber after that subscriber's pre-release filter. The 20-item poll page is larger than the 10-release initial ingest, so the first sync
  also backfills older releases; those must not appear as new.
- **Slice 04** keeps the signature and result type (`COOLDOWN | NOT_MODIFIED | UPDATED`) and swaps the body after the claim for a
  priority `repo-poll` job. The worker should apply the same "newer than newest known" rule.

### Other
- Dark mode follows `prefers-color-scheme`; there is no toggle yet.
- On mobile, the sidebar moves into a sheet.
- Sorting covers newest and oldest only. Sorting by repository name or stars (master PRD §3.4) would need a different cursor and is deferred.
- Search is a case-insensitive `ILIKE` across tag name, title, changelog body, repository full name and the user's tag names. At larger scale, a
  `pg_trgm` or `tsvector` index is the upgrade path.

## 4. Verification

| Check | Result |
| --- | --- |
| `pnpm --filter @repopulse/web test` | ✅ 58/58. Sanitizer (`<script>`, `onerror`, `javascript:`, iframe/style/form/object, `data:` images, DOM clobbering), GFM tables/task lists/strikethrough/details, highlighting, slugs, hex validation, URL filters, `where` builders, keyset cursor |
| `typecheck` (web) | ✅ |
| `next build` | ✅ Routes `/`, `/repositories`, `/login`, `/api/auth/[...nextauth]`, `/api/health` |
| Headless-Chrome end-to-end run, dev server + Postgres, fixture user | ✅ 26/26 acceptance checks + 8/8 pagination and reopen checks |

## 5. Acceptance criteria

- [x] **Tags:** created the tag `Critical` (`#EF4444`) in the tag modal, assigned it to a repository on `/repositories`, then clicked it in the sidebar.
  The feed showed only that repository's releases and the sidebar showed the per-tag unread count.
- [x] **Reader:** opening an unread release rendered the GFM table, highlighted code, task list, strikethrough and `<details>`.
  - `<script>`, `onerror=` and `javascript:` were stripped. No payload ran and no dialog opened.
  - The navbar counter dropped from 6 to 5.
  - "Mark as unread" restored it; "Sync repo now" showed the cooldown notice.
- [x] **Filters and search:** the `MAJOR` filter (via the select) returned only the major release. Searching for a word that appears only in a changelog body
  returned that release. "Mark all as read" brought the counter to 0.

No horizontal overflow at 390 px and no console errors. The fixture data was removed afterwards.

## 6. Notes for later slices

- **Slice 04:**
  - Replace the inline poll in `server/actions/sync.ts` with a BullMQ enqueue.
  - `sse-listener.tsx` can call `router.refresh()`; all counters are server-rendered.
  - Read-state actions already revalidate the dashboard layout.
- **Slice 04b (planned):** a background backfill of older release history. See [`slice_04b_release_history_backfill.md`](./slice_04b_release_history_backfill.md).
  Today a repository only holds its newest ~20 releases.
- **Slice 05:** deleting a tag sets `NotificationRule.tagId` to null (schema `onDelete: SetNull`). The rule then applies to all tags, so decide whether to
  delete or disable rules instead.
- `next dev` writes `apps/web/AGENTS.md` (Next 16.4 agent rules). Either commit it or set `agentRules: false` in `next.config.ts`.

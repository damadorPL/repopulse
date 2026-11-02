# Slice 07 — Implementation Summary

**Spec:** [`slice_07_repository_settings_activity.md`](./slice_07_repository_settings_activity.md)
**Status:** Implemented: Part A (settings page + activity grid), Part B (list search / sort / filters) and Part C items
1–5 (pin, note, notification level, snooze, my version). Part C items 6 (tag-name filters) and 7 (ignore bot commits)
are **not** implemented and have no schema fields; they stay in the spec as future work. Package builds, typecheck,
lint, all unit tests (web 171, worker 89, github 104, notifications 74, queue 23, db 14) and the web production build
pass. The migration was generated with `prisma migrate diff` against the previous schema but **not applied to a
database** (Docker was not running). Not checked in a browser (see §5).
**Date:** 2026-11-02

---

## 1. Files

```text
packages/db/prisma/
├── schema.prisma                                   NotificationLevel enum; UserSubscription.isPinned / note / notificationLevel /
│                                                     snoozedUntil / currentVersion
└── migrations/20261102120000_subscription_settings/ NEW

apps/worker/src/processors/
├── fan-out.ts (+ test)                             passesNotificationLevel, isSnoozed, mayNotify; planFanOut(…, now) skips
│                                                     notification jobs (not states / SSE) when mayNotify is false
├── repo-tags.ts                                    loadSubscribers selects notificationLevel + snoozedUntil (used by the
│                                                     release, tag and path steps)
└── notification.processor.ts (+ test)              re-checks snooze / level at dispatch: SNOOZED, NOTIFICATION_LEVEL skips

apps/web/src/
├── app/(dashboard)/repositories/page.tsx           toolbar, in-memory filter / sort, cards link to the settings page, feed icon,
│                                                     pin button, read-only tracking summary, note hint, snoozed badge, version status
├── app/(dashboard)/repositories/[owner]/[name]/page.tsx       NEW settings page (+ generateMetadata, canonical-casing redirect)
├── app/(dashboard)/repositories/[owner]/[name]/not-found.tsx  NEW "You don't track owner/name" + prefilled Add dialog
├── app/globals.css                                 --activity-1..4 (derived from --primary)
├── lib/repo-list-filters.ts (+ test)               NEW parse / serialize / apply, repositorySettingsHref, repoListHrefFrom
├── lib/activity-grid.ts (+ test)                   NEW bucketByLocalDay, buildWeeks, activityThresholds + levelFor, monthLabels,
│                                                     computeActivityStats, describeDay
├── lib/version-compare.ts (+ test)                 NEW parseVersion, compareVersions, findVersionRow, isNewerThanVersion,
│                                                     computeVersionStatus, formatVersionStatus
├── lib/subscription-settings.ts (+ test)           NEW action input schema, notification level options, limits, snooze presets
├── lib/track-modes.ts                              + trackingSummary
├── server/queries/feed.ts                          TrackedRepository + latestActivityAt and Part C fields; toTrackedRepository /
│                                                     loadTrackedRepositories extracted; FeedItem.newerThanMine / isMyVersion
├── server/queries/repository-settings.ts (+ test)  NEW getRepositorySettings, getRepositoryActivity, parseRepoSegment
├── server/actions/repositories.ts                  + updateSubscriptionSettingsAction
├── components/repositories/
│   ├── repo-list-toolbar.tsx                       NEW search (debounced, "/" shortcut, clear), sort, tag, status chips, "N of M"
│   ├── activity-grid.tsx / activity-stats.tsx      NEW heatmap + legend + source filter; stats
│   ├── tracking-settings.tsx                       NEW release mode, Files / folders switch with inline path editor, pre-releases
│   ├── tag-settings.tsx                            NEW tag pills with remove, AssignTagsPopover, Manage tags
│   ├── subscription-settings-form.tsx              NEW notification level, snooze, note, my version
│   ├── pin-button.tsx, set-my-version-button.tsx, not-tracked-state.tsx   NEW
│   ├── remove-subscription-button.tsx              + redirectTo, withLabel
│   └── track-mode-toggle.tsx                       DELETED (replaced by the settings page)
├── components/feed/release-card.tsx                "Newer than yours" / "Your version" marker
├── components/feed/relative-time.tsx               + LocalDateTime (absolute time in the viewer's zone, hydration-safe)
├── components/feed/tag-pill.tsx                    renders trailing children (remove button)
├── components/reader/changelog-drawer.tsx          "Set as my version"
└── components/modals/add-repo-modal.tsx            + defaultRepo

docs/web-app.md, docs/data-model.md, docs/worker.md, CHANGELOG.md
```

## 2. How it works

- **Settings page.** `getRepositorySettings` resolves the repository by `fullName` (`mode: "insensitive"`), then loads
  the subscription through `loadTrackedRepositories(userId, { repositoryId })`, which always adds `userId` (a
  subscription filter cannot widen it). No subscription → `null` → `notFound()`. The page redirects when the URL
  casing differs from `fullName`. The back link keeps the list state: card links carry `?from=<list query>`, which
  the page re-parses with `parseRepoListFilters` (so it can only point back at `/repositories`).
- **Activity grid.** `getRepositoryActivity` reads `visibleReleasesWhere(userId, { repositoryId })` for the last 371
  days (newest 5 000, `truncated` beyond), plus the total and the oldest visible date over all rows. The client
  buckets by local day after mount (a skeleton renders on the server), builds 53 × 7 weeks ending today, and picks
  levels from the quartiles of non-zero days. Clicking a day opens its newest item in the reader.
- **List.** `parseRepoListFilters` → `applyRepoListFilters(rows, filters, unreadByRepo)` on the server; pinned first,
  then the chosen sort, then `fullName`. `latestActivityAt` = the newer of the latest visible release / tag and the
  latest matching commit.
- **Notification level and snooze.** `mayNotify` runs before the rules in `planFanOut`; unread rows and SSE
  deliveries are planned regardless. The notification processor re-checks both at dispatch, so a snooze set after
  the fan-out queued a job still holds.
- **My version.** Visible `RELEASE` / `TAG` rows published after the row matching the version (exact `tagName`, then
  the `v`-prefix variant) are "behind"; without a match, SemVer comparison of normalized versions (`v1.2.3`,
  `release-1.2.3`, `pkg@1.2.3`). The feed loads the anchor rows of the page in one query (none when no version is set).
- **Pre-releases after adding.** On: stored pre-releases among the 10 newest visible items (per release mode) get
  unread states. Off: the user's unread states of pre-release rows of the repository are deleted.

## 3. Deviations from the spec

| Spec | Implemented | Why |
| --- | --- | --- |
| Part C items 6 and 7 | Not implemented, no schema fields | Out of scope for this delivery (as instructed). |
| `levelFor(count, max)` | `activityThresholds(counts)` + `levelFor(count, thresholds)` | Quartile thresholds need all day counts, not only the max. Days at the max are always level 4, so a sparse repository (every active day = 1) uses the strongest color. |
| Pinned repositories sort first "in the sidebar repository list" | Only on `/repositories` | The sidebar has no repository list (only tags); the navbar lists repositories by unread count. |
| `revalidatePath("/")` | `revalidatePath("/", "layout")` (plus the two spec paths) | Like every repository action: the sidebar / navbar unread counters change when pre-releases are toggled. |
| Search matches name, description, tags, paths | Also the note | §3.7 item 2 says the note is included in the list search. |
| Activity colors defined for light and dark | One definition via `color-mix` of `--primary` and `--muted` | The tokens already switch with the theme; a second copy would only drift. |
| — | The notification processor also re-checks snooze and level | A job queued just before the user snoozes would otherwise still be sent. |
| — | `TrackModeToggle` deleted | Its card row became the read-only summary; `TrackingSettings` replaces it on the settings page. |
| — | A snooze is limited to one year ahead; "Until …" snoozes through the end of the chosen local day | Guards against typos; matches how a date picker reads. |

## 4. Known limitations

- "N releases behind" reads at most 5 000 visible release / tag rows per list. Fine at self-hosted scale.
- The activity stats (median gap, busiest month) use the grid window (last 371 days), not the whole history.
- "Set as my version" accepts tag names that pass the loose validation only (no spaces or `~ ^ : ? * [ \`).
- The toolbar's debounced search uses the filters of the render that started it: changing the sort within 250 ms of
  typing can be undone by the search navigation.

## 5. Not verified yet

- Applying `20261102120000_subscription_settings` to a real database. Run `pnpm db:migrate:deploy`, then the
  `migrate diff` check from `docs/data-model.md`.
- The pages in a browser: settings page layout at narrow widths, grid scrolling and tooltips, the toolbar URL
  updates, the canonical-casing redirect and the not-found page. Only the production build ran.
- End to end: a snoozed / "Major releases only" subscription receiving a new patch release (no notification, unread
  row created), and a second subscriber of the same repository still notified.

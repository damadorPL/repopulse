# Slice 04c — Implementation Summary

**Spec:** [`slice_04c_tag_tracking.md`](./slice_04c_tag_tracking.md)
**Status:** Implemented. Typecheck, 201 unit tests and all builds pass. Migration applied to the local dev database. Not yet checked
end to end against real GitHub (see §5).
**Date:** 2026-11-01

---

## 1. Files

```text
packages/db/prisma/
├── schema.prisma                                 + enum ReleaseSource; Release.source / tagSha, githubReleaseId optional,
│                                                   @@unique([repositoryId, source, tagName]); Repository.lastTagsPolledAt
└── migrations/20261101090000_tag_tracking/       NEW (generated with `prisma migrate diff`)

packages/github/src/
├── tags.ts                                       NEW fetchRecentTags (GraphQL), compareCommits (REST), buildTagChangelog, mapTag
└── tags.test.ts                                  NEW

apps/worker/src/processors/
├── repo-tags.ts                                  NEW tag step (pollRepoTags), shared loadSubscribers / STORED_RELEASE_SELECT
├── repo-poll.processor.ts                        release step promotes tag rows; tag step after the release step (also after 304)
├── fan-out.ts                                    + mergeFanOutPlans, EMPTY_FAN_OUT_PLAN
├── release-backfill.processor.ts                 counts GitHub Releases only; promotes matching tag rows quietly
├── repo-tags.test.ts                             NEW
└── repo-poll.processor.test.ts / release-backfill.processor.test.ts   + promotion tests

apps/web/src/
├── server/queries/feed.ts                        visibleReleasesWhere honors trackMode; FeedItem.source; TrackedRepository.trackMode
├── server/actions/repositories.ts                addRepositoryAction trackMode; NEW updateTrackModeAction
├── server/repo-poll-queue.ts                     NEW queueTagImport (priority poll, not a "use server" module)
├── components/feed/source-badge.tsx              NEW "Tag" badge
├── components/feed/release-card.tsx, components/reader/changelog-drawer.tsx   badge; "Tagged" instead of "Published"
├── components/modals/add-repo-modal.tsx          "Also track Git tags without a GitHub release"
└── components/repositories/track-mode-toggle.tsx NEW per-card "Tags" toggle (on /repositories)
```

## 2. How it works

- **Polling.** Tags are polled once per repository, inside the regular `repo-poll` job, only while at least one subscriber uses
  `TAGS_AND_COMMITS`. The tag step runs after the release step, also when the release request returned 304. Steps:
  1. One GraphQL query reads the 20 newest tags by commit date. REST can't be used: its tags endpoint has no dates and no order.
  2. Tags already stored under that name are skipped, whether as a tag or as a release.
  3. Each new tag is compared with the next older tag: `GET /compare/{prev}...{tag}`.
  4. The rows are inserted.
- **Changelog body.** The annotated tag message, if any. Then "Commits since `<prev>`": newest first, at most 50, then "…and N more".
  Then the comparison link. The oldest tag in the list has no previous tag and shows the tagged commit instead.
- **What counts as new.**
  - A tag is new when it is newer than every row stored before this poll, of any source. With nothing stored, every tag is new, with
    the usual 10-per-user cap.
  - New tags fan out (unread rows, SSE, notification rules) only to `TAGS_AND_COMMITS` subscribers.
  - Releases now compare against the newest **`RELEASE`** row only. Tag rows are dated by their commit and must not shift this.
- **Promotion.** When a GitHub Release appears for a stored tag, the tag row is updated in place: `source = RELEASE`, plus the
  release's id, title, notes, URL and date.
  - When fresh, it fans out only to `RELEASES`-mode subscribers. Tag-mode users already received it as a tag, so they keep their read
    state and get no second notification.
  - The backfill promotes the same way, quietly, as history.
- **Visibility.** `visibleReleasesWhere` adds one condition: `source = RELEASE` **or** the user's subscription is `TAGS_AND_COMMITS`.
  Every query depends on it (feed, reader, unread counts, "mark all read"), so switching modes shows or hides tag rows immediately.
  Read state is kept.
- **Best effort.** Failures in the tag step are logged and skipped, and the next poll retries: GraphQL errors, rate limits, no token,
  network errors. They never fail the release poll and never call `queue.rateLimit()`. A failed comparison stores the tag without
  commits.
- **First import.** Adding a repository with "Releases + tags", or switching a card's "Tags" toggle on, queues a priority `repo-poll`
  job, but only if the repository's tags were never read (`lastTagsPolledAt` is null). This is quiet: no SYNC_* toasts.

## 3. Deviations from the spec

| Spec | Implemented | Why |
| --- | --- | --- |
| — | The add flow fetches and stores no tags itself | A synchronous GraphQL query plus up to 20 comparisons would slow down "Add". The queued priority poll imports them seconds later. |
| — | A release stored under the same tag name as a new GitHub Release (deleted and re-created) is kept; the new one is skipped | Same outcome as before (`skipDuplicates`), now explicit, so promotion can't hit the new unique key. |

## 4. Known limitations

- A lightweight tag on an old commit is dated by that commit. It can sort below the "newest stored" mark and then arrive as read
  history. Annotated tags use the tagger date, so they're not affected.
- Moving tags (`nightly`, `latest`) are stored once and never refreshed.
- Tags need a subscriber token. Anonymous polling skips the tag step.
- Each new tag costs 1 REST request (compare), and each tag poll costs 1 GraphQL point. A repository's first tag import can cost up to
  20 compare requests.

## 5. Not verified yet

- **End-to-end acceptance criteria** (spec §4) against real GitHub: a tags-only repository, a tag that later gets a Release, and
  switching modes. The GraphQL query shape and the `compare` path encoding of tags with `/` are covered by mocked tests only.

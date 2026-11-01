# Agent Implementation Slice 04c: Tag Tracking ("Releases + tags")

## 1. Objective & Scope
Today RepoPulse only tracks formal GitHub Releases, but many repositories publish versions as plain Git tags. This slice implements the master
PRD's **Tags Fallback** (§3.2) through the existing per-subscription `trackMode`:

* `RELEASES` (default, unchanged): only GitHub Releases.
* `TAGS_AND_COMMITS` ("Releases + tags"): GitHub Releases **plus** Git tags that have no Release. Each tag entry's changelog lists the
  **commits since the previous tag**.

* **Prerequisites:** Slices 01–04 and 04b.
* **Out of Scope:**
  * Backfilling tag history. Only the newest 20 tags are read on each poll, as releases were before 04b.
  * Parsing `CHANGELOG.md`.
  * Moving tags (`latest`, `nightly`). A tag name is stored once and never re-read.
  * Tags for anonymous polling. GraphQL requires a token, and every signed-in user has one.

### Design constraints
* `Repository`/`Release` rows are **shared**, but `trackMode` is per subscription. So tags are polled once per repository, but only while
  at least one subscriber uses `TAGS_AND_COMMITS`. Visibility is decided per user at query time.
* **One entry per version.** A tag that has (or later gets) a GitHub Release is never shown twice. When the Release appears, the tag row
  is **promoted** in place to a release row, so users who already saw the tag keep their read state and get no second notification.

---

## 2. Target Files to Create / Modify
```text
packages/db/prisma/schema.prisma               + enum ReleaseSource { RELEASE TAG }; Release.source, Release.tagSha,
                                                 Release.githubReleaseId optional, @@unique([repositoryId, source, tagName]);
                                                 Repository.lastTagsPolledAt
packages/db/prisma/migrations/<ts>_tag_tracking/
packages/github/src/tags.ts (+ tags.test.ts)   fetchRecentTags() (GraphQL), compareCommits() (REST), buildTagChangelog(), mapTag()
apps/worker/src/processors/repo-poll.processor.ts   tag step after the release step; tag → release promotion
apps/worker/src/processors/fan-out.ts          mergeFanOutPlans()
apps/worker/src/processors/release-backfill.processor.ts   release-only counts; promotes matching tag rows
apps/web/src/server/queries/feed.ts            visibility honors trackMode; FeedItem.source
apps/web/src/server/actions/repositories.ts    addRepositoryAction trackMode; updateTrackModeAction
apps/web/src/components/…                      Add-repo option, per-card toggle, "tag" badge in feed + reader
```

---

## 3. Step-by-Step Agent Instructions

### Step 3.1: Schema
1. Add `enum ReleaseSource { RELEASE TAG }` and these `Release` fields:
   * `source ReleaseSource @default(RELEASE)`
   * `tagSha String?`: the tagged commit
   * `githubReleaseId BigInt?`: tag rows have no GitHub release id. The existing unique key stays valid, because NULLs are distinct.
2. Add `@@unique([repositoryId, source, tagName])`, so a tag is stored once. GitHub already allows one published release per tag.
3. Add `Repository.lastTagsPolledAt DateTime?`. A `null` value means tags were never read, so the first switch to "Releases + tags"
   queues a poll.

### Step 3.2: `@repopulse/github` tag API
1. `fetchRecentTags({ owner, name, first = 20, accessToken, octokit? })` uses one GraphQL query:
   `refs(refPrefix: "refs/tags/", orderBy: { field: TAG_COMMIT_DATE, direction: DESC })`. It returns the tag name, the commit SHA and
   URL, the commit date and message, and the annotated tag's message and tagger date. The REST tags endpoint has no dates and no
   defined order, so it can't be used.
2. `compareCommits({ owner, name, base, head })` calls `GET /repos/{owner}/{repo}/compare/{base}...{head}` and returns the total
   count, the compare URL and up to 100 commits.
3. `buildTagChangelog(tag, compare | null)` is a pure function that returns Markdown:
   * the annotated tag message, if there is one
   * "Commits since `<previous>`": newest first, `[sha7](url) subject — @login`, at most 50 lines, then "…and N more"
   * the compare link
   * without a previous tag, the tagged commit
4. `mapTag(tag, repoHtmlUrl, body)` maps a tag to the `Release` row shape:
   * `source = TAG`, `githubReleaseId = null`, `title` = the first line of the tag message, or the tag name
   * `htmlUrl = <repo>/releases/tag/<tag>`
   * `publishedAt` = the tagger date, or the commit date
   * `semverType = classifySemver(tag)`, and `isPrerelease` means `semverType === PRERELEASE`
5. Errors:
   * GraphQL `NOT_FOUND` → `GitHubRepositoryNotFoundError`
   * GraphQL `RATE_LIMITED`, or 403/429 with quota 0 → `GitHubRateLimitError`

### Step 3.3: Poll processor
1. **Release step** (existing), with two changes:
   * "Newest known" now means the newest **`RELEASE`** row.
   * A missing release whose `tagName` matches a stored `TAG` row **promotes** that row instead of inserting: `source = RELEASE`, plus
     the release's id, title, body, URL and date. When fresh, a promoted release fans out **only** to `RELEASES`-mode subscribers. The
     `TAGS_AND_COMMITS` subscribers already received it as a tag.
2. **Tag step**: runs after the release step, also after a 304, when the repository has at least one `TAGS_AND_COMMITS` subscriber and
   a subscriber token exists.
   1. `fetchRecentTags(20)`. Drop tags already stored with either source.
   2. For each remaining tag, call `compareCommits(previous, tag)`, where `previous` is the next older tag in the list. If the compare
      fails, use a body without commits.
   3. Insert the rows with `createManyAndReturn({ skipDuplicates: true })`.
   4. A tag is **fresh** if it is newer than the newest row of any source stored before this poll. Fresh tags fan out (unread state,
      SSE, notification rules, pre-release filter, 10-per-user cap) **only** to `TAGS_AND_COMMITS` subscribers.
   5. Set `lastTagsPolledAt`.
3. The tag step is **best effort**. A GraphQL error, rate limit or network failure is logged and skipped, and the next poll retries.
   It never fails the release poll and never pauses the `repo-poll` queue.
4. `SYNC_COMPLETED.newReleases` counts fresh releases and tags for the requester.

### Step 3.4: Backfill coordination
`release-backfill` counts and compares **`RELEASE`** rows only. A backfilled release whose tag is stored as a `TAG` row promotes that row
quietly (history, no fan-out).

### Step 3.5: Visibility (`visibleReleasesWhere`)
A row is visible when it is a `RELEASE`, or when the user's subscription to its repository is `TAGS_AND_COMMITS`. Pre-release and draft
rules are unchanged. The feed, the reader, unread counters and "mark all read" all share this rule.

### Step 3.6: Actions & UI
1. `addRepositoryAction({ …, trackMode })` stores the mode. The initial unread seed only uses rows the mode can see. When the mode is
   `TAGS_AND_COMMITS` and `lastTagsPolledAt` is null, it queues a priority `repo-poll` job, which imports the tags in the background.
2. `updateTrackModeAction({ subscriptionId, trackMode })` is owner-only. Switching to tags on a never-tag-polled repository queues the
   same poll. Switching back only hides tag rows; their read state is kept.
3. UI:
   * **Add dialog:** checkbox "Also track Git tags without a GitHub release".
   * **Repository card:** "Tags" toggle.
   * **Feed card and reader:** a `tag` badge on tag entries.

---

## 4. Verification & Acceptance Criteria
- [ ] A repository that only pushes tags, added with "Releases + tags": within a poll, its newest tags appear (up to 10 unread). Each tag
      body lists the commits since the previous tag and links the GitHub comparison.
- [ ] The same repository for a `RELEASES`-mode user shows no tag entries, and their unread counter does not change.
- [ ] A tag that later gets a GitHub Release appears once. Tag-mode users keep their read state and get no second notification.
      Release-mode users receive it as a new release.
- [ ] A GraphQL failure or rate limit during the tag step leaves release polling and the queue unaffected.
- [ ] Switching a subscription between modes shows or hides tag entries immediately. Switching on a never-tag-polled repository queues a poll.
- [ ] Unit tests cover: GraphQL mapping and error mapping, the changelog builder, freshness and fan-out by mode, and promotion.

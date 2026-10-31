# Agent Implementation Slice 03: Dashboard Panel UI, Tags/Categories & Markdown Changelog Reader

## 1. Objective & Scope
Build the complete **RepoPulse** user interface in `apps/web` using Next.js App Router, Tailwind CSS, and `shadcn/ui`. This includes the left sidebar with custom color-coded Tags/Categories, the filterable Release Feed panel, the Add Repository modal, and the slide-over Markdown Changelog Reader with XSS sanitization and Read/Unread state management.

* **Prerequisites:** Slice 01 & Slice 02 completed.
* **Out of Scope:** Background BullMQ worker execution (Slice 04) and external webhook dispatch (Slice 05).

---

## 2. Target Files to Create / Modify
```text
repopulse/
└── apps/
    └── web/
        └── src/
            ├── server/
            │   ├── queries/
            │   │   └── feed.ts              # Typed DB queries for feed, repos, tags, unread counts
            │   └── actions/
            │       ├── tags.ts              # createTag, updateTag, deleteTag, assignTagsToSubscription
            │       └── release-state.ts     # markReleaseRead, markAllReadByFilter
            ├── components/
            │   ├── layout/
            │   │   ├── app-sidebar.tsx      # Navigation, Tag list with color dots & unread badges
            │   │   └── top-navbar.tsx       # Search input, Unread bell counter, "Add Repo" trigger
            │   ├── feed/
            │   │   ├── release-feed-list.tsx
            │   │   ├── release-card.tsx     # SemVer badge, repo avatar, tags, unread dot
            │   │   └── feed-filter-bar.tsx  # Filter by All/Unread, SemVer (Major/Minor/Patch), Sort
            │   ├── reader/
            │   │   └── changelog-drawer.tsx # Slide-over/Split-pane sanitized Markdown viewer
            │   └── modals/
            │       ├── add-repo-modal.tsx
            │       └── manage-tags-modal.tsx
            └── app/
                └── (dashboard)/
                    ├── layout.tsx
                    ├── page.tsx             # Unified Release Feed view
                    └── repositories/
                        └── page.tsx         # Grid/Table of tracked repositories & tag assignments
```

---

## 3. Step-by-Step Agent Instructions

### Step 3.1: Tag & Release State Server Actions
1. **`apps/web/src/server/actions/tags.ts`**:
   * `createTagAction({ name, colorHex })`: Generate URL-safe `slug` (e.g., `Self-Hosted` -> `self-hosted`), validate hex color (`^#[0-9A-Fa-f]{6}$`), and insert into `Tag` scoped to `userId`.
   * `assignTagsAction({ subscriptionId, tagIds })`: Replace `SubscriptionTag` rows for the user's subscription inside a transaction and call `revalidatePath('/')`.
   * `deleteTagAction({ tagId })`: Verify ownership (`userId`) and delete the tag.
2. **`apps/web/src/server/actions/release-state.ts`**:
   * `toggleReleaseReadAction({ releaseId, isRead })`: Upsert `UserReleaseState` for `(userId, releaseId)` setting `isRead` and `readAt: isRead ? new Date() : null`.
   * `markAllReadAction({ tagSlug, repositoryId })`: Bulk update/upsert `UserReleaseState` to `isRead = true` for all matching releases belonging to the user's subscriptions.

### Step 3.2: Feed Query Engine (`apps/web/src/server/queries/feed.ts`)
1. Implement `getReleaseFeed(params)`:
   * Filter parameters: `userId`, `tagSlug?: string`, `repositoryId?: string`, `onlyUnread?: boolean`, `semverType?: SemverType`, `searchQuery?: string`, `cursor?: string`, `limit = 25`.
   * Respect each subscription's `includePrereleases` setting (exclude `isPrerelease: true` releases if `subscription.includePrereleases === false`).
   * Include `repository`, assigned `tags` for that user's subscription, and the user's `UserReleaseState` (`isRead`).
   * Order by `publishedAt DESC`.

### Step 3.3: Dashboard Layout, Tag Sidebar & Release Feed Cards
1. **Sidebar (`app-sidebar.tsx`)**:
   * Links for **"All Releases"** (with total unread badge), **"Unread Only"**, and **"Tracked Repositories"**.
   * **"Categories / Tags"** section listing all user tags with their custom `colorHex` indicator dot, unread count per tag, and a **"+ New Tag"** button opening `manage-tags-modal.tsx`.
2. **Release Card (`release-card.tsx`)**:
   * Display Repository avatar, `owner/name`, Release `tagName` & `title`, relative `publishedAt` timestamp (`date-fns`), and assigned `Tag` pills.
   * Render color-coded SemVer badge:
     * `MAJOR`: Red/Rose badge (`Breaking / Major`)
     * `MINOR`: Blue badge (`Minor`)
     * `PATCH`: Emerald/Slate badge (`Patch`)
     * `PRERELEASE`: Amber badge (`Pre-release`)
   * Show an accent blue indicator dot if `!isRead`.

### Step 3.4: Split-Pane / Slide-Over Markdown Changelog Reader (`changelog-drawer.tsx`)
1. When a user clicks a `ReleaseCard`, open the slide-over or split-pane detail panel and automatically invoke `toggleReleaseReadAction({ releaseId, isRead: true })` if currently unread.
2. Render `release.bodyMarkdown` using `react-markdown` with `remark-gfm` (GitHub Flavored Markdown tables, task lists, strikethrough) and **`rehype-sanitize`** (mandatory to prevent XSS from untrusted release notes).
3. Include action buttons in the drawer header:
   * **"View on GitHub"** (`release.htmlUrl` external link)
   * **"Mark as Unread"** toggle button
   * **"Sync Repo Now"** button (triggers manual sync action).

---

## 4. Verification & Acceptance Criteria
- [ ] Users can create a tag (e.g., `Critical` with `#EF4444`), assign it to a tracked repository, and click the tag in the sidebar to filter the release feed to only that tag.
- [ ] Clicking an unread release opens the Markdown reader, renders GitHub tables/code blocks cleanly, strips any `<script>` or `onerror=` XSS vectors, and decrements the unread counter in the navbar.
- [ ] Filtering by `MAJOR` releases or searching via the search bar returns accurate results.
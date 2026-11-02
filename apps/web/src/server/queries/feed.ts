import { cache } from "react";
import {
  prisma,
  type BackfillStatus,
  type NotificationLevel,
  type Prisma,
  type ReleaseSource,
  type SemverType,
  type TrackMode,
} from "@repopulse/db";
import { FEED_PAGE_SIZE, type FeedFilters } from "@/lib/feed-filters";
import { computeVersionStatus, isNewerThanVersion, versionTagCandidates, type VersionStatus } from "@/lib/version-compare";

/**
 * Typed, user-scoped read queries for the dashboard. Every query goes through
 * {@link visibleReleasesWhere} so the feed, the reader and every unread counter agree on
 * which releases a user can see.
 */

// ---------------------------------------------------------------------------
// Types (plain objects — safe to pass to Client Components)
// ---------------------------------------------------------------------------

export interface TagPill {
  id: string;
  name: string;
  slug: string;
  colorHex: string;
}

export interface FeedRepository {
  id: string;
  owner: string;
  name: string;
  fullName: string;
  avatarUrl: string | null;
  htmlUrl: string;
}

export interface FeedItem {
  id: string;
  /**
   * `TAG`: a Git tag without a GitHub Release ("Releases + tags" subscriptions). `COMMIT`: a commit
   * touching a watched path ("Files / folders" subscriptions); `tagName` is its short SHA.
   */
  source: ReleaseSource;
  tagName: string;
  title: string;
  htmlUrl: string;
  isPrerelease: boolean;
  semverType: SemverType;
  publishedAt: Date;
  repository: FeedRepository;
  subscriptionId: string | null;
  tags: TagPill[];
  /** No `UserReleaseState` row means the release predates the subscription → treated as read. */
  isRead: boolean;
  /** Slice 07: a release / tag newer than the version the user set as theirs ("Newer than yours"). */
  newerThanMine: boolean;
  /** Slice 07: this release / tag is the version the user set as theirs. */
  isMyVersion: boolean;
}

export interface ReleaseDetail extends FeedItem {
  bodyMarkdown: string;
  repositoryLastPolledAt: Date | null;
}

export interface FeedPage {
  items: FeedItem[];
  nextCursor: string | null;
}

export interface GetReleaseFeedParams extends Partial<FeedFilters> {
  userId: string;
  cursor?: string | null;
  limit?: number;
}

// ---------------------------------------------------------------------------
// Where builders
// ---------------------------------------------------------------------------

/**
 * Releases the user can see: non-draft rows of repositories they subscribe to, minus pre-releases
 * for subscriptions with `includePrereleases = false`, and depending on the tracking mode:
 *
 * - GitHub Releases in "Releases only" and "Releases + tags",
 * - tag rows in "Releases + tags" (`TAGS_AND_COMMITS`),
 * - commit rows with "Files / folders" on (`trackPaths`, whatever the release mode), and only those
 *   with a `UserReleaseState` row for the user: commit rows are shared by everyone watching paths
 *   of the repository, and the state row is what says a commit matched this user's own paths.
 *
 * `subscriptionFilter` narrows the subscription (e.g. by tag).
 */
export function visibleReleasesWhere(
  userId: string,
  subscriptionFilter: Prisma.UserSubscriptionWhereInput = {},
): Prisma.ReleaseWhereInput {
  const subscribed = (where: Prisma.UserSubscriptionWhereInput): Prisma.ReleaseWhereInput => ({
    repository: { subscriptions: { some: { ...where, userId } } },
  });
  return {
    isDraft: false,
    repository: { subscriptions: { some: { ...subscriptionFilter, userId } } },
    AND: [
      { OR: [{ isPrerelease: false }, { repository: { subscriptions: { some: { userId, includePrereleases: true } } } }] },
      {
        OR: [
          { source: "RELEASE", ...subscribed({ trackMode: { in: ["RELEASES", "TAGS_AND_COMMITS"] } }) },
          { source: "TAG", ...subscribed({ trackMode: "TAGS_AND_COMMITS" }) },
          { source: "COMMIT", ...subscribed({ trackPaths: true }), userStates: { some: { userId } } },
        ],
      },
    ],
  };
}

/** Full feed filter → Prisma where (also used by `markAllReadAction`). */
export function buildFeedWhere(userId: string, filters: Partial<FeedFilters>): Prisma.ReleaseWhereInput {
  const and: Prisma.ReleaseWhereInput[] = [
    visibleReleasesWhere(userId, filters.tagSlug ? { tags: { some: { tag: { slug: filters.tagSlug } } } } : {}),
  ];

  if (filters.repositoryId) and.push({ repositoryId: filters.repositoryId });
  if (filters.onlyUnread) and.push({ userStates: { some: { userId, isRead: false } } });
  if (filters.semverType) and.push({ semverType: filters.semverType });

  const q = filters.searchQuery?.trim();
  if (q) {
    // Case-insensitive substring match (ILIKE) over repo names, release tag/title, changelog
    // bodies and the user's tag names. Fine at self-hosted scale; a pg_trgm / tsvector index
    // is the upgrade path if feeds grow large.
    const contains = { contains: q, mode: "insensitive" } as const;
    and.push({
      OR: [
        { tagName: contains },
        { title: contains },
        { bodyMarkdown: contains },
        { repository: { fullName: contains } },
        { repository: { subscriptions: { some: { userId, tags: { some: { tag: { name: contains } } } } } } },
      ],
    });
  }

  return { AND: and };
}

// ---------------------------------------------------------------------------
// Selects & mapping
// ---------------------------------------------------------------------------

function feedItemSelect(userId: string) {
  return {
    id: true,
    source: true,
    tagName: true,
    title: true,
    htmlUrl: true,
    isPrerelease: true,
    semverType: true,
    publishedAt: true,
    repository: {
      select: {
        id: true,
        owner: true,
        name: true,
        fullName: true,
        avatarUrl: true,
        htmlUrl: true,
        subscriptions: {
          where: { userId },
          select: {
            id: true,
            currentVersion: true,
            tags: { select: { tag: { select: { id: true, name: true, slug: true, colorHex: true } } } },
          },
        },
      },
    },
    userStates: { where: { userId }, select: { isRead: true } },
  } satisfies Prisma.ReleaseSelect;
}

type FeedRow = Prisma.ReleaseGetPayload<{ select: ReturnType<typeof feedItemSelect> }>;

function byName(a: { name: string }, b: { name: string }): number {
  return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
}

function toFeedItem(row: FeedRow): FeedItem {
  const { subscriptions, ...repository } = row.repository;
  const subscription = subscriptions[0];
  return {
    id: row.id,
    source: row.source,
    tagName: row.tagName,
    title: row.title,
    htmlUrl: row.htmlUrl,
    isPrerelease: row.isPrerelease,
    semverType: row.semverType,
    publishedAt: row.publishedAt,
    repository,
    subscriptionId: subscription?.id ?? null,
    tags: (subscription?.tags.map((t) => t.tag) ?? []).sort(byName),
    isRead: row.userStates[0]?.isRead ?? true,
    newerThanMine: false,
    isMyVersion:
      row.source !== "COMMIT" && Boolean(subscription?.currentVersion) && versionTagCandidates(subscription!.currentVersion!).includes(row.tagName),
  };
}

/**
 * Sets `newerThanMine` on the release / tag rows of repositories where the user set "my version":
 * newer than the stored row matching that version, or by SemVer when none matches. One query for
 * the anchor rows of the page, none when no version is set.
 */
async function markNewerThanMine<T extends FeedItem>(items: T[], rows: FeedRow[]): Promise<T[]> {
  const versions = new Map<string, string>();
  for (const row of rows) {
    const version = row.repository.subscriptions[0]?.currentVersion;
    if (version) versions.set(row.repository.id, version);
  }
  if (versions.size === 0) return items;
  const anchors = await prisma.release.findMany({
    where: {
      OR: [...versions].map(([repositoryId, version]) => ({
        repositoryId,
        source: { in: ["RELEASE" as const, "TAG" as const] },
        tagName: { in: versionTagCandidates(version) },
      })),
    },
    select: { repositoryId: true, tagName: true, publishedAt: true },
  });
  const anchorAt = new Map<string, Date>();
  for (const [repositoryId, version] of versions) {
    // Same preference as `findVersionRow`: the exact text first, then a `v`-prefix variant.
    for (const candidate of versionTagCandidates(version)) {
      const anchor = anchors.find((a) => a.repositoryId === repositoryId && a.tagName === candidate);
      if (anchor) {
        anchorAt.set(repositoryId, anchor.publishedAt);
        break;
      }
    }
  }
  return items.map((item) => {
    const version = versions.get(item.repository.id);
    if (!version || item.source === "COMMIT") return item;
    return { ...item, newerThanMine: isNewerThanVersion(item, version, anchorAt.get(item.repository.id) ?? null) };
  });
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/**
 * Keyset cursor `<publishedAt ms>.<id>`. Unlike Prisma's `cursor` + `skip: 1`, it stays correct
 * when the cursor row itself no longer matches the filter (e.g. it was just marked read in the
 * Unread view, or its repository was unsubscribed).
 */
export function encodeFeedCursor(row: { publishedAt: Date; id: string }): string {
  return `${row.publishedAt.getTime()}.${row.id}`;
}

export function decodeFeedCursor(cursor: string): { publishedAt: Date; id: string } | null {
  const match = /^(\d{1,15})\.([A-Za-z0-9_-]{1,64})$/.exec(cursor);
  if (!match) return null;
  const publishedAt = new Date(Number(match[1]));
  return Number.isNaN(publishedAt.getTime()) ? null : { publishedAt, id: match[2]! };
}

/** Rows strictly after the cursor in `(publishedAt, id)` order. */
export function afterCursorWhere(
  cursor: { publishedAt: Date; id: string },
  direction: "asc" | "desc",
): Prisma.ReleaseWhereInput {
  const op = direction === "desc" ? "lt" : "gt";
  return {
    OR: [{ publishedAt: { [op]: cursor.publishedAt } }, { publishedAt: cursor.publishedAt, id: { [op]: cursor.id } }],
  };
}

/** Cursor-paginated release feed, newest first by default. */
export async function getReleaseFeed(params: GetReleaseFeedParams): Promise<FeedPage> {
  const { userId, cursor, limit = FEED_PAGE_SIZE, ...filters } = params;
  const take = Math.min(Math.max(limit, 1), 100);
  const direction = filters.sort === "oldest" ? "asc" : "desc";
  const after = cursor ? decodeFeedCursor(cursor) : null;
  if (cursor && !after) return { items: [], nextCursor: null };

  const where = buildFeedWhere(userId, filters);
  const rows = await prisma.release.findMany({
    where: after ? { AND: [where, afterCursorWhere(after, direction)] } : where,
    // `id` breaks ties between releases published in the same millisecond (keeps cursors stable).
    orderBy: [{ publishedAt: direction }, { id: direction }],
    take: take + 1,
    select: feedItemSelect(userId),
  });

  const hasMore = rows.length > take;
  const page = hasMore ? rows.slice(0, take) : rows;
  const last = page.at(-1);
  return {
    items: await markNewerThanMine(page.map(toFeedItem), page),
    nextCursor: hasMore && last ? encodeFeedCursor(last) : null,
  };
}

/** Unread releases matching a filter (for views narrowed by SemVer type or search). */
export async function countUnread(userId: string, filters: Partial<FeedFilters>): Promise<number> {
  return prisma.release.count({ where: buildFeedWhere(userId, { ...filters, onlyUnread: true }) });
}

/** A single release with its changelog, or null if the user can't see it. */
export async function getReleaseDetail(userId: string, releaseId: string): Promise<ReleaseDetail | null> {
  const row = await prisma.release.findFirst({
    where: { AND: [{ id: releaseId }, visibleReleasesWhere(userId)] },
    select: {
      ...feedItemSelect(userId),
      bodyMarkdown: true,
      repository: { select: { ...feedItemSelect(userId).repository.select, lastPolledAt: true } },
    },
  });
  if (!row) return null;
  const { lastPolledAt, ...repository } = row.repository;
  const [item] = await markNewerThanMine([toFeedItem({ ...row, repository })], [{ ...row, repository }]);
  return {
    ...item!,
    bodyMarkdown: row.bodyMarkdown,
    repositoryLastPolledAt: lastPolledAt,
  };
}

export interface SidebarTag extends TagPill {
  repositoryCount: number;
  unreadCount: number;
}

export interface UnreadByRepository {
  repositoryId: string;
  fullName: string;
  avatarUrl: string | null;
  unreadCount: number;
}

export interface SubscriptionSummary {
  id: string;
  repositoryId: string;
  fullName: string;
  tagIds: string[];
}

export interface DashboardData {
  tags: SidebarTag[];
  subscriptions: SubscriptionSummary[];
  totalUnread: number;
  /** Repositories with unread releases, most unread first. */
  unreadByRepository: UnreadByRepository[];
}

/**
 * Sidebar / navbar data: tags with per-tag unread counts, subscriptions and unread totals.
 * Unread counts are grouped by repository in one query, then summed per tag — a repository
 * with several tags counts towards each of them. Memoized per request (layout + page share it).
 */
export const getDashboardData = cache(async (userId: string): Promise<DashboardData> => {
  const [tags, subscriptions, unreadGroups] = await Promise.all([
    prisma.tag.findMany({
      where: { userId },
      select: { id: true, name: true, slug: true, colorHex: true, subscriptions: { select: { subscriptionId: true } } },
    }),
    prisma.userSubscription.findMany({
      where: { userId },
      select: {
        id: true,
        repositoryId: true,
        repository: { select: { fullName: true, avatarUrl: true } },
        tags: { select: { tagId: true } },
      },
    }),
    prisma.release.groupBy({
      by: ["repositoryId"],
      where: { AND: [visibleReleasesWhere(userId), { userStates: { some: { userId, isRead: false } } }] },
      _count: { _all: true },
    }),
  ]);

  const unreadByRepoId = new Map(unreadGroups.map((group) => [group.repositoryId, group._count._all]));
  const unreadBySubscriptionId = new Map(subscriptions.map((s) => [s.id, unreadByRepoId.get(s.repositoryId) ?? 0]));

  const sidebarTags: SidebarTag[] = tags
    .map(({ subscriptions: links, ...tag }) => ({
      ...tag,
      repositoryCount: links.length,
      unreadCount: links.reduce((sum, link) => sum + (unreadBySubscriptionId.get(link.subscriptionId) ?? 0), 0),
    }))
    .sort(byName);

  const unreadByRepository: UnreadByRepository[] = subscriptions
    .map((s) => ({
      repositoryId: s.repositoryId,
      fullName: s.repository.fullName,
      avatarUrl: s.repository.avatarUrl,
      unreadCount: unreadByRepoId.get(s.repositoryId) ?? 0,
    }))
    .filter((r) => r.unreadCount > 0)
    .sort((a, b) => b.unreadCount - a.unreadCount || a.fullName.localeCompare(b.fullName));

  return {
    tags: sidebarTags,
    subscriptions: subscriptions
      .map((s) => ({
        id: s.id,
        repositoryId: s.repositoryId,
        fullName: s.repository.fullName,
        tagIds: s.tags.map((t) => t.tagId),
      }))
      .sort((a, b) => a.fullName.localeCompare(b.fullName)),
    totalUnread: unreadByRepository.reduce((sum, r) => sum + r.unreadCount, 0),
    unreadByRepository,
  };
});

export interface TrackedRepository {
  subscriptionId: string;
  includePrereleases: boolean;
  /** Release tracking: "Releases only", "Releases + tags" or `NONE`. */
  trackMode: TrackMode;
  /** "Files / folders": commits touching `watchedPaths`, alongside the release mode. */
  trackPaths: boolean;
  /** Watched file or folder paths; kept while `trackPaths` is off. */
  watchedPaths: string[];
  subscribedAt: Date;
  tags: TagPill[];
  /** Slice 07: pinned repositories sort first on `/repositories`. */
  isPinned: boolean;
  /** Slice 07: the user's plain-text note. */
  note: string | null;
  /** Slice 07: per-repository notification override (enforced by the worker fan-out). */
  notificationLevel: NotificationLevel;
  /** Slice 07: external notifications are skipped until then. */
  snoozedUntil: Date | null;
  /** Slice 07: the version the user runs. */
  currentVersion: string | null;
  /** How far `currentVersion` is behind the visible releases / tags; `null` when unset or not comparable. */
  versionStatus: VersionStatus | null;
  repository: FeedRepository & {
    description: string | null;
    starsCount: number;
    lastPolledAt: Date | null;
    pollStatus: "IDLE" | "POLLING" | "ERROR";
    releaseCount: number;
    history: RepositoryHistory;
  };
  latestRelease: { id: string; source: ReleaseSource; tagName: string; semverType: SemverType; publishedAt: Date } | null;
  /** `publishedAt` of the newest item visible to the user (release, tag or commit); `null` when there is none. */
  latestActivityAt: Date | null;
}

/** Release-history backfill state of a repository (Slice 04b). */
export interface RepositoryHistory {
  status: BackfillStatus;
  /** GitHub has older releases that "Load older releases" could import. */
  hasMore: boolean;
  target: number;
  /** Publication date of the oldest stored release. */
  oldestAt: Date | null;
}

export const TRACKED_REPOSITORY_SELECT = {
  id: true,
  includePrereleases: true,
  trackMode: true,
  trackPaths: true,
  watchedPaths: true,
  isPinned: true,
  note: true,
  notificationLevel: true,
  snoozedUntil: true,
  currentVersion: true,
  createdAt: true,
  tags: { select: { tag: { select: { id: true, name: true, slug: true, colorHex: true } } } },
  repository: {
    select: {
      id: true,
      owner: true,
      name: true,
      fullName: true,
      avatarUrl: true,
      htmlUrl: true,
      description: true,
      starsCount: true,
      lastPolledAt: true,
      pollStatus: true,
      backfillStatus: true,
      backfillNextPage: true,
      backfillTarget: true,
      // GitHub Releases only: this is the release history count of the backfill status line.
      _count: { select: { releases: { where: { isDraft: false, source: "RELEASE" } } } },
      // A few recent rows so the latest one matching the subscription settings can be picked.
      // Commit rows are picked separately: they are frequent and would crowd releases out.
      releases: {
        where: { isDraft: false, source: { in: ["RELEASE", "TAG"] } },
        orderBy: [{ publishedAt: "desc" }, { id: "desc" }],
        take: 20,
        select: { id: true, tagName: true, semverType: true, publishedAt: true, isPrerelease: true, source: true },
      },
    },
  },
} satisfies Prisma.UserSubscriptionSelect;

export type TrackedRepositoryRow = Prisma.UserSubscriptionGetPayload<{ select: typeof TRACKED_REPOSITORY_SELECT }>;
type LatestRow = { id: string; source: ReleaseSource; tagName: string; semverType: SemverType; publishedAt: Date };

/** Most visible release / tag rows read per list to compute "N releases behind". */
const VERSION_ROWS_CAP = 5000;

/**
 * Maps a subscription row (+ the per-list lookups) to the view type shared by `/repositories` and
 * the repository settings page.
 */
export function toTrackedRepository(
  row: TrackedRepositoryRow,
  extras: { oldestAt: Date | null; latestCommit: LatestRow | undefined; versionStatus: VersionStatus | null },
): TrackedRepository {
  const { _count, releases, backfillStatus, backfillNextPage, backfillTarget, ...repository } = row.repository;
  // The latest release when releases are tracked, else (or when none matches yet) the latest matching commit.
  const latestRelease =
    row.trackMode === "NONE"
      ? undefined
      : releases.find(
          (r) => (row.includePrereleases || !r.isPrerelease) && (r.source === "RELEASE" || row.trackMode === "TAGS_AND_COMMITS"),
        );
  const latestCommit = row.trackPaths ? extras.latestCommit : undefined;
  const latest = latestRelease ?? latestCommit;
  // The newest visible item of any kind ("Latest update" sort): a commit may be newer than the latest release.
  const activityTimes = [latestRelease?.publishedAt, latestCommit?.publishedAt].filter((d): d is Date => d instanceof Date);
  const latestActivityAt = activityTimes.length > 0 ? new Date(Math.max(...activityTimes.map((d) => d.getTime()))) : null;
  return {
    subscriptionId: row.id,
    includePrereleases: row.includePrereleases,
    trackMode: row.trackMode,
    trackPaths: row.trackPaths,
    watchedPaths: row.watchedPaths,
    subscribedAt: row.createdAt,
    tags: row.tags.map((t) => t.tag).sort(byName),
    isPinned: row.isPinned,
    note: row.note,
    notificationLevel: row.notificationLevel,
    snoozedUntil: row.snoozedUntil,
    currentVersion: row.currentVersion,
    versionStatus: extras.versionStatus,
    repository: {
      ...repository,
      releaseCount: _count.releases,
      history: {
        status: backfillStatus,
        hasMore: backfillNextPage !== null,
        target: backfillTarget,
        oldestAt: extras.oldestAt,
      },
    },
    latestRelease: latest
      ? { id: latest.id, source: latest.source, tagName: latest.tagName, semverType: latest.semverType, publishedAt: latest.publishedAt }
      : null,
    latestActivityAt,
  };
}

/**
 * Tracked repositories of a user matching `where` (always scoped to `userId`, which `where` cannot
 * override), with the lookups that take one query per list rather than per row: oldest stored
 * release, latest matching commit and the "my version" status.
 */
export async function loadTrackedRepositories(
  userId: string,
  where: Prisma.UserSubscriptionWhereInput = {},
): Promise<TrackedRepository[]> {
  const rows = await prisma.userSubscription.findMany({
    where: { ...where, userId },
    select: TRACKED_REPOSITORY_SELECT,
  });
  if (rows.length === 0) return [];

  const pathRepositoryIds = rows.filter((row) => row.trackPaths).map((row) => row.repository.id);
  const versionRepositoryIds = rows.filter((row) => row.currentVersion && row.trackMode !== "NONE").map((row) => row.repository.id);
  const [oldest, latestCommits, versionRows] = await Promise.all([
    prisma.release.groupBy({
      by: ["repositoryId"],
      where: { repositoryId: { in: rows.map((row) => row.repository.id) }, isDraft: false, source: "RELEASE" },
      _min: { publishedAt: true },
    }),
    // "Files / folders": the newest commit matching the user's own paths (it has a state row).
    pathRepositoryIds.length > 0
      ? prisma.release.findMany({
          where: { repositoryId: { in: pathRepositoryIds }, source: "COMMIT", userStates: { some: { userId } } },
          orderBy: [{ publishedAt: "desc" }, { id: "desc" }],
          distinct: ["repositoryId"],
          select: { id: true, repositoryId: true, source: true, tagName: true, semverType: true, publishedAt: true },
        })
      : [],
    // "My version": the visible releases / tags of the repositories that have one set.
    versionRepositoryIds.length > 0
      ? prisma.release.findMany({
          where: {
            AND: [
              visibleReleasesWhere(userId, { repositoryId: { in: versionRepositoryIds } }),
              { repositoryId: { in: versionRepositoryIds }, source: { in: ["RELEASE", "TAG"] } },
            ],
          },
          orderBy: [{ publishedAt: "desc" }, { id: "desc" }],
          take: VERSION_ROWS_CAP,
          select: { repositoryId: true, tagName: true, publishedAt: true, semverType: true },
        })
      : [],
  ]);
  const oldestByRepo = new Map(oldest.map((r) => [r.repositoryId, r._min.publishedAt]));
  const latestCommitByRepo = new Map(latestCommits.map((r) => [r.repositoryId, r]));
  const versionRowsByRepo = new Map<string, Array<{ tagName: string; publishedAt: Date; semverType: SemverType }>>();
  for (const row of versionRows) {
    const list = versionRowsByRepo.get(row.repositoryId);
    if (list) list.push(row);
    else versionRowsByRepo.set(row.repositoryId, [row]);
  }

  return rows.map((row) =>
    toTrackedRepository(row, {
      oldestAt: oldestByRepo.get(row.repository.id) ?? null,
      latestCommit: latestCommitByRepo.get(row.repository.id),
      versionStatus:
        row.currentVersion && row.trackMode !== "NONE"
          ? computeVersionStatus(versionRowsByRepo.get(row.repository.id) ?? [], row.currentVersion)
          : null,
    }),
  );
}

/** Subscriptions for the "Tracked Repositories" page, alphabetical (the page re-sorts with `applyRepoListFilters`). */
export async function getTrackedRepositories(userId: string): Promise<TrackedRepository[]> {
  const repositories = await loadTrackedRepositories(userId);
  return repositories.sort((a, b) => a.repository.fullName.localeCompare(b.repository.fullName));
}

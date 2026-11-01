import { cache } from "react";
import { prisma, type BackfillStatus, type Prisma, type ReleaseSource, type SemverType, type TrackMode } from "@repopulse/db";
import { FEED_PAGE_SIZE, type FeedFilters } from "@/lib/feed-filters";

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
 * - commit rows in "Files / folders" (`PATHS`), and only those with a `UserReleaseState` row for
 *   the user: commit rows are shared by everyone watching paths of the repository, and the state
 *   row is what says a commit matched this user's own watched paths.
 *
 * `subscriptionFilter` narrows the subscription (e.g. by tag).
 */
export function visibleReleasesWhere(
  userId: string,
  subscriptionFilter: Prisma.UserSubscriptionWhereInput = {},
): Prisma.ReleaseWhereInput {
  const inMode = (trackMode: TrackMode | { in: TrackMode[] }): Prisma.ReleaseWhereInput => ({
    repository: { subscriptions: { some: { userId, trackMode } } },
  });
  return {
    isDraft: false,
    repository: { subscriptions: { some: { ...subscriptionFilter, userId } } },
    AND: [
      { OR: [{ isPrerelease: false }, { repository: { subscriptions: { some: { userId, includePrereleases: true } } } }] },
      {
        OR: [
          { source: "RELEASE", ...inMode({ in: ["RELEASES", "TAGS_AND_COMMITS"] }) },
          { source: "TAG", ...inMode("TAGS_AND_COMMITS") },
          { source: "COMMIT", ...inMode("PATHS"), userStates: { some: { userId } } },
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
          select: { id: true, tags: { select: { tag: { select: { id: true, name: true, slug: true, colorHex: true } } } } },
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
  };
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
  return { items: page.map(toFeedItem), nextCursor: hasMore && last ? encodeFeedCursor(last) : null };
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
  return {
    ...toFeedItem({ ...row, repository }),
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
  trackMode: TrackMode;
  /** Watched file or folder paths ("Files / folders" mode); kept when switching to another mode. */
  watchedPaths: string[];
  subscribedAt: Date;
  tags: TagPill[];
  repository: FeedRepository & {
    description: string | null;
    starsCount: number;
    lastPolledAt: Date | null;
    pollStatus: "IDLE" | "POLLING" | "ERROR";
    releaseCount: number;
    history: RepositoryHistory;
  };
  latestRelease: { id: string; source: ReleaseSource; tagName: string; semverType: SemverType; publishedAt: Date } | null;
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

/** Subscriptions for the "Tracked Repositories" page, alphabetical. */
export async function getTrackedRepositories(userId: string): Promise<TrackedRepository[]> {
  const rows = await prisma.userSubscription.findMany({
    where: { userId },
    select: {
      id: true,
      includePrereleases: true,
      trackMode: true,
      watchedPaths: true,
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
          // Commit rows are picked separately below: they are frequent and would crowd releases out.
          releases: {
            where: { isDraft: false, source: { in: ["RELEASE", "TAG"] } },
            orderBy: [{ publishedAt: "desc" }, { id: "desc" }],
            take: 20,
            select: { id: true, tagName: true, semverType: true, publishedAt: true, isPrerelease: true, source: true },
          },
        },
      },
    },
  });

  const pathRepositoryIds = rows.filter((row) => row.trackMode === "PATHS").map((row) => row.repository.id);
  const [oldest, latestCommits] = await Promise.all([
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
  ]);
  const oldestByRepo = new Map(oldest.map((r) => [r.repositoryId, r._min.publishedAt]));
  const latestCommitByRepo = new Map(latestCommits.map((r) => [r.repositoryId, r]));

  return rows
    .map(({ repository: { _count, releases, backfillStatus, backfillNextPage, backfillTarget, ...repository }, ...row }) => {
      const latest =
        row.trackMode === "PATHS"
          ? latestCommitByRepo.get(repository.id)
          : releases.find(
              (r) =>
                (row.includePrereleases || !r.isPrerelease) && (r.source === "RELEASE" || row.trackMode === "TAGS_AND_COMMITS"),
            );
      return {
        subscriptionId: row.id,
        includePrereleases: row.includePrereleases,
        trackMode: row.trackMode,
        watchedPaths: row.watchedPaths,
        subscribedAt: row.createdAt,
        tags: row.tags.map((t) => t.tag).sort(byName),
        repository: {
          ...repository,
          releaseCount: _count.releases,
          history: {
            status: backfillStatus,
            hasMore: backfillNextPage !== null,
            target: backfillTarget,
            oldestAt: oldestByRepo.get(repository.id) ?? null,
          },
        },
        latestRelease: latest
          ? { id: latest.id, source: latest.source, tagName: latest.tagName, semverType: latest.semverType, publishedAt: latest.publishedAt }
          : null,
      };
    })
    .sort((a, b) => a.repository.fullName.localeCompare(b.repository.fullName));
}

import { prisma } from "@repopulse/db";
import { ACTIVITY_WINDOW_DAYS, type ActivityItem } from "@/lib/activity-grid";
import { getBackfillConfig } from "@/server/backfill-settings";
import { loadTrackedRepositories, visibleReleasesWhere, type TagPill, type TrackedRepository } from "./feed";

/**
 * Read queries of the repository settings page, `/repositories/[owner]/[name]` (Slice 07). The URL
 * addresses the signed-in user's own subscription: the repository is resolved by `fullName`
 * (case-insensitive), then the subscription by `{ userId, repositoryId }`. Anything the user does
 * not subscribe to resolves to `null`, which the page turns into `notFound()`.
 */

export interface RepositorySettings extends TrackedRepository {
  /** Every tag of the user, for the tag picker. */
  allTags: TagPill[];
  /** Releases a repository may hold at most ("Load older releases" stops there). */
  hardCap: number;
}

/** GitHub owner and repository names: letters, digits, `.`, `-` and `_`. */
const NAME_RE = /^[A-Za-z0-9_.-]{1,100}$/;

/** Decodes a route segment defensively and checks it is a plausible GitHub name. */
export function parseRepoSegment(segment: string): string | null {
  let value = segment;
  if (value.includes("%")) {
    try {
      value = decodeURIComponent(value);
    } catch {
      return null;
    }
  }
  return NAME_RE.test(value) && value !== "." && value !== ".." ? value : null;
}

/**
 * The user's subscription to `owner/name` with everything the settings page shows, or `null` when
 * the repository is unknown or the user does not subscribe to it.
 */
export async function getRepositorySettings(userId: string, owner: string, name: string): Promise<RepositorySettings | null> {
  const ownerName = parseRepoSegment(owner);
  const repoName = parseRepoSegment(name);
  if (!ownerName || !repoName) return null;

  const repository = await prisma.repository.findFirst({
    where: { fullName: { equals: `${ownerName}/${repoName}`, mode: "insensitive" } },
    select: { id: true },
  });
  if (!repository) return null;

  // `loadTrackedRepositories` always adds `userId`: another user's subscription can never match.
  const [tracked, tags, { hardCap }] = await Promise.all([
    loadTrackedRepositories(userId, { repositoryId: repository.id }),
    prisma.tag.findMany({ where: { userId }, select: { id: true, name: true, slug: true, colorHex: true } }),
    getBackfillConfig(),
  ]);
  const subscription = tracked[0];
  if (!subscription) return null;

  return {
    ...subscription,
    allTags: tags.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" })),
    hardCap,
  };
}

/** Most items the activity grid receives; a busy "Files / folders" subscription can have far more. */
export const ACTIVITY_ITEMS_CAP = 5000;

export interface RepositoryActivity {
  /** Visible items of the last {@link ACTIVITY_WINDOW_DAYS} days, newest first (at most {@link ACTIVITY_ITEMS_CAP}). */
  items: ActivityItem[];
  /** The window held more than {@link ACTIVITY_ITEMS_CAP} items. */
  truncated: boolean;
  /** Every visible item of the repository, not only the window. */
  total: number;
  /** Publication date of the oldest visible item. */
  firstStoredAt: Date | null;
}

/**
 * Updates of one repository for the activity grid, through `visibleReleasesWhere`, so the grid,
 * the feed and the unread counters agree (commit rows count only with a state row of the user).
 * Timestamps only: the browser buckets them by its local day.
 */
export async function getRepositoryActivity(userId: string, repositoryId: string, now: Date = new Date()): Promise<RepositoryActivity> {
  const visible = { AND: [visibleReleasesWhere(userId, { repositoryId }), { repositoryId }] };
  const since = new Date(now.getTime() - ACTIVITY_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const [rows, total, oldest] = await Promise.all([
    prisma.release.findMany({
      where: { AND: [visible, { publishedAt: { gte: since } }] },
      orderBy: [{ publishedAt: "desc" }, { id: "desc" }],
      take: ACTIVITY_ITEMS_CAP + 1,
      select: { id: true, publishedAt: true, source: true, semverType: true },
    }),
    prisma.release.count({ where: visible }),
    prisma.release.aggregate({ where: visible, _min: { publishedAt: true } }),
  ]);
  const truncated = rows.length > ACTIVITY_ITEMS_CAP;
  return {
    items: (truncated ? rows.slice(0, ACTIVITY_ITEMS_CAP) : rows).map((row) => ({
      id: row.id,
      at: row.publishedAt.toISOString(),
      source: row.source,
      semverType: row.semverType,
    })),
    truncated,
    total,
    firstStoredAt: oldest._min.publishedAt,
  };
}

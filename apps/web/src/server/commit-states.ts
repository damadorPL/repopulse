import type { Prisma } from "@repopulse/db";
import { INITIAL_RELEASES_LIMIT } from "@repopulse/github";
import { commitMatchesAnyPath } from "@/lib/watched-paths";

/**
 * Read state of "Files / folders" subscriptions (Slice 06). Commit rows are shared by everyone
 * watching paths of a repository; a user sees a commit only through their `UserReleaseState` row
 * (see `visibleReleasesWhere`). So whenever a user's watched paths change, their state rows must
 * follow: rows of commits that no longer match go, matching stored commits get one.
 *
 * Not a `"use server"` module: it is called from Server Actions, never from the browser.
 */

export interface CommitStatePlan {
  /** Matching commits without a state that become unread (the newest {@link INITIAL_RELEASES_LIMIT} matches). */
  unread: string[];
  /** Older matching commits without a state: visible, but read. */
  read: string[];
  /** States of commits that no longer match. */
  prune: string[];
  /** Matching stored commits in total. */
  matching: number;
}

/**
 * Pure planner. `commits` must be sorted newest first. Existing states of matching commits are
 * kept as they are (read or unread).
 */
export function planCommitStates(
  commits: ReadonlyArray<{ id: string; changedPaths: string[] }>,
  watchedPaths: readonly string[],
  existingStateIds: ReadonlySet<string>,
  limit = INITIAL_RELEASES_LIMIT,
): CommitStatePlan {
  const plan: CommitStatePlan = { unread: [], read: [], prune: [], matching: 0 };
  for (const commit of commits) {
    if (!commitMatchesAnyPath(commit.changedPaths, watchedPaths)) {
      if (existingStateIds.has(commit.id)) plan.prune.push(commit.id);
      continue;
    }
    const rank = plan.matching++;
    if (existingStateIds.has(commit.id)) continue;
    (rank < limit ? plan.unread : plan.read).push(commit.id);
  }
  return plan;
}

/** Applies {@link planCommitStates} for one user and repository inside a transaction. */
export async function syncCommitStates(
  tx: Prisma.TransactionClient,
  userId: string,
  repositoryId: string,
  watchedPaths: readonly string[],
): Promise<CommitStatePlan> {
  const [commits, states] = await Promise.all([
    tx.release.findMany({
      where: { repositoryId, source: "COMMIT" },
      orderBy: [{ publishedAt: "desc" }, { id: "desc" }],
      select: { id: true, changedPaths: true },
    }),
    tx.userReleaseState.findMany({
      where: { userId, release: { repositoryId, source: "COMMIT" } },
      select: { releaseId: true },
    }),
  ]);
  const plan = planCommitStates(commits, watchedPaths, new Set(states.map((s) => s.releaseId)));

  if (plan.prune.length > 0) {
    await tx.userReleaseState.deleteMany({ where: { userId, releaseId: { in: plan.prune } } });
  }
  const seed = [
    ...plan.unread.map((releaseId) => ({ userId, releaseId, isRead: false })),
    ...plan.read.map((releaseId) => ({ userId, releaseId, isRead: true })),
  ];
  if (seed.length > 0) await tx.userReleaseState.createMany({ data: seed, skipDuplicates: true });
  return plan;
}

/** Whether a poll must run to import commits of `watchedPaths` that were never polled. */
export function needsPathImport(
  watchedPaths: readonly string[],
  repository: { polledPaths: string[]; lastPathsPolledAt: Date | null },
): boolean {
  return repository.lastPathsPolledAt === null || watchedPaths.some((path) => !repository.polledPaths.includes(path));
}

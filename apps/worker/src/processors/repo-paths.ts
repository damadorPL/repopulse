import type { PrismaClient } from "@repopulse/db";
import {
  fetchCommitDetail,
  fetchCommitsForPath,
  GitHubRateLimitError,
  INITIAL_RELEASES_LIMIT,
  isGitHubHttpError,
  mapPathCommit,
  normalizeWatchedPath,
  type CommitDetail,
  type MappedPathCommit,
  type PathCommitSummary,
} from "@repopulse/github";
import { createLogger } from "../logger";
import { mergeFanOutPlans, planFanOut, type FanOutPlan, type StoredRelease } from "./fan-out";
import type { TokenCandidate } from "./github-tokens";
import { loadSubscribers, STORED_RELEASE_SELECT, type SubscriberWithMode } from "./repo-tags";

const log = createLogger("repo-paths");

const GITHUB_REQUEST_TIMEOUT_MS = 30_000;

export interface PathPollTarget {
  id: string;
  owner: string;
  name: string;
  fullName: string;
}

export interface PathStepCounts {
  /** Distinct watched paths polled. */
  paths: number;
  /** Distinct commits returned for them. */
  received: number;
  stored: number;
  /** Commits fanned out as new (unread, SSE, notification rules), counted once. */
  fresh: number;
  /** Commits of newly watched paths imported as history (unread or read, no notification rules), counted once. */
  imported: number;
}

export interface PathStepResult {
  counts: PathStepCounts;
  plan: FanOutPlan;
}

export interface PathStepDeps {
  prisma: PrismaClient;
  fetchCommits?: typeof fetchCommitsForPath;
  fetchDetail?: typeof fetchCommitDetail;
  now?: () => Date;
}

type PathSubscriber = SubscriberWithMode & { watchedPaths: string[] };

/** Whether a subscriber has "Files / folders" on with at least one watched path (whatever its release mode). */
export function tracksPaths(subscriber: SubscriberWithMode): boolean {
  return subscriber.trackPaths && subscriber.watchedPaths.length > 0;
}

/** Normalized, deduplicated watched paths (they are stored normalized; this guards old or hand-edited rows). */
function normalizedPaths(paths: readonly string[]): string[] {
  return [...new Set(paths.map(normalizeWatchedPath).filter((path): path is string => path !== null))];
}

function requestSignal(jobSignal: AbortSignal | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(GITHUB_REQUEST_TIMEOUT_MS);
  return jobSignal ? AbortSignal.any([jobSignal, timeout]) : timeout;
}

function newestFirst<T extends { publishedAt: Date }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime());
}

/** A commit returned by this poll, with the watched paths that returned it. */
interface PolledCommit {
  summary: PathCommitSummary;
  matchedBy: Set<string>;
}

/** A commit of this poll as stored in PostgreSQL. */
type StoredCommit = StoredRelease & { tagSha: string | null; changedPaths: string[] };

const STORED_COMMIT_SELECT = { ...STORED_RELEASE_SELECT, tagSha: true, changedPaths: true } as const;

/**
 * Per subscriber, which commits of this poll are new and which are the initial import of a newly
 * watched path. Pure, so it can be tested without a database.
 *
 * Only commits that one of the subscriber's own watched paths returned count (GitHub filtered
 * them by that path), so users watching different paths of one repository never see each other's
 * commits.
 *
 * - **Fresh**: inserted by this poll and returned by a path that was already polled before. That
 *   path's newest commits were all stored by the previous poll, so anything unknown is new on the
 *   default branch (also a merged branch whose commits carry older dates). These go through
 *   `planFanOut`: unread, SSE and notification rules, at most {@link INITIAL_RELEASES_LIMIT}.
 * - **Imported**: returned by a newly watched path (its first poll). The newest
 *   {@link INITIAL_RELEASES_LIMIT} become unread and the rest read, with SSE events but no
 *   notification rules: this is existing history, not news.
 */
export function planPathFanOut(params: {
  subscribers: PathSubscriber[];
  commits: Array<{ stored: StoredCommit; matchedBy: ReadonlySet<string> }>;
  createdIds: ReadonlySet<string>;
  newlyAdded: ReadonlySet<string>;
  limit?: number;
}): { plan: FanOutPlan; readStates: Array<{ userId: string; releaseId: string }>; freshIds: Set<string>; importedIds: Set<string> } {
  const { subscribers, commits, createdIds, newlyAdded, limit = INITIAL_RELEASES_LIMIT } = params;
  const plans: FanOutPlan[] = [];
  const readStates: Array<{ userId: string; releaseId: string }> = [];
  const freshIds = new Set<string>();
  const importedIds = new Set<string>();

  for (const subscriber of subscribers) {
    const watched = new Set(subscriber.watchedPaths);
    const fresh: StoredRelease[] = [];
    const imported: StoredRelease[] = [];
    for (const { stored, matchedBy } of commits) {
      const own = [...matchedBy].filter((path) => watched.has(path));
      if (own.length === 0) continue;
      if (createdIds.has(stored.id) && own.some((path) => !newlyAdded.has(path))) fresh.push(stored);
      else if (own.some((path) => newlyAdded.has(path))) imported.push(stored);
    }

    const freshPlan = planFanOut([subscriber], newestFirst(fresh), limit);
    for (const { releaseId } of freshPlan.states) freshIds.add(releaseId);
    plans.push(freshPlan);

    const sorted = newestFirst(imported);
    const unread = sorted.slice(0, limit);
    for (const release of sorted) importedIds.add(release.id);
    if (unread.length > 0) {
      plans.push({
        states: unread.map((release) => ({ userId: subscriber.userId, releaseId: release.id })),
        deliveries: [{ userId: subscriber.userId, releases: unread }],
        notifications: [],
      });
    }
    readStates.push(...sorted.slice(limit).map((release) => ({ userId: subscriber.userId, releaseId: release.id })));
  }
  return { plan: mergeFanOutPlans(...plans), readStates, freshIds, importedIds };
}

/** Tries each candidate token (anonymous last), moving on only on 401. Returns the index that worked. */
async function withTokenFallback<T>(
  candidates: TokenCandidate[],
  start: number,
  request: (token: string | undefined) => Promise<T>,
): Promise<{ value: T; index: number }> {
  for (let index = start; index < candidates.length; index++) {
    try {
      return { value: await request(candidates[index]!.token), index };
    } catch (error) {
      if (isGitHubHttpError(error) && error.status === 401 && index < candidates.length - 1) continue;
      throw error;
    }
  }
  throw new Error("no token candidates");
}

/**
 * The path step of a poll ("Files / folders", Slice 06). Collects the watched paths of every
 * subscriber with "Files / folders" on (deduplicated), reads the newest commits touching each one, stores the
 * unknown commits once each (with their changed files), then plans the per-subscriber fan-out
 * ({@link planPathFanOut}). Finally records the polled paths on the repository.
 *
 * Best effort: any failure (rate limit included) is logged and the step is skipped, so the next
 * poll retries. It never fails release polling or pauses the queue. Returns `null` when skipped.
 */
export async function pollRepoPaths(
  deps: PathStepDeps,
  repo: PathPollTarget,
  candidates: TokenCandidate[],
  jobSignal?: AbortSignal,
): Promise<PathStepResult | null> {
  const { prisma } = deps;
  const now = () => deps.now?.() ?? new Date();
  const fetchCommits = deps.fetchCommits ?? fetchCommitsForPath;
  const fetchDetail = deps.fetchDetail ?? fetchCommitDetail;
  try {
    const [repository, allSubscribers] = await Promise.all([
      prisma.repository.findUnique({ where: { id: repo.id }, select: { polledPaths: true } }),
      loadSubscribers(prisma, repo.id),
    ]);
    const subscribers: PathSubscriber[] = allSubscribers
      .filter(tracksPaths)
      .map((s) => ({ ...s, watchedPaths: normalizedPaths(s.watchedPaths) }))
      .filter((s) => s.watchedPaths.length > 0);
    if (!repository || subscribers.length === 0) return null;

    const paths = [...new Set(subscribers.flatMap((s) => s.watchedPaths))];
    const polledBefore = new Set(repository.polledPaths);
    const newlyAdded = new Set(paths.filter((path) => !polledBefore.has(path)));

    // 1. Newest commits per path; each commit once, with every path that returned it.
    const polled = new Map<string, PolledCommit>();
    let tokenIndex = 0;
    for (const path of paths) {
      const result = await withTokenFallback(candidates, tokenIndex, (accessToken) =>
        fetchCommits({ owner: repo.owner, name: repo.name, path, accessToken, signal: requestSignal(jobSignal) }),
      );
      tokenIndex = result.index;
      for (const summary of result.value) {
        const entry = polled.get(summary.sha) ?? { summary, matchedBy: new Set<string>() };
        entry.matchedBy.add(path);
        polled.set(summary.sha, entry);
      }
    }
    const token = candidates[tokenIndex]?.token;

    // 2. Which are stored already. Queried by short SHA too: it is the unique key, so a different
    // commit with the same short SHA (vanishingly rare) could never be inserted and is skipped.
    const shas = [...polled.keys()];
    const existing: StoredCommit[] =
      shas.length > 0
        ? await prisma.release.findMany({
            where: {
              repositoryId: repo.id,
              source: "COMMIT",
              OR: [{ tagSha: { in: shas } }, { tagName: { in: shas.map((sha) => sha.slice(0, 7)) } }],
            },
            select: STORED_COMMIT_SELECT,
          })
        : [];
    const storedBySha = new Map<string, StoredCommit>();
    for (const row of existing) if (row.tagSha && polled.has(row.tagSha)) storedBySha.set(row.tagSha, row);
    const takenShortShas = new Set(existing.map((row) => row.tagName));

    // 3. File details of the unknown commits, before the transaction (no connection held during
    // network I/O). A failed detail stores the commit without files; a rate limit skips the step.
    const rows: MappedPathCommit[] = [];
    for (const [sha, { summary, matchedBy }] of polled) {
      if (storedBySha.has(sha) || takenShortShas.has(sha.slice(0, 7))) continue;
      let detail: CommitDetail | null = null;
      try {
        detail = await fetchDetail({ owner: repo.owner, name: repo.name, ref: sha, accessToken: token, signal: requestSignal(jobSignal) });
      } catch (error) {
        if (error instanceof GitHubRateLimitError) throw error;
        log.warn(`${repo.fullName}: could not read the files of commit ${sha.slice(0, 7)}; storing it without them (${String(error)})`);
      }
      rows.push(mapPathCommit(summary, detail, [...matchedBy].sort()));
    }

    const result = await prisma.$transaction(async (tx) => {
      const created: StoredCommit[] =
        rows.length > 0
          ? await tx.release.createManyAndReturn({
              data: rows.map((row) => ({ ...row, repositoryId: repo.id })),
              // (repositoryId, source, tagName) is unique; a concurrent poll may insert the same commits.
              skipDuplicates: true,
              select: STORED_COMMIT_SELECT,
            })
          : [];
      for (const row of created) if (row.tagSha) storedBySha.set(row.tagSha, row);

      // A stored commit found through a path it does not list yet (a newly watched path, or its
      // file list was missing or truncated): record the path, so seeding on add matches it.
      for (const [sha, row] of storedBySha) {
        const matchedBy = polled.get(sha)?.matchedBy;
        if (!matchedBy) continue;
        const missing = [...matchedBy].filter((path) => !row.changedPaths.includes(path));
        if (missing.length === 0) continue;
        row.changedPaths = [...row.changedPaths, ...missing];
        await tx.release.update({ where: { id: row.id }, data: { changedPaths: row.changedPaths }, select: { id: true } });
      }

      const commits = [...polled].flatMap(([sha, { matchedBy }]) => {
        const stored = storedBySha.get(sha);
        return stored ? [{ stored, matchedBy }] : [];
      });
      const { plan, readStates, freshIds, importedIds } = planPathFanOut({
        subscribers,
        commits,
        createdIds: new Set(created.map((row) => row.id)),
        newlyAdded,
      });

      // Imported commits a user already has a state for (seeded on add, or read) keep it and are
      // not news. Fresh commits were inserted just now, so nobody has a state for them yet.
      const importedStates = plan.states.filter((state) => !freshIds.has(state.releaseId));
      const alreadyKnown =
        importedStates.length > 0
          ? await tx.userReleaseState.findMany({
              where: {
                userId: { in: [...new Set(importedStates.map((s) => s.userId))] },
                releaseId: { in: [...new Set(importedStates.map((s) => s.releaseId))] },
              },
              select: { userId: true, releaseId: true },
            })
          : [];
      const known = new Set(alreadyKnown.map((s) => `${s.userId}:${s.releaseId}`));
      const isNew = (state: { userId: string; releaseId: string }) => !known.has(`${state.userId}:${state.releaseId}`);
      const finalPlan: FanOutPlan = {
        states: plan.states.filter(isNew),
        deliveries: plan.deliveries
          .map(({ userId, releases }) => ({ userId, releases: releases.filter((release) => isNew({ userId, releaseId: release.id })) }))
          .filter((delivery) => delivery.releases.length > 0),
        notifications: plan.notifications,
      };

      const states = [
        ...finalPlan.states.map((state) => ({ ...state, isRead: false })),
        ...readStates.map((state) => ({ ...state, isRead: true })),
      ];
      if (states.length > 0) await tx.userReleaseState.createMany({ data: states, skipDuplicates: true });

      // Exactly the paths watched now: a path nobody watches any more is forgotten, so watching it
      // again later is a quiet initial import rather than a burst of notifications.
      await tx.repository.update({ where: { id: repo.id }, data: { lastPathsPolledAt: now(), polledPaths: paths } });

      return {
        counts: { paths: paths.length, received: polled.size, stored: created.length, fresh: freshIds.size, imported: importedIds.size },
        plan: finalPlan,
      };
    });

    log.info(
      `${repo.fullName}: ${result.counts.paths} watched path(s) (${newlyAdded.size} new), ${result.counts.received} commits received, ` +
        `${result.counts.stored} stored, ${result.counts.fresh} new, ${result.counts.imported} imported, ` +
        `fanned out to ${result.plan.deliveries.length} user(s)`,
    );
    return result;
  } catch (error) {
    log.error(`${repo.fullName}: path step skipped`, error);
    return null;
  }
}

import type { Prisma, PrismaClient, TrackMode } from "@repopulse/db";
import {
  buildTagChangelog,
  compareCommits,
  fetchRecentTags,
  isGitHubHttpError,
  mapTag,
  type CompareResult,
  type GitTag,
  type MappedTag,
} from "@repopulse/github";
import { createLogger } from "../logger";
import { EMPTY_FAN_OUT_PLAN, planFanOut, selectFreshReleases, type FanOutPlan, type FanOutSubscriber } from "./fan-out";
import type { TokenCandidate } from "./github-tokens";

const log = createLogger("repo-tags");

const GITHUB_REQUEST_TIMEOUT_MS = 30_000;

/** Columns the fan-out needs from a stored release or tag row. */
export const STORED_RELEASE_SELECT = {
  id: true,
  tagName: true,
  isPrerelease: true,
  semverType: true,
  publishedAt: true,
} satisfies Prisma.ReleaseSelect;

export type SubscriberWithMode = FanOutSubscriber & {
  trackMode: TrackMode;
  /** "Files / folders" is on (Slice 06), independently of `trackMode`. */
  trackPaths: boolean;
  /** Watched paths; only meaningful while `trackPaths` is on. */
  watchedPaths: string[];
};

type Tx = Prisma.TransactionClient | PrismaClient;

/** Every subscriber of a repository with what the fan-out needs, plus their tracking mode. */
export async function loadSubscribers(tx: Tx, repositoryId: string): Promise<SubscriberWithMode[]> {
  const subscriptions = await tx.userSubscription.findMany({
    where: { repositoryId },
    select: {
      userId: true,
      includePrereleases: true,
      trackMode: true,
      trackPaths: true,
      watchedPaths: true,
      notificationLevel: true,
      snoozedUntil: true,
      tags: { select: { tagId: true } },
      user: {
        select: {
          notificationRules: {
            where: { enabled: true },
            select: { id: true, tagId: true, channel: true, onlyMajorReleases: true, events: true },
          },
        },
      },
    },
  });
  return subscriptions.map((s) => ({
    userId: s.userId,
    includePrereleases: s.includePrereleases,
    trackMode: s.trackMode,
    trackPaths: s.trackPaths,
    watchedPaths: s.watchedPaths ?? [],
    notificationLevel: s.notificationLevel ?? "ALL",
    snoozedUntil: s.snoozedUntil ?? null,
    tagIds: s.tags.map((t) => t.tagId),
    rules: s.user.notificationRules,
  }));
}

export function tracksTags(subscriber: SubscriberWithMode): boolean {
  return subscriber.trackMode === "TAGS_AND_COMMITS";
}

/** GitHub Releases are shown in "Releases only" and "Releases + tags", not to a paths-only (`NONE`) subscription. */
export function tracksReleases(subscriber: SubscriberWithMode): boolean {
  return subscriber.trackMode !== "NONE";
}

export interface TagPollTarget {
  id: string;
  owner: string;
  name: string;
  fullName: string;
  htmlUrl: string;
}

export interface TagStepResult {
  received: number;
  stored: number;
  fresh: number;
  plan: FanOutPlan;
}

export interface TagStepDeps {
  prisma: PrismaClient;
  fetchTags?: typeof fetchRecentTags;
  compare?: typeof compareCommits;
  now?: () => Date;
}

function requestSignal(jobSignal: AbortSignal | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(GITHUB_REQUEST_TIMEOUT_MS);
  return jobSignal ? AbortSignal.any([jobSignal, timeout]) : timeout;
}

/** GraphQL needs a token: tries each subscriber token, moving on only on 401. */
async function fetchTagsWithFallback(
  deps: TagStepDeps,
  repo: TagPollTarget,
  candidates: TokenCandidate[],
  jobSignal: AbortSignal | undefined,
): Promise<{ tags: GitTag[]; token: string } | null> {
  const tokens = candidates.filter((c): c is TokenCandidate & { token: string } => Boolean(c.token));
  const fetchTags = deps.fetchTags ?? fetchRecentTags;
  for (const [index, candidate] of tokens.entries()) {
    try {
      const tags = await fetchTags({ owner: repo.owner, name: repo.name, accessToken: candidate.token, signal: requestSignal(jobSignal) });
      return { tags, token: candidate.token };
    } catch (error) {
      if (isGitHubHttpError(error) && error.status === 401 && index < tokens.length - 1) continue;
      throw error;
    }
  }
  return null;
}

/**
 * The tag step of a poll ("Releases + tags", Slice 04c). Reads the newest tags, stores those with
 * no row yet (neither a tag nor a GitHub Release of the same name) with "commits since the previous
 * tag" as changelog, and fans out the fresh ones (newer than every row stored before this poll)
 * to `TAGS_AND_COMMITS` subscribers only.
 *
 * Best effort: any failure is logged and the step is skipped (the next poll retries), so tags can
 * never break release polling or pause the queue. Returns `null` when skipped.
 */
export async function pollRepoTags(
  deps: TagStepDeps,
  repo: TagPollTarget,
  candidates: TokenCandidate[],
  newestKnownAt: Date | null,
  jobSignal?: AbortSignal,
): Promise<TagStepResult | null> {
  const { prisma } = deps;
  const now = () => deps.now?.() ?? new Date();
  try {
    const fetched = await fetchTagsWithFallback(deps, repo, candidates, jobSignal);
    if (!fetched) {
      log.warn(`${repo.fullName}: no subscriber token available; tags need an authenticated GraphQL request, skipping`);
      return null;
    }
    const { tags, token } = fetched;

    const existing =
      tags.length > 0
        ? await prisma.release.findMany({
            // Commit rows are keyed by short SHA and never shadow a tag.
            where: { repositoryId: repo.id, source: { in: ["RELEASE", "TAG"] }, tagName: { in: tags.map((t) => t.name) } },
            select: { tagName: true },
          })
        : [];
    const known = new Set(existing.map((r) => r.tagName));

    // Bodies before the transaction: no DB connection held during network I/O. `tags` is newest
    // first, so the previous tag of tags[i] is tags[i + 1].
    const compare = deps.compare ?? compareCommits;
    const rows: MappedTag[] = [];
    for (const [index, tag] of tags.entries()) {
      if (known.has(tag.name)) continue;
      const previous = tags[index + 1];
      let comparison: CompareResult | null = null;
      if (previous) {
        try {
          comparison = await compare({
            owner: repo.owner,
            name: repo.name,
            base: previous.name,
            head: tag.name,
            accessToken: token,
            signal: requestSignal(jobSignal),
          });
        } catch (error) {
          log.warn(`${repo.fullName}: could not compare ${previous.name}...${tag.name}; storing ${tag.name} without commits (${String(error)})`);
        }
      }
      rows.push(mapTag(tag, repo.htmlUrl, buildTagChangelog(tag, comparison)));
    }

    const result = await prisma.$transaction(async (tx) => {
      const created =
        rows.length > 0
          ? await tx.release.createManyAndReturn({
              data: rows.map((row) => ({ ...row, repositoryId: repo.id })),
              // (repositoryId, source, tagName) is unique; a concurrent poll may insert the same tags.
              skipDuplicates: true,
              select: STORED_RELEASE_SELECT,
            })
          : [];

      const fresh = selectFreshReleases(created, newestKnownAt);
      let plan = EMPTY_FAN_OUT_PLAN;
      if (fresh.length > 0) {
        const subscribers = (await loadSubscribers(tx, repo.id)).filter(tracksTags);
        plan = planFanOut(subscribers, fresh);
        if (plan.states.length > 0) {
          await tx.userReleaseState.createMany({
            data: plan.states.map((state) => ({ ...state, isRead: false })),
            skipDuplicates: true,
          });
        }
      }
      await tx.repository.update({ where: { id: repo.id }, data: { lastTagsPolledAt: now() } });
      return { received: tags.length, stored: created.length, fresh: fresh.length, plan };
    });

    log.info(
      `${repo.fullName}: ${result.received} tags received, ${result.stored} stored, ${result.fresh} new, ` +
        `fanned out to ${result.plan.deliveries.length} user(s)`,
    );
    return result;
  } catch (error) {
    log.error(`${repo.fullName}: tag step skipped`, error);
    return null;
  }
}

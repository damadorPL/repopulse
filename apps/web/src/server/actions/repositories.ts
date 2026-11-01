"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { prisma, type BackfillStatus, type TrackMode } from "@repopulse/db";
import { INITIAL_RELEASES_LIMIT, parseRepoInput, validateAndFetchRepo } from "@repopulse/github";
import { RELEASE_BACKFILL_PRIORITY } from "@repopulse/queue";
import { getCurrentUserOrThrow } from "@/lib/auth";
import { fail, getGitHubToken, invalidInput, toActionError, type ActionResult } from "@/server/action-result";
import { enqueueReleaseBackfill } from "@/server/backfill-queue";
import { needsPathImport, syncCommitStates } from "@/server/commit-states";
import { isRealtimeConfigured } from "@/server/realtime";
import { queueRepoImport } from "@/server/repo-poll-queue";
import { validateWatchedPaths } from "@/lib/watched-paths";

export type { ActionErrorCode, ActionResult } from "@/server/action-result";

export interface AddRepositoryResult {
  subscriptionId: string;
  repositoryId: string;
  fullName: string;
  /** GitHub Releases (and tags) visible to the subscription; matching stored commits in "Files / folders" mode. */
  releasesCount: number;
  /** A background poll was queued to import tags or the commits of never-polled watched paths. */
  importing: boolean;
}

const trackModeSchema = z.enum(["RELEASES", "TAGS_AND_COMMITS", "PATHS"]);
/** Raw entries; `validateWatchedPaths` normalizes and validates them. */
const watchedPathsSchema = z.array(z.string().max(1000)).max(50);

const addRepositoryInput = z.object({
  repoUrlOrSlug: z.string().trim().min(1, "Enter a repository").max(500),
  includePrereleases: z.boolean().default(false),
  /** `TAGS_AND_COMMITS`: also Git tags without a GitHub Release (Slice 04c). `PATHS`: commits touching `watchedPaths` (Slice 06). */
  trackMode: trackModeSchema.default("RELEASES"),
  watchedPaths: watchedPathsSchema.default([]),
  tagIds: z.array(z.string().min(1).max(64)).max(50).default([]),
});

const trackModeInput = z.object({
  subscriptionId: z.string().min(1).max(64),
  trackMode: trackModeSchema,
  /** Required in `PATHS` mode unless the subscription already has watched paths. */
  watchedPaths: watchedPathsSchema.optional(),
});

/** Release rows a subscription in "Releases only" or "Releases + tags" can see. */
function sourceFilter(trackMode: Exclude<TrackMode, "PATHS">) {
  return trackMode === "RELEASES" ? { source: "RELEASE" as const } : { source: { in: ["RELEASE" as const, "TAG" as const] } };
}

/**
 * Queues the background import of older releases. Best effort: the repository is already added,
 * and a repository left at `NONE` is picked up by the worker's scheduler sweep. `ERROR` is retried
 * here too, because an add is a natural moment to try again. History is shared, so a second user
 * adding a repository whose history is `DONE` queues nothing.
 */
async function queueHistoryBackfill(repositoryId: string, status: BackfillStatus): Promise<void> {
  if ((status !== "NONE" && status !== "ERROR") || !isRealtimeConfigured()) return;
  try {
    await enqueueReleaseBackfill({ repositoryId, trigger: "add" }, RELEASE_BACKFILL_PRIORITY.automatic);
    // Only from the state we saw: a job that already started has moved the row on.
    await prisma.repository.updateMany({
      where: { id: repositoryId, backfillStatus: status },
      data: { backfillStatus: "QUEUED" },
    });
  } catch (error) {
    console.warn(`[addRepositoryAction] could not queue the history backfill of ${repositoryId}`, error);
  }
}

const REPOSITORY_IMPORT_SELECT = {
  id: true,
  fullName: true,
  backfillStatus: true,
  lastTagsPolledAt: true,
  lastPathsPolledAt: true,
  polledPaths: true,
} as const;

interface RepositoryImportState {
  id: string;
  fullName: string;
  backfillStatus: BackfillStatus;
  lastTagsPolledAt: Date | null;
  lastPathsPolledAt: Date | null;
  polledPaths: string[];
}

/** Whether a priority poll should import tags (never read) or commits of never-polled watched paths. */
function needsImport(trackMode: TrackMode, watchedPaths: readonly string[], repository: RepositoryImportState): boolean {
  if (trackMode === "TAGS_AND_COMMITS") return repository.lastTagsPolledAt === null;
  if (trackMode === "PATHS") return needsPathImport(watchedPaths, repository);
  return false;
}

const removeSubscriptionInput = z.object({
  subscriptionId: z.string().min(1).max(64),
});

export async function addRepositoryAction(input: {
  repoUrlOrSlug: string;
  includePrereleases: boolean;
  trackMode?: TrackMode;
  /** "Files / folders" mode: repo-relative file or folder paths. */
  watchedPaths?: string[];
  tagIds: string[];
}): Promise<ActionResult<AddRepositoryResult>> {
  try {
    const user = await getCurrentUserOrThrow();

    const parsed = addRepositoryInput.safeParse(input);
    if (!parsed.success) {
      return invalidInput(parsed.error);
    }
    const { repoUrlOrSlug, includePrereleases, trackMode, tagIds } = parsed.data;
    let watchedPaths: string[] = [];
    if (trackMode === "PATHS") {
      const resolved = validateWatchedPaths(parsed.data.watchedPaths);
      if (!resolved.ok) return fail("INVALID_INPUT", resolved.message);
      watchedPaths = resolved.paths;
    }
    const { owner, name } = parseRepoInput(repoUrlOrSlug);

    // GitHub slugs are case-insensitive ("CoolLabsIO/Coolify" === "coollabsio/coolify").
    const existing = await prisma.repository.findFirst({
      where: { fullName: { equals: `${owner}/${name}`, mode: "insensitive" } },
      select: { ...REPOSITORY_IMPORT_SELECT, _count: { select: { releases: true } } },
    });

    // Fetch from GitHub before opening the transaction so no DB connection is held during network I/O.
    const fetched =
      !existing || existing._count.releases === 0
        ? await validateAndFetchRepo(owner, name, getGitHubToken(user, "addRepositoryAction"))
        : null;

    const { result, repository: imported } = await prisma.$transaction(async (tx) => {
      let repository: RepositoryImportState;

      if (fetched) {
        const { repository: repo, releases, etag } = fetched;
        const fields = {
          owner: repo.owner,
          name: repo.name,
          fullName: repo.fullName,
          description: repo.description,
          avatarUrl: repo.avatarUrl,
          htmlUrl: repo.htmlUrl,
          starsCount: repo.starsCount,
          lastEtag: etag,
          lastPolledAt: new Date(),
        };
        // Keyed by the immutable GitHub id so renames/transfers update the same row.
        repository = await tx.repository.upsert({
          where: { githubRepoId: repo.githubRepoId },
          create: { githubRepoId: repo.githubRepoId, ...fields },
          update: fields,
          select: REPOSITORY_IMPORT_SELECT,
        });
        if (releases.length > 0) {
          await tx.release.createMany({
            data: releases.map((release) => ({ ...release, repositoryId: repository.id })),
            skipDuplicates: true,
          });
        }
      } else {
        const { _count, ...state } = existing!;
        repository = state;
      }

      const subscription = await tx.userSubscription.upsert({
        where: { userId_repositoryId: { userId: user.id, repositoryId: repository.id } },
        create: { userId: user.id, repositoryId: repository.id, includePrereleases, trackMode, watchedPaths },
        // Watched paths are kept when re-adding in another mode, so switching back restores them.
        update: { includePrereleases, trackMode, ...(trackMode === "PATHS" ? { watchedPaths } : {}) },
        select: { id: true },
      });

      if (tagIds.length > 0) {
        // Only attach tags owned by this user.
        const ownedTags = await tx.tag.findMany({
          where: { id: { in: tagIds }, userId: user.id },
          select: { id: true },
        });
        if (ownedTags.length > 0) {
          await tx.subscriptionTag.createMany({
            data: ownedTags.map((tag) => ({ subscriptionId: subscription.id, tagId: tag.id })),
            skipDuplicates: true,
          });
        }
      }

      if (trackMode === "PATHS") {
        // "Files / folders": commits other subscribers' polls already stored for these paths.
        const commits = await syncCommitStates(tx, user.id, repository.id, watchedPaths);
        return {
          result: {
            subscriptionId: subscription.id,
            repositoryId: repository.id,
            fullName: repository.fullName,
            releasesCount: commits.matching,
            importing: false,
          },
          repository,
        };
      }

      // Seed the feed with the latest releases (unread), honoring includePrereleases
      // the same way the worker does for newly discovered releases.
      const latestReleases = await tx.release.findMany({
        where: {
          repositoryId: repository.id,
          isDraft: false,
          ...(includePrereleases ? {} : { isPrerelease: false }),
          ...sourceFilter(trackMode),
        },
        orderBy: { publishedAt: "desc" },
        take: INITIAL_RELEASES_LIMIT,
        select: { id: true },
      });
      if (latestReleases.length > 0) {
        await tx.userReleaseState.createMany({
          data: latestReleases.map((release) => ({ userId: user.id, releaseId: release.id })),
          skipDuplicates: true,
        });
      }

      const releasesCount = await tx.release.count({ where: { repositoryId: repository.id, ...sourceFilter(trackMode) } });

      return {
        result: {
          subscriptionId: subscription.id,
          repositoryId: repository.id,
          fullName: repository.fullName,
          releasesCount,
          importing: false,
        },
        repository,
      };
    });

    // After the commit, so the worker never runs against a repository that is not there yet.
    await queueHistoryBackfill(result.repositoryId, imported.backfillStatus);
    // Tags never read, or watched paths never polled: import them now instead of at the next scheduled poll.
    const importing = needsImport(trackMode, watchedPaths, imported);
    if (importing) await queueRepoImport(result.repositoryId, "addRepositoryAction");

    revalidatePath("/", "layout");
    return { ok: true, data: { ...result, importing } };
  } catch (error) {
    return toActionError(error, "addRepositoryAction");
  }
}

/**
 * Switches a subscription between "Releases only", "Releases + tags" and "Files / folders", or
 * changes its watched paths. Rows are shown or hidden at query time and read state is kept, except
 * that commit states follow the watched paths (states of commits that no longer match are dropped,
 * matching stored commits get one). Tags never read, or watched paths never polled, queue an import.
 */
export async function updateTrackModeAction(input: {
  subscriptionId: string;
  trackMode: TrackMode;
  watchedPaths?: string[];
}): Promise<ActionResult<{ subscriptionId: string; trackMode: TrackMode; watchedPaths: string[]; importing: boolean }>> {
  try {
    const user = await getCurrentUserOrThrow();
    const parsed = trackModeInput.safeParse(input);
    if (!parsed.success) return invalidInput(parsed.error);
    const { subscriptionId, trackMode } = parsed.data;

    const subscription = await prisma.userSubscription.findFirst({
      where: { id: subscriptionId, userId: user.id },
      select: { id: true, repositoryId: true, watchedPaths: true, repository: { select: REPOSITORY_IMPORT_SELECT } },
    });
    if (!subscription) return fail("NOT_FOUND", "Subscription not found.");

    let watchedPaths = subscription.watchedPaths;
    if (trackMode === "PATHS") {
      const resolved = validateWatchedPaths(parsed.data.watchedPaths ?? subscription.watchedPaths);
      if (!resolved.ok) return fail("INVALID_INPUT", resolved.message);
      watchedPaths = resolved.paths;
    }

    await prisma.$transaction(async (tx) => {
      await tx.userSubscription.update({
        where: { id: subscription.id },
        data: { trackMode, ...(trackMode === "PATHS" ? { watchedPaths } : {}) },
      });
      if (trackMode === "PATHS") await syncCommitStates(tx, user.id, subscription.repositoryId, watchedPaths);
    });

    const importing = needsImport(trackMode, watchedPaths, subscription.repository);
    if (importing) await queueRepoImport(subscription.repositoryId, "updateTrackModeAction");

    revalidatePath("/", "layout");
    return { ok: true, data: { subscriptionId: subscription.id, trackMode, watchedPaths, importing } };
  } catch (error) {
    return toActionError(error, "updateTrackModeAction");
  }
}

export async function removeSubscriptionAction(input: {
  subscriptionId: string;
}): Promise<ActionResult<{ subscriptionId: string }>> {
  try {
    const user = await getCurrentUserOrThrow();

    const parsed = removeSubscriptionInput.safeParse(input);
    if (!parsed.success) {
      return invalidInput(parsed.error);
    }
    const { subscriptionId } = parsed.data;

    const subscription = await prisma.userSubscription.findFirst({
      where: { id: subscriptionId, userId: user.id },
      select: { id: true, repositoryId: true },
    });
    if (!subscription) {
      return fail("NOT_FOUND", "Subscription not found.");
    }

    // The shared Repository/Release rows stay (other users may follow them); only this
    // user's subscription (+ its tag links via cascade) and read states are removed.
    await prisma.$transaction([
      prisma.userReleaseState.deleteMany({
        where: { userId: user.id, release: { repositoryId: subscription.repositoryId } },
      }),
      prisma.userSubscription.delete({ where: { id: subscription.id } }),
    ]);

    revalidatePath("/", "layout");
    return { ok: true, data: { subscriptionId: subscription.id } };
  } catch (error) {
    return toActionError(error, "removeSubscriptionAction");
  }
}

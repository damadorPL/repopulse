"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { prisma, type BackfillStatus, type TrackMode } from "@repopulse/db";
import { INITIAL_RELEASES_LIMIT, parseRepoInput, validateAndFetchRepo } from "@repopulse/github";
import { RELEASE_BACKFILL_PRIORITY } from "@repopulse/queue";
import { getCurrentUserOrThrow } from "@/lib/auth";
import { fail, getGitHubToken, invalidInput, toActionError, type ActionResult } from "@/server/action-result";
import { enqueueReleaseBackfill } from "@/server/backfill-queue";
import { isRealtimeConfigured } from "@/server/realtime";
import { queueTagImport } from "@/server/repo-poll-queue";

export type { ActionErrorCode, ActionResult } from "@/server/action-result";

export interface AddRepositoryResult {
  subscriptionId: string;
  repositoryId: string;
  fullName: string;
  releasesCount: number;
}

const trackModeSchema = z.enum(["RELEASES", "TAGS_AND_COMMITS"]);

const addRepositoryInput = z.object({
  repoUrlOrSlug: z.string().trim().min(1, "Enter a repository").max(500),
  includePrereleases: z.boolean().default(false),
  /** `TAGS_AND_COMMITS`: also Git tags without a GitHub Release (Slice 04c). */
  trackMode: trackModeSchema.default("RELEASES"),
  tagIds: z.array(z.string().min(1).max(64)).max(50).default([]),
});

const trackModeInput = z.object({ subscriptionId: z.string().min(1).max(64), trackMode: trackModeSchema });

/** Rows a subscription in `trackMode` can see (tag rows only for "Releases + tags"). */
function sourceFilter(trackMode: TrackMode) {
  return trackMode === "RELEASES" ? { source: "RELEASE" as const } : {};
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

const removeSubscriptionInput = z.object({
  subscriptionId: z.string().min(1).max(64),
});

export async function addRepositoryAction(input: {
  repoUrlOrSlug: string;
  includePrereleases: boolean;
  trackMode?: TrackMode;
  tagIds: string[];
}): Promise<ActionResult<AddRepositoryResult>> {
  try {
    const user = await getCurrentUserOrThrow();

    const parsed = addRepositoryInput.safeParse(input);
    if (!parsed.success) {
      return invalidInput(parsed.error);
    }
    const { repoUrlOrSlug, includePrereleases, trackMode, tagIds } = parsed.data;
    const { owner, name } = parseRepoInput(repoUrlOrSlug);

    // GitHub slugs are case-insensitive ("CoolLabsIO/Coolify" === "coollabsio/coolify").
    const existing = await prisma.repository.findFirst({
      where: { fullName: { equals: `${owner}/${name}`, mode: "insensitive" } },
      select: { id: true, fullName: true, backfillStatus: true, lastTagsPolledAt: true, _count: { select: { releases: true } } },
    });

    // Fetch from GitHub before opening the transaction so no DB connection is held during network I/O.
    const fetched =
      !existing || existing._count.releases === 0
        ? await validateAndFetchRepo(owner, name, getGitHubToken(user, "addRepositoryAction"))
        : null;

    const { result, backfillStatus, lastTagsPolledAt } = await prisma.$transaction(async (tx) => {
      let repository: { id: string; fullName: string; backfillStatus: BackfillStatus; lastTagsPolledAt: Date | null };

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
          select: { id: true, fullName: true, backfillStatus: true, lastTagsPolledAt: true },
        });
        if (releases.length > 0) {
          await tx.release.createMany({
            data: releases.map((release) => ({ ...release, repositoryId: repository.id })),
            skipDuplicates: true,
          });
        }
      } else {
        repository = {
          id: existing!.id,
          fullName: existing!.fullName,
          backfillStatus: existing!.backfillStatus,
          lastTagsPolledAt: existing!.lastTagsPolledAt,
        };
      }

      const subscription = await tx.userSubscription.upsert({
        where: { userId_repositoryId: { userId: user.id, repositoryId: repository.id } },
        create: { userId: user.id, repositoryId: repository.id, includePrereleases, trackMode },
        update: { includePrereleases, trackMode },
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
        },
        backfillStatus: repository.backfillStatus,
        lastTagsPolledAt: repository.lastTagsPolledAt,
      };
    });

    // After the commit, so the worker never runs against a repository that is not there yet.
    await queueHistoryBackfill(result.repositoryId, backfillStatus);
    // Tags were never read for this repository: import them now instead of at the next scheduled poll.
    if (trackMode === "TAGS_AND_COMMITS" && lastTagsPolledAt === null) await queueTagImport(result.repositoryId, "addRepositoryAction");

    revalidatePath("/", "layout");
    return { ok: true, data: result };
  } catch (error) {
    return toActionError(error, "addRepositoryAction");
  }
}

/**
 * Switches a subscription between "Releases only" and "Releases + tags". Tag rows are shown or
 * hidden at query time; their read state is kept. The first switch to tags on a repository whose
 * tags were never read queues an import.
 */
export async function updateTrackModeAction(input: {
  subscriptionId: string;
  trackMode: TrackMode;
}): Promise<ActionResult<{ subscriptionId: string; trackMode: TrackMode; importing: boolean }>> {
  try {
    const user = await getCurrentUserOrThrow();
    const parsed = trackModeInput.safeParse(input);
    if (!parsed.success) return invalidInput(parsed.error);
    const { subscriptionId, trackMode } = parsed.data;

    const subscription = await prisma.userSubscription.findFirst({
      where: { id: subscriptionId, userId: user.id },
      select: { id: true, repositoryId: true, repository: { select: { lastTagsPolledAt: true } } },
    });
    if (!subscription) return fail("NOT_FOUND", "Subscription not found.");

    await prisma.userSubscription.update({ where: { id: subscription.id }, data: { trackMode } });

    const importing = trackMode === "TAGS_AND_COMMITS" && subscription.repository.lastTagsPolledAt === null;
    if (importing) await queueTagImport(subscription.repositoryId, "updateTrackModeAction");

    revalidatePath("/", "layout");
    return { ok: true, data: { subscriptionId: subscription.id, trackMode, importing } };
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

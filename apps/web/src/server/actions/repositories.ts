"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { prisma, type BackfillStatus, type NotificationLevel, type TrackMode } from "@repopulse/db";
import { fetchRepoTree, INITIAL_RELEASES_LIMIT, parseRepoInput, validateAndFetchRepo, type RepoTree } from "@repopulse/github";
import { RELEASE_BACKFILL_PRIORITY } from "@repopulse/queue";
import { getCurrentUserOrThrow } from "@/lib/auth";
import { fail, getGitHubToken, invalidInput, ok, toActionError, type ActionResult } from "@/server/action-result";
import { enqueueReleaseBackfill } from "@/server/backfill-queue";
import { needsPathImport, syncCommitStates } from "@/server/commit-states";
import { isRealtimeConfigured } from "@/server/realtime";
import { queueRepoImport } from "@/server/repo-poll-queue";
import { subscriptionSettingsInput, validateSnooze, type SubscriptionSettingsInput } from "@/lib/subscription-settings";
import { NOTHING_TRACKED_MESSAGE, tracksSomething } from "@/lib/track-modes";
import { validateWatchedPaths } from "@/lib/watched-paths";

export type { ActionErrorCode, ActionResult } from "@/server/action-result";

export interface AddRepositoryResult {
  subscriptionId: string;
  repositoryId: string;
  fullName: string;
  /** GitHub Releases (and tags) visible to the subscription; 0 when it tracks no releases. */
  releasesCount: number;
  /** Stored commits matching the watched paths; 0 when "Files / folders" is off. */
  commitsCount: number;
  /** A background poll was queued to import tags never read. */
  importingTags: boolean;
  /** A background poll was queued to import commits of never-polled watched paths. */
  importingPaths: boolean;
}

export interface UpdateTrackingResult {
  subscriptionId: string;
  trackMode: TrackMode;
  trackPaths: boolean;
  watchedPaths: string[];
  importingTags: boolean;
  importingPaths: boolean;
}

/** Per-subscription settings after `updateSubscriptionSettingsAction` (Slice 07). */
export interface SubscriptionSettings {
  subscriptionId: string;
  includePrereleases: boolean;
  isPinned: boolean;
  note: string | null;
  notificationLevel: NotificationLevel;
  snoozedUntil: Date | null;
  currentVersion: string | null;
}

const trackModeSchema = z.enum(["RELEASES", "TAGS_AND_COMMITS", "NONE"]);
/** Raw entries; `validateWatchedPaths` normalizes and validates them. */
const watchedPathsSchema = z.array(z.string().max(1000)).max(50);

const addRepositoryInput = z.object({
  repoUrlOrSlug: z.string().trim().min(1, "Enter a repository").max(500),
  includePrereleases: z.boolean().default(false),
  /** `TAGS_AND_COMMITS`: also Git tags without a GitHub Release (Slice 04c). `NONE`: no releases at all. */
  trackMode: trackModeSchema.default("RELEASES"),
  /** "Files / folders" (Slice 06): also commits touching `watchedPaths`. */
  trackPaths: z.boolean().default(false),
  watchedPaths: watchedPathsSchema.default([]),
  tagIds: z.array(z.string().min(1).max(64)).max(50).default([]),
});

const trackModeInput = z.object({
  subscriptionId: z.string().min(1).max(64),
  trackMode: trackModeSchema,
  trackPaths: z.boolean(),
  /** Required with `trackPaths` unless the subscription already has watched paths. */
  watchedPaths: watchedPathsSchema.optional(),
});

/** Release rows a subscription in "Releases only" or "Releases + tags" can see. */
function sourceFilter(trackMode: Exclude<TrackMode, "NONE">) {
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

/** What a priority poll should import now: tags never read, and/or commits of never-polled watched paths. */
function pendingImports(
  trackMode: TrackMode,
  trackPaths: boolean,
  watchedPaths: readonly string[],
  repository: RepositoryImportState,
): { importingTags: boolean; importingPaths: boolean } {
  return {
    importingTags: trackMode === "TAGS_AND_COMMITS" && repository.lastTagsPolledAt === null,
    importingPaths: trackPaths && needsPathImport(watchedPaths, repository),
  };
}

const removeSubscriptionInput = z.object({
  subscriptionId: z.string().min(1).max(64),
});

export async function addRepositoryAction(input: {
  repoUrlOrSlug: string;
  includePrereleases: boolean;
  trackMode?: TrackMode;
  /** "Files / folders": also track commits touching `watchedPaths`. */
  trackPaths?: boolean;
  /** Repo-relative file or folder paths, with `trackPaths`. */
  watchedPaths?: string[];
  tagIds: string[];
}): Promise<ActionResult<AddRepositoryResult>> {
  try {
    const user = await getCurrentUserOrThrow();

    const parsed = addRepositoryInput.safeParse(input);
    if (!parsed.success) {
      return invalidInput(parsed.error);
    }
    const { repoUrlOrSlug, includePrereleases, trackMode, trackPaths, tagIds } = parsed.data;
    if (!tracksSomething(trackMode, trackPaths)) return fail("INVALID_INPUT", NOTHING_TRACKED_MESSAGE);
    let watchedPaths: string[] = [];
    if (trackPaths) {
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
        create: { userId: user.id, repositoryId: repository.id, includePrereleases, trackMode, trackPaths, watchedPaths },
        // Watched paths are kept when re-adding without "Files / folders", so turning it back on restores them.
        update: { includePrereleases, trackMode, trackPaths, ...(trackPaths ? { watchedPaths } : {}) },
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

      // "Files / folders": commits other subscribers' polls already stored for these paths.
      const commitsCount = trackPaths ? (await syncCommitStates(tx, user.id, repository.id, watchedPaths)).matching : 0;

      let releasesCount = 0;
      if (trackMode !== "NONE") {
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
        releasesCount = await tx.release.count({ where: { repositoryId: repository.id, ...sourceFilter(trackMode) } });
      }

      return {
        result: {
          subscriptionId: subscription.id,
          repositoryId: repository.id,
          fullName: repository.fullName,
          releasesCount,
          commitsCount,
        },
        repository,
      };
    });

    // After the commit, so the worker never runs against a repository that is not there yet.
    await queueHistoryBackfill(result.repositoryId, imported.backfillStatus);
    // Tags never read, or watched paths never polled: import them now instead of at the next scheduled poll.
    const imports = pendingImports(trackMode, trackPaths, watchedPaths, imported);
    if (imports.importingTags || imports.importingPaths) await queueRepoImport(result.repositoryId, "addRepositoryAction");

    revalidatePath("/", "layout");
    return { ok: true, data: { ...result, ...imports } };
  } catch (error) {
    return toActionError(error, "addRepositoryAction");
  }
}

/**
 * Changes what a subscription tracks: its release mode ("Releases only", "Releases + tags" or none)
 * and, independently, "Files / folders" with its watched paths. At least one must stay on. Rows are
 * shown or hidden at query time and read state is kept, except that commit states follow the watched
 * paths while "Files / folders" is on (states of commits that no longer match are dropped, matching
 * stored commits get one). Tags never read, or watched paths never polled, queue an import.
 */
export async function updateTrackModeAction(input: {
  subscriptionId: string;
  trackMode: TrackMode;
  trackPaths: boolean;
  watchedPaths?: string[];
}): Promise<ActionResult<UpdateTrackingResult>> {
  try {
    const user = await getCurrentUserOrThrow();
    const parsed = trackModeInput.safeParse(input);
    if (!parsed.success) return invalidInput(parsed.error);
    const { subscriptionId, trackMode, trackPaths } = parsed.data;
    if (!tracksSomething(trackMode, trackPaths)) return fail("INVALID_INPUT", NOTHING_TRACKED_MESSAGE);

    const subscription = await prisma.userSubscription.findFirst({
      where: { id: subscriptionId, userId: user.id },
      select: { id: true, repositoryId: true, watchedPaths: true, repository: { select: REPOSITORY_IMPORT_SELECT } },
    });
    if (!subscription) return fail("NOT_FOUND", "Subscription not found.");

    let watchedPaths = subscription.watchedPaths;
    if (trackPaths) {
      const resolved = validateWatchedPaths(parsed.data.watchedPaths ?? subscription.watchedPaths);
      if (!resolved.ok) return fail("INVALID_INPUT", resolved.message);
      watchedPaths = resolved.paths;
    }

    await prisma.$transaction(async (tx) => {
      await tx.userSubscription.update({
        where: { id: subscription.id },
        data: { trackMode, trackPaths, ...(trackPaths ? { watchedPaths } : {}) },
      });
      if (trackPaths) await syncCommitStates(tx, user.id, subscription.repositoryId, watchedPaths);
    });

    const imports = pendingImports(trackMode, trackPaths, watchedPaths, subscription.repository);
    if (imports.importingTags || imports.importingPaths) await queueRepoImport(subscription.repositoryId, "updateTrackModeAction");

    revalidatePath("/", "layout");
    return { ok: true, data: { subscriptionId: subscription.id, trackMode, trackPaths, watchedPaths, ...imports } };
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

const listRepositoryPathsInput = z.object({
  repoUrlOrSlug: z.string().trim().min(1, "Enter a repository").max(500),
});

/**
 * Files and folders on the default branch of a repository, for the "Files / folders" path picker
 * (autocomplete and browser). Uses the user's GitHub token, so private repositories they can read
 * work too. Read only, nothing is stored. Very large trees are capped (`REPO_TREE_MAX_ENTRIES`,
 * folders first) and flagged `truncated`; any path can still be typed by hand.
 */
export async function listRepositoryPathsAction(input: { repoUrlOrSlug: string }): Promise<ActionResult<RepoTree>> {
  try {
    const user = await getCurrentUserOrThrow();
    const parsed = listRepositoryPathsInput.safeParse(input);
    if (!parsed.success) return invalidInput(parsed.error);
    const { owner, name } = parseRepoInput(parsed.data.repoUrlOrSlug);
    const tree = await fetchRepoTree({
      owner,
      name,
      accessToken: getGitHubToken(user, "listRepositoryPathsAction"),
      signal: AbortSignal.timeout(15_000),
    });
    return ok(tree);
  } catch (error) {
    return toActionError(error, "listRepositoryPathsAction");
  }
}

/**
 * Updates the per-subscription settings of the repository settings page (Slice 07): include
 * pre-releases, pin, note, notification level, snooze and "my version". Every field is optional;
 * only the ones sent change.
 *
 * Pre-releases follow `addRepositoryAction`: turning them on gives the stored pre-releases among the
 * {@link INITIAL_RELEASES_LIMIT} newest visible items an unread state; turning them off deletes the
 * user's unread states of pre-release rows, so the unread counter drops at once. Read states are
 * kept (harmless: hidden rows are filtered by `visibleReleasesWhere`).
 */
export async function updateSubscriptionSettingsAction(input: SubscriptionSettingsInput): Promise<ActionResult<SubscriptionSettings>> {
  try {
    const user = await getCurrentUserOrThrow();
    const parsed = subscriptionSettingsInput.safeParse(input);
    if (!parsed.success) return invalidInput(parsed.error);
    const { subscriptionId, includePrereleases, isPinned, note, notificationLevel, snoozedUntil, currentVersion } = parsed.data;
    if (snoozedUntil) {
      const message = validateSnooze(snoozedUntil);
      if (message) return fail("INVALID_INPUT", message);
    }

    const subscription = await prisma.userSubscription.findFirst({
      where: { id: subscriptionId, userId: user.id },
      select: { id: true, repositoryId: true, trackMode: true, includePrereleases: true },
    });
    if (!subscription) return fail("NOT_FOUND", "Subscription not found.");

    const updated = await prisma.$transaction(async (tx) => {
      const row = await tx.userSubscription.update({
        where: { id: subscription.id },
        data: {
          ...(includePrereleases !== undefined ? { includePrereleases } : {}),
          ...(isPinned !== undefined ? { isPinned } : {}),
          ...(note !== undefined ? { note } : {}),
          ...(notificationLevel !== undefined ? { notificationLevel } : {}),
          ...(snoozedUntil !== undefined ? { snoozedUntil } : {}),
          ...(currentVersion !== undefined ? { currentVersion } : {}),
        },
        select: {
          id: true,
          includePrereleases: true,
          isPinned: true,
          note: true,
          notificationLevel: true,
          snoozedUntil: true,
          currentVersion: true,
        },
      });

      const prereleasesChanged = includePrereleases !== undefined && includePrereleases !== subscription.includePrereleases;
      if (prereleasesChanged && subscription.trackMode !== "NONE") {
        if (includePrereleases) {
          const newest = await tx.release.findMany({
            where: { repositoryId: subscription.repositoryId, isDraft: false, ...sourceFilter(subscription.trackMode) },
            orderBy: [{ publishedAt: "desc" }, { id: "desc" }],
            take: INITIAL_RELEASES_LIMIT,
            select: { id: true, isPrerelease: true },
          });
          const prereleases = newest.filter((release) => release.isPrerelease);
          if (prereleases.length > 0) {
            await tx.userReleaseState.createMany({
              data: prereleases.map((release) => ({ userId: user.id, releaseId: release.id })),
              skipDuplicates: true,
            });
          }
        } else {
          await tx.userReleaseState.deleteMany({
            where: {
              userId: user.id,
              isRead: false,
              release: { repositoryId: subscription.repositoryId, isPrerelease: true, source: { in: ["RELEASE", "TAG"] } },
            },
          });
        }
      }
      return row;
    });

    revalidatePath("/repositories");
    revalidatePath("/repositories/[owner]/[name]", "page");
    // The feed, the reader and the sidebar / navbar unread counters.
    revalidatePath("/", "layout");
    const { id, ...settings } = updated;
    return ok({ subscriptionId: id, ...settings });
  } catch (error) {
    return toActionError(error, "updateSubscriptionSettingsAction");
  }
}
